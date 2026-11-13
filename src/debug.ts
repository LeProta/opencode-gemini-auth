import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "node:process";
import { redact, redactString } from "./redact";
import { getGeminiPluginDataDir } from "./storage-paths";

const MAX_BODY_PREVIEW_CHARS = 2000;
const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
]);

let cachedLogDir: string | undefined;
let cachedLogFilePath: string | undefined;

export interface GeminiDebugContext {
  id: string;
  streaming: boolean;
  startedAt: number;
}

interface GeminiDebugRequestMeta {
  originalUrl: string;
  resolvedUrl: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  streaming: boolean;
  projectId?: string;
}

interface GeminiDebugResponseMeta {
  body?: string;
  note?: string;
  error?: unknown;
  headersOverride?: HeadersInit;
}

let requestCounter = 0;

/**
 * Returns true when Gemini debug logging is enabled.
 */
export function isGeminiDebugEnabled(): boolean {
  return (env.OPENCODE_GEMINI_DEBUG ?? "").trim() === "1";
}

/**
 * Writes an arbitrary debug line when debugging is enabled.
 */
export function logGeminiDebugMessage(message: string): void {
  if (!isGeminiDebugEnabled()) {
    return;
  }
  logDebug(`[Gemini Debug] ${redactString(message)}`);
}

/**
 * Produces a truncated preview of a debug body payload.
 */
export function formatDebugBodyPreview(text?: string | null): string | undefined {
  if (!text) {
    return undefined;
  }
  return truncateForLog(text);
}

/**
 * Begins a debug trace for a Gemini request, logging request metadata when debugging is enabled.
 */
export function startGeminiDebugRequest(meta: GeminiDebugRequestMeta): GeminiDebugContext | null {
  if (!isGeminiDebugEnabled()) {
    return null;
  }

  const id = `GEMINI-${++requestCounter}`;
  const method = meta.method ?? "GET";
  const safeResolvedUrl = redactString(meta.resolvedUrl);
  const safeOriginalUrl = meta.originalUrl ? redactString(meta.originalUrl) : "";
  logDebug(`[Gemini Debug ${id}] ${method} ${safeResolvedUrl}`);
  if (safeOriginalUrl && safeOriginalUrl !== safeResolvedUrl) {
    logDebug(`[Gemini Debug ${id}] Original URL: ${safeOriginalUrl}`);
  }
  if (meta.projectId) {
    logDebug(`[Gemini Debug ${id}] Project: ${meta.projectId}`);
  }
  logDebug(`[Gemini Debug ${id}] Streaming: ${meta.streaming ? "yes" : "no"}`);
  logDebug(`[Gemini Debug ${id}] Headers: ${JSON.stringify(maskHeaders(meta.headers))}`);
  const bodyPreview = formatBodyPreview(meta.body);
  if (bodyPreview) {
    logDebug(`[Gemini Debug ${id}] Body Preview: ${bodyPreview}`);
  }

  return { id, streaming: meta.streaming, startedAt: Date.now() };
}

/**
 * Logs response details for a previously started debug trace when debugging is enabled.
 */
export function logGeminiDebugResponse(
  context: GeminiDebugContext | null | undefined,
  response: Response,
  meta: GeminiDebugResponseMeta = {},
): void {
  if (!isGeminiDebugEnabled() || !context) {
    return;
  }

  const durationMs = Date.now() - context.startedAt;
  logDebug(
    `[Gemini Debug ${context.id}] Response ${response.status} ${response.statusText} (${durationMs}ms)`,
  );
  logDebug(
    `[Gemini Debug ${context.id}] Response Headers: ${JSON.stringify(
      maskHeaders(meta.headersOverride ?? response.headers),
    )}`,
  );

  const traceId = getHeaderValue(meta.headersOverride ?? response.headers, "x-cloudaicompanion-trace-id");
  if (traceId) {
    logDebug(`[Gemini Debug ${context.id}] Trace ID: ${traceId}`);
  }

  if (meta.note) {
    logDebug(`[Gemini Debug ${context.id}] Note: ${meta.note}`);
  }

  if (meta.error) {
    logDebug(`[Gemini Debug ${context.id}] Error: ${formatError(meta.error)}`);
  }

  if (meta.body) {
    logDebug(
      `[Gemini Debug ${context.id}] Response Body Preview: ${truncateForLog(meta.body)}`,
    );
  }
}

/**
 * Obscures sensitive headers and returns a plain object for logging.
 */
function maskHeaders(headers?: HeadersInit | Headers): Record<string, string> {
  if (!headers) {
    return {};
  }

  const result: Record<string, string> = {};
  const parsed = headers instanceof Headers ? headers : new Headers(headers);
  parsed.forEach((value, key) => {
    if (SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) {
      result[key] = "[redacted]";
    } else {
      result[key] = redactString(value);
    }
  });
  return result;
}

/**
 * Reads a header value from a HeadersInit or Headers instance.
 */
function getHeaderValue(headers: HeadersInit | Headers, key: string): string | undefined {
  const target = key.toLowerCase();
  if (headers instanceof Headers) {
    const value = headers.get(key);
    return value ?? undefined;
  }

  if (Array.isArray(headers)) {
    for (const [headerKey, headerValue] of headers) {
      if (headerKey.toLowerCase() === target) {
        return headerValue;
      }
    }
    return undefined;
  }

  const record = headers as Record<string, string | undefined>;
  for (const [headerKey, headerValue] of Object.entries(record)) {
    if (headerKey.toLowerCase() === target) {
      return headerValue ?? undefined;
    }
  }
  return undefined;
}

/**
 * Produces a short, type-aware preview of a request/response body for logs.
 */
function formatBodyPreview(body?: BodyInit | null): string | undefined {
  if (body == null) {
    return undefined;
  }

  if (typeof body === "string") {
    return truncateForLog(body);
  }

  if (body instanceof URLSearchParams) {
    return truncateForLog(body.toString());
  }

  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return `[Blob size=${body.size}]`;
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return "[FormData payload omitted]";
  }

  return `[${body.constructor?.name ?? typeof body} payload omitted]`;
}

/**
 * Truncates long strings to a fixed preview length for logging.
 */
function truncateForLog(text: string): string {
  const safeText = redactString(text);
  if (safeText.length <= MAX_BODY_PREVIEW_CHARS) {
    return safeText;
  }
  return `${safeText.slice(0, MAX_BODY_PREVIEW_CHARS)}... (truncated ${safeText.length - MAX_BODY_PREVIEW_CHARS} chars)`;
}

/**
 * Writes a single debug line lazily to the plugin log directory.
 */
function logDebug(line: string): void {
  const filePath = resolveDebugLogFilePath();
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${redactString(line)}\n`, "utf8");
  } catch {
    // Best-effort debug logging must never abort requests.
  }
}

/**
 * Converts unknown error-like values into printable, redacted strings.
 */
function formatError(error: unknown): string {
  if (error instanceof Error) {
    return redactString(error.stack ?? error.message);
  }
  try {
    return JSON.stringify(redact(error));
  } catch {
    return redactString(String(error));
  }
}

/**
 * Resolves a timestamped log file path inside the plugin data directory.
 */
function resolveDebugLogFilePath(): string {
  const logDir = join(getGeminiPluginDataDir(), "logs");
  if (!cachedLogFilePath || cachedLogDir !== logDir) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    cachedLogDir = logDir;
    cachedLogFilePath = join(logDir, `gemini-debug-${timestamp}.log`);
  }
  return cachedLogFilePath;
}
