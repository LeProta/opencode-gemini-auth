import { parseRetryDelayFromBody, type QuotaContext } from "./quota";

export const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 5000;
const DEFAULT_MAX_DELAY_MS = 30000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
export const MODEL_CAPACITY_COOLDOWN_MS = 8000;

export interface GeminiRetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  cooldownMs?: number;
  reason:
    | "non_retryable_status"
    | "terminal_quota"
    | "max_attempts_reached"
    | "aborted"
    | "retry_delay_exceeds_max"
    | "retryable";
}

/**
 * Reads maximum retry wait duration in ms from `OPENCODE_GEMINI_MAX_RETRY_MS`.
 */
export function getMaxRetryDelayMs(): number {
  const raw = process.env.OPENCODE_GEMINI_MAX_RETRY_MS;
  if (!raw) {
    return DEFAULT_MAX_RETRY_DELAY_MS;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_MAX_RETRY_DELAY_MS;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MAX_RETRY_DELAY_MS;
  }
  return Math.round(parsed);
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC",
  "ERR_SSL_BAD_RECORD_MAC",
  "EPROTO",
]);

/**
 * Ensures request bodies are replayable before we attempt retries.
 */
export function canRetryRequest(init: RequestInit | undefined): boolean {
  if (!init?.body) {
    return true;
  }

  const body = init.body;
  if (typeof body === "string") {
    return true;
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return true;
  }
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    return true;
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body)) {
    return true;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return true;
  }

  return false;
}

/**
 * Status-based retry policy aligned to Gemini CLI.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Handles transient network failures (including nested `cause` and `AggregateError.errors`).
 */
export function isRetryableNetworkError(error: unknown): boolean {
  const code = getNetworkErrorCode(error);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) {
    return true;
  }

  return error instanceof Error && error.message.toLowerCase().includes("fetch failed");
}

/**
 * Resolves retry delay using header hints, parsed payload retry info, and backoff fallback.
 */
export async function resolveRetryDelayMs(
  response: Response,
  attempt: number,
  quotaDelayMs?: number,
): Promise<number> {
  const retryAfterMsHeader = parseRetryAfterMs(response.headers.get("retry-after-ms"));
  if (retryAfterMsHeader !== null) {
    return retryAfterMsHeader;
  }

  const retryAfterHeader = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfterHeader !== null) {
    return retryAfterHeader;
  }

  if (quotaDelayMs !== undefined && Number.isFinite(quotaDelayMs)) {
    return Math.max(0, Math.round(quotaDelayMs));
  }

  const bodyDelay = await parseRetryDelayFromBody(response);
  if (bodyDelay !== null) {
    return Math.max(0, Math.round(bodyDelay));
  }

  return getExponentialDelayWithJitter(attempt);
}

/**
 * Computes retry/fail-fast decision for an HTTP response without mutating state.
 */
export async function computeGeminiRetryDecision(
  response: Response,
  attempt: number,
  quotaContext?: QuotaContext | null,
  options?: {
    signal?: AbortSignal | null;
    maxAttempts?: number;
    maxRetryDelayMs?: number;
  },
): Promise<GeminiRetryDecision> {
  if (!isRetryableStatus(response.status)) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: "non_retryable_status",
    };
  }

  if (response.status === 429 && quotaContext?.terminal) {
    const cooldownMs =
      quotaContext.reason === "MODEL_CAPACITY_EXHAUSTED"
        ? (quotaContext.retryDelayMs ?? MODEL_CAPACITY_COOLDOWN_MS)
        : undefined;
    return {
      shouldRetry: false,
      delayMs: 0,
      cooldownMs,
      reason: "terminal_quota",
    };
  }

  if (options?.signal?.aborted) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: "aborted",
    };
  }

  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (attempt >= maxAttempts) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: "max_attempts_reached",
    };
  }

  const delayMs = await resolveRetryDelayMs(response, attempt, quotaContext?.retryDelayMs);
  const maxRetryDelayMs = options?.maxRetryDelayMs ?? getMaxRetryDelayMs();
  if (delayMs > maxRetryDelayMs) {
    return {
      shouldRetry: false,
      delayMs,
      reason: "retry_delay_exceeds_max",
    };
  }

  return {
    shouldRetry: true,
    delayMs,
    cooldownMs: delayMs > 0 && response.status === 429 ? delayMs : undefined,
    reason: "retryable",
  };
}

export function getExponentialDelayWithJitter(attempt: number): number {
  const base = Math.min(DEFAULT_MAX_DELAY_MS, DEFAULT_INITIAL_DELAY_MS * Math.pow(2, attempt - 1));
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return clampDelay(base + jitter);
}

/**
 * Sleeps for `ms` milliseconds or resolves early if `signal` aborts.
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      cleanup();
      resolve();
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    }, ms);
  });
}

export const wait = sleepUnlessAborted;

function getNetworkErrorCode(error: unknown): string | undefined {
  const readCode = (value: unknown): string | undefined => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    if ("code" in value && typeof (value as { code?: unknown }).code === "string") {
      return (value as { code: string }).code;
    }
    return undefined;
  };

  const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new Set<object>();

  while (queue.length > 0 && seen.size < 32) {
    const current = queue.shift()!;
    if (!current.value || typeof current.value !== "object") {
      continue;
    }
    if (seen.has(current.value)) {
      continue;
    }
    seen.add(current.value);

    const code = readCode(current.value);
    if (code) {
      return code;
    }

    if (current.depth >= 5) {
      continue;
    }

    if ("cause" in current.value) {
      queue.push({
        value: (current.value as { cause?: unknown }).cause,
        depth: current.depth + 1,
      });
    }

    if (
      "errors" in current.value &&
      Array.isArray((current.value as { errors?: unknown }).errors)
    ) {
      for (const nested of (current.value as { errors: unknown[] }).errors) {
        queue.push({ value: nested, depth: current.depth + 1 });
      }
    }
  }

  return undefined;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }
  return null;
}

function clampDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs)) {
    return DEFAULT_MAX_DELAY_MS;
  }
  return Math.min(Math.max(0, Math.round(delayMs)), DEFAULT_MAX_DELAY_MS);
}
