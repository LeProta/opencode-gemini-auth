import { readResponseText } from "../bounded";
import {
  CLOUDCODE_DOMAINS as CLOUDCODE_DOMAIN_LIST,
  parseRetryDelayFromMessage as parseSharedRetryDelayFromMessage,
  parseRetryDelayValue as parseSharedRetryDelayValue,
} from "../request/helpers";

interface GoogleRpcErrorInfo {
  "@type"?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, string>;
}

interface GoogleRpcQuotaViolation {
  quotaId?: string;
  description?: string;
}

interface GoogleRpcQuotaFailure {
  "@type"?: string;
  violations?: GoogleRpcQuotaViolation[];
}

interface GoogleRpcRetryInfo {
  "@type"?: string;
  retryDelay?: string | { seconds?: number; nanos?: number };
}

export interface QuotaContext {
  terminal: boolean;
  retryDelayMs?: number;
  reason?: string;
}

const CLOUDCODE_DOMAINS = new Set(CLOUDCODE_DOMAIN_LIST);

/**
 * Parses Code Assist 429 payload details to determine terminal vs retryable quota states.
 *
 * This mirrors Gemini CLI behavior so we:
 * - fail fast on hard quota exhaustion (`QUOTA_EXHAUSTED`, daily limits)
 * - keep retrying on short-window limits (`RATE_LIMIT_EXCEEDED`, per-minute limits)
 */
export async function classifyQuotaResponse(response: Response): Promise<QuotaContext | null> {
  const payload = await parseErrorBody(response);
  if (!payload) {
    return null;
  }

  const details = Array.isArray(payload.details) ? payload.details : [];
  const retryInfo = details.find(
    (detail): detail is GoogleRpcRetryInfo =>
      isObject(detail) &&
      detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
  );
  const retryDelayMs =
    (retryInfo?.retryDelay ? parseSharedRetryDelayValue(retryInfo.retryDelay) : null) ??
    parseSharedRetryDelayFromMessage(payload.message ?? "") ??
    undefined;

  const errorInfos = details.filter(
    (detail): detail is GoogleRpcErrorInfo =>
      isObject(detail) &&
      detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo",
  );
  const cloudCodeErrorInfos = errorInfos.filter(
    (info) => !info.domain || CLOUDCODE_DOMAINS.has(info.domain),
  );
  if (errorInfos.length > 0 && cloudCodeErrorInfos.length === 0) {
    return null;
  }

  const prioritizedErrorInfo =
    cloudCodeErrorInfos.find(
      (info) =>
        info.reason === "QUOTA_EXHAUSTED" ||
        info.reason === "RATE_LIMIT_EXCEEDED" ||
        info.reason === "MODEL_CAPACITY_EXHAUSTED",
    ) ?? cloudCodeErrorInfos[0];

  if (prioritizedErrorInfo?.reason === "QUOTA_EXHAUSTED") {
    return { terminal: true, retryDelayMs, reason: prioritizedErrorInfo.reason };
  }
  if (prioritizedErrorInfo?.reason === "RATE_LIMIT_EXCEEDED") {
    return {
      terminal: false,
      retryDelayMs: retryDelayMs ?? 10_000,
      reason: prioritizedErrorInfo.reason,
    };
  }
  if (prioritizedErrorInfo?.reason === "MODEL_CAPACITY_EXHAUSTED") {
    return {
      terminal: retryDelayMs === undefined,
      retryDelayMs,
      reason: prioritizedErrorInfo.reason,
    };
  }

  const quotaFailure = details.find(
    (detail): detail is GoogleRpcQuotaFailure =>
      isObject(detail) &&
      detail["@type"] === "type.googleapis.com/google.rpc.QuotaFailure",
  );
  if (quotaFailure?.violations?.length) {
    const allTexts = quotaFailure.violations
      .flatMap((violation) => [violation.quotaId ?? "", violation.description ?? ""])
      .join(" ")
      .toLowerCase();

    if (allTexts.includes("perday") || allTexts.includes("daily") || allTexts.includes("per day")) {
      return { terminal: true, retryDelayMs, reason: prioritizedErrorInfo?.reason };
    }
    if (allTexts.includes("perminute") || allTexts.includes("per minute")) {
      return {
        terminal: false,
        retryDelayMs: retryDelayMs ?? 60_000,
        reason: prioritizedErrorInfo?.reason,
      };
    }
    return { terminal: false, retryDelayMs, reason: prioritizedErrorInfo?.reason };
  }

  const quotaLimit =
    cloudCodeErrorInfos
      .map((info) => info.metadata?.quota_limit?.toLowerCase() ?? "")
      .find((value) => value.length > 0) ?? "";
  if (quotaLimit.includes("perminute") || quotaLimit.includes("per minute")) {
    return {
      terminal: false,
      retryDelayMs: retryDelayMs ?? 60_000,
      reason: prioritizedErrorInfo?.reason,
    };
  }

  return { terminal: false, retryDelayMs, reason: prioritizedErrorInfo?.reason };
}

