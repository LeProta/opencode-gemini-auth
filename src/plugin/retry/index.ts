import {
  canRetryRequest,
  computeGeminiRetryDecision,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_RETRY_DELAY_MS,
  getExponentialDelayWithJitter,
  getMaxRetryDelayMs,
  isRetryableNetworkError,
  isRetryableStatus,
  MODEL_CAPACITY_COOLDOWN_MS,
  resolveRetryDelayMs,
  sleepUnlessAborted,
  type GeminiRetryDecision,
} from "./helpers";
import { classifyQuotaResponse, retryInternals, type QuotaContext } from "./quota";
import { isGeminiDebugEnabled, logGeminiDebugMessage } from "../debug";
import { geminiFetch } from "../../fetch";

const retryCooldownByKey = new Map<string, number>();
const RETRY_IN_FLIGHT_LOG_INTERVAL_MS = 5000;

/**
 * Sends requests with retry/backoff semantics aligned to Gemini CLI:
 * - Retries on 429/5xx and transient network failures
 * - Honors Retry-After and google.rpc.RetryInfo
 * - Respects AbortSignal and OPENCODE_GEMINI_MAX_RETRY_MS
 * - Never rewrites requested model
 */
export async function fetchWithRetry(
  input: RequestInfo,
  init: RequestInit | undefined,
): Promise<Response> {
  if (!canRetryRequest(init)) {
    return geminiFetch(input, init);
  }

  const retryInit = cloneRetryableInit(init, input);
  const throttleKey = buildRetryThrottleKey(input, retryInit);
  await waitForRetryCooldown(throttleKey, retryInit.signal);
  throwIfAborted(retryInit.signal);

  let attempt = 1;
  const url = readRequestUrl(input);

  while (attempt <= DEFAULT_MAX_ATTEMPTS) {
    let response: Response;
    const stopInFlightLog = startInFlightLog(attempt, url);
    try {
      debugRetry(`attempt ${attempt}/${DEFAULT_MAX_ATTEMPTS} -> ${url}`);
      response = await geminiFetch(input, retryInit);
    } catch (error) {
      stopInFlightLog();
      if (attempt >= DEFAULT_MAX_ATTEMPTS || !isRetryableNetworkError(error)) {
        debugRetry(
          `attempt ${attempt} network error is non-retryable or maxed: ${formatErrorSummary(error)}`,
        );
        throw error;
      }
      if (retryInit.signal?.aborted) {
        debugRetry(`attempt ${attempt} aborted before retry`);
        throw error;
      }

      const delayMs = getExponentialDelayWithJitter(attempt);
      if (delayMs > getMaxRetryDelayMs()) {
        debugRetry(
          `attempt ${attempt} network delay ${delayMs}ms exceeds max retry delay, failing fast`,
        );
        throw error;
      }

      debugRetry(
        `attempt ${attempt} network retry scheduled in ${delayMs}ms (${formatErrorSummary(error)})`,
      );
      await sleepUnlessAborted(delayMs, retryInit.signal);
      if (retryInit.signal?.aborted) {
        throw error;
      }
      attempt += 1;
      continue;
    }
    stopInFlightLog();

    if (!isRetryableStatus(response.status)) {
      debugRetry(`attempt ${attempt} success or non-retryable status: ${response.status}`);
      return response;
    }

    const quotaContext = response.status === 429 ? await classifyQuotaResponse(response) : null;
    const decision = await computeGeminiRetryDecision(response, attempt, quotaContext, {
      signal: retryInit.signal,
    });

    if (decision.cooldownMs !== undefined && decision.cooldownMs > 0) {
      const boundedCooldownMs = Math.min(
        decision.cooldownMs,
        Math.max(getMaxRetryDelayMs(), MODEL_CAPACITY_COOLDOWN_MS),
      );
      recordRetryCooldown(throttleKey, boundedCooldownMs);
    }

    if (!decision.shouldRetry) {
      if (decision.reason === "terminal_quota") {
        debugRetry(
          `attempt ${attempt} terminal 429 (${quotaContext?.reason ?? "unknown"}), returning without retry`,
        );
      } else if (decision.reason === "retry_delay_exceeds_max") {
        debugRetry(
          `attempt ${attempt} retry delay ${decision.delayMs}ms exceeds max, returning without retry`,
        );
      } else {
        debugRetry(
          `attempt ${attempt} reached retry boundary (${decision.reason}, status=${response.status})`,
        );
      }
      return response;
    }

    debugRetry(
      `attempt ${attempt} retrying status=${response.status} reason=${quotaContext?.reason ?? "n/a"} delay=${decision.delayMs}ms`,
    );
    await cancelResponseBody(response);

    if (decision.delayMs > 0) {
      await sleepUnlessAborted(decision.delayMs, retryInit.signal);
      if (retryInit.signal?.aborted) {
        return response;
      }
    }
    attempt += 1;
  }

  return geminiFetch(input, retryInit);
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (!signal?.aborted) {
    return;
  }
  if (typeof signal.throwIfAborted === "function") {
    signal.throwIfAborted();
  }
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (!response.body) {
    return;
  }
  try {
    await response.body.cancel();
  } catch {}
}

