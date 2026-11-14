import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getGeminiPluginDataDir } from "./storage-paths";

export interface LoggerInitOptions {
  enabled?: boolean;
  filePath?: string;
}

const SECRET_KEY_NAMES = new Set([
  "access",
  "accesstoken",
  "apikey",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "idtoken",
  "password",
  "proxyauthorization",
  "refresh",
  "refreshtoken",
  "secret",
  "setcookie",
  "token",
  "xapikey",
  "xgoogapikey",
]);

const REDACTED = "[redacted]";

let configuredEnabled: boolean | undefined;
let configuredFilePath: string | undefined;
let ensuredDirs = new Set<string>();

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_KEY_NAMES.has(normalized);
}

/**
 * Redacts sensitive tokens, credentials, and authorization headers from strings
 * and nested structures while preserving non-secret metadata fields.
 */
export function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    };
    if (value.stack) {
      out.stack = redactString(value.stack);
    }
    const extra = value as unknown as Record<string, unknown>;
    if ("code" in extra) {
      out.code = redact(extra.code, seen);
    }
    if ("status" in extra) {
      out.status = extra.status;
    }
    return out;
  }

  if (value instanceof Headers) {
    const out: Record<string, string> = {};
    value.forEach((v, k) => {
      out[k] = isSensitiveKey(k) ? REDACTED : redactString(v);
    });
    return out;
  }

  if (value instanceof URLSearchParams) {
    const out: Record<string, string> = {};
    value.forEach((v, k) => {
      out[k] = isSensitiveKey(k) ? REDACTED : redactString(v);
    });
    return out;
  }

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (isSensitiveKey(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out;
}

/**
 * Redacts credential and token patterns inside a raw text payload.
 */
export function redactString(input: string): string {
  return input
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/\bya29\.[A-Za-z0-9._-]{8,}\b/g, REDACTED)
    .replace(/\b1\/\/[A-Za-z0-9._-]{8,}\b/g, REDACTED)
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED)
    .replace(/\bGOCSPX-[0-9A-Za-z_-]{10,}\b/g, REDACTED)
    .replace(
      /("(?:access_token|refresh_token|id_token|client_secret|authorization|x-goog-api-key|x-api-key|api_key|apiKey)"\s*:\s*")([^"]*)(")/gi,
      `$1${REDACTED}$3`,
    )
    .replace(
      /\b(access_token|refresh_token|id_token|client_secret|authorization|api_key)=([^&\s]+)/gi,
      `$1=${REDACTED}`,
    );
}

function isLoggerEnabled(): boolean {
  if (configuredEnabled !== undefined) {
    return configuredEnabled;
  }
  return (process.env.OPENCODE_GEMINI_DEBUG ?? "").trim() === "1";
}

function resolveLogFilePath(): string {
  if (configuredFilePath) {
    return configuredFilePath;
  }
  const day = new Date().toISOString().slice(0, 10);
  return join(getGeminiPluginDataDir(), "logs", `gemini-auth-${day}.log`);
}

/**
 * Initializes or resets logger configuration. Safe to call repeatedly in tests.
 */
export function initLogger(options?: LoggerInitOptions): void {
  configuredEnabled = options?.enabled;
  configuredFilePath = options?.filePath;
  ensuredDirs = new Set<string>();
}

/**
 * Resets cached logger state so temporary log directories can be removed cleanly.
 */
export function closeLogger(): void {
  configuredEnabled = undefined;
  configuredFilePath = undefined;
  ensuredDirs = new Set<string>();
}

/**
 * Appends a structured, redacted log line to the active debug log file when
 * debugging is enabled. Uses lazy synchronous appends to avoid leaking open handles.
 */
export function log(message: string, meta?: unknown): void {
  if (!isLoggerEnabled()) {
    return;
  }

  const filePath = resolveLogFilePath();
  const dir = dirname(filePath);
  const safeMessage = redactString(message);
  const line =
    meta === undefined
      ? `[${new Date().toISOString()}] ${safeMessage}\n`
      : `[${new Date().toISOString()}] ${safeMessage} ${JSON.stringify(redact(meta))}\n`;

  try {
    if (!ensuredDirs.has(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      ensuredDirs.add(dir);
    }
    appendFileSync(filePath, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Best-effort logging must never interrupt auth or request flows.
  }
}