/**
 * Extracts RetryInfo delay hints directly from error payloads.
 *
 * We keep this as a shared utility for retry scheduling so request-level behavior
 * and quota-classified behavior derive from the same delay parser.
 */
export async function parseRetryDelayFromBody(response: Response): Promise<number | null> {
  const payload = await parseErrorBody(response);
  if (!payload) {
    return null;
  }

  const details = Array.isArray(payload.details) ? payload.details : [];
  const retryInfo = details.find(
    (detail): detail is GoogleRpcRetryInfo =>
      isObject(detail) &&
      detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
  );
  if (retryInfo?.retryDelay) {
    const delayMs = parseSharedRetryDelayValue(retryInfo.retryDelay);
    if (delayMs !== null) {
      return delayMs;
    }
  }

  if (typeof payload.message === "string") {
    return parseSharedRetryDelayFromMessage(payload.message);
  }
  return null;
}

function parseJsonSafe(rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    return undefined;
  }
}

function extractSseErrorPayloads(rawText: string): unknown[] {
  const parsedItems: unknown[] = [];
  const dataLines: string[] = [];

  const flush = (): void => {
    if (dataLines.length === 0) {
      return;
    }
    const payload = dataLines.join("\n").trim();
    dataLines.length = 0;
    if (!payload || payload === "[DONE]") {
      return;
    }
    const parsed = parseJsonSafe(payload);
    if (parsed !== undefined) {
      parsedItems.push(parsed);
    }
  };

  for (const rawLine of rawText.split(/\r?\n/)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  flush();

  return parsedItems;
}

const ERROR_BODY_LIMIT_BYTES = 1024 * 1024;
const ERROR_BODY_TIMEOUT_MS = 5_000;

async function parseErrorBody(
  response: Response,
): Promise<{ message?: string; details?: unknown[] } | null> {
  let text = "";
  try {
    // Best-effort diagnosis: an oversized or stalled error body is just "unknown".
    text = await readResponseText(
      response.clone(),
      ERROR_BODY_LIMIT_BYTES,
      "Gemini error body",
      AbortSignal.timeout(ERROR_BODY_TIMEOUT_MS),
    );
  } catch {
    return null;
  }
  if (!text) {
    return null;
  }

  const directParsed = parseJsonSafe(text);
  const candidates =
    directParsed !== undefined ? [directParsed] : extractSseErrorPayloads(text);

  for (const candidate of candidates) {
    const normalized = normalizeErrorEnvelope(candidate);
    if (!normalized || !isObject(normalized.error)) {
      continue;
    }

    const error = normalized.error as Record<string, unknown>;
    return {
      message: typeof error.message === "string" ? error.message : undefined,
      details: Array.isArray(error.details) ? error.details : undefined,
    };
  }

  return null;
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeErrorEnvelope(parsed: unknown): Record<string, unknown> | null {
  if (Array.isArray(parsed)) {
    const withError = parsed.find((item) => isObject(item) && isObject(item.error));
    if (isObject(withError)) {
      return withError;
    }
    const firstObject = parsed.find(isObject);
    return isObject(firstObject) ? firstObject : null;
  }
  return isObject(parsed) ? parsed : null;
}

export const retryInternals = {
  parseRetryDelayValue: parseSharedRetryDelayValue,
  parseRetryDelayFromMessage: parseSharedRetryDelayFromMessage,
};