function cloneRetryableInit(init: RequestInit | undefined, input?: RequestInfo): RequestInit {
  if (!init) {
    return input instanceof Request ? { headers: new Headers(input.headers) } : {};
  }
  return {
    ...init,
    headers: new Headers(
      init.headers !== undefined
        ? init.headers
        : input instanceof Request
          ? input.headers
          : undefined,
    ),
  };
}

export function buildRetryThrottleKey(input: RequestInfo, init?: RequestInit): string {
  const url = readRequestUrl(input);
  const body = typeof init?.body === "string" ? safeParseBody(init.body) : null;
  const project = readString(body?.project);
  const model = readString(body?.model);
  return `${url}|${project ?? ""}|${model ?? ""}`;
}

function pruneExpiredCooldowns(now = Date.now()): void {
  for (const [key, until] of retryCooldownByKey.entries()) {
    if (until <= now) {
      retryCooldownByKey.delete(key);
    }
  }
}

export function getRetryCooldownRemainingMs(key: string): number {
  const until = retryCooldownByKey.get(key);
  if (!until) {
    return 0;
  }
  const remaining = until - Date.now();
  if (remaining <= 0) {
    if (retryCooldownByKey.get(key) === until) {
      retryCooldownByKey.delete(key);
    }
    return 0;
  }
  return remaining;
}

export async function waitForRetryCooldown(
  key: string,
  signal?: AbortSignal | null,
): Promise<void> {
  const until = retryCooldownByKey.get(key);
  if (!until) {
    return;
  }

  const remaining = until - Date.now();
  if (remaining <= 0) {
    if (retryCooldownByKey.get(key) === until) {
      retryCooldownByKey.delete(key);
    }
    return;
  }
  if (signal?.aborted) {
    debugRetry(`cooldown skipped due to abort (key=${shortKey(key)})`);
    return;
  }

  debugRetry(`cooldown wait ${remaining}ms (key=${shortKey(key)})`);
  await sleepUnlessAborted(remaining, signal);
  if (!signal?.aborted && retryCooldownByKey.get(key) === until) {
    retryCooldownByKey.delete(key);
  }
}

export function recordRetryCooldown(key: string, delayMs: number): void {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return;
  }
  const now = Date.now();
  pruneExpiredCooldowns(now);
  const next = now + Math.round(delayMs);
  const current = retryCooldownByKey.get(key) ?? 0;
  retryCooldownByKey.set(key, Math.max(current, next));
  debugRetry(`cooldown set ${Math.round(delayMs)}ms (key=${shortKey(key)})`);
}

function readRequestUrl(input: RequestInfo): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }

  const request = input as Request;
  if (request.url) {
    return request.url;
  }
  return input.toString();
}

function safeParseBody(body: string): Record<string, unknown> | null {
  if (!body) {
    return null;
  }

  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function debugRetry(message: string): void {
  if (!isGeminiDebugEnabled()) {
    return;
  }
  logGeminiDebugMessage(`Retry: ${message}`);
}

function formatErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function shortKey(key: string): string {
  return key.length <= 120 ? key : `${key.slice(0, 120)}...`;
}

function startInFlightLog(attempt: number, url: string): () => void {
  if (!isGeminiDebugEnabled()) {
    return () => {};
  }

  const startedAt = Date.now();
  const interval = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    debugRetry(`attempt ${attempt} still waiting for response (${elapsed}ms) -> ${url}`);
  }, RETRY_IN_FLIGHT_LOG_INTERVAL_MS);

  return () => {
    clearInterval(interval);
  };
}

export {
  classifyQuotaResponse,
  computeGeminiRetryDecision,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_RETRY_DELAY_MS,
  getMaxRetryDelayMs,
  isRetryableNetworkError,
  isRetryableStatus,
  MODEL_CAPACITY_COOLDOWN_MS,
  resolveRetryDelayMs,
  retryInternals,
  sleepUnlessAborted,
  type GeminiRetryDecision,
  type QuotaContext,
};
