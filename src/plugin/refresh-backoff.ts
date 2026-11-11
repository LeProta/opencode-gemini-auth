export type RefreshFailureKind = "transient" | "terminal";

export const BASE_COOLDOWN_MS = 15_000;
export const MAX_COOLDOWN_MS = 60_000;

const TERMINAL_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
]);

export interface RefreshBackoffState {
  failures: number;
  cooldownUntil: number;
  kind: RefreshFailureKind;
  code?: string;
}

export interface RefreshBackoffOptions {
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
  code?: string;
}

const backoffStates = new Map<string, RefreshBackoffState>();

/**
 * Classifies an OAuth token-endpoint failure as either terminal (re-auth required)
 * or transient (eligible for exponential backoff).
 */
export function classifyRefreshFailure(code?: string, _status?: number): RefreshFailureKind {
  const normalized = code?.trim().toLowerCase();
  if (normalized && TERMINAL_OAUTH_ERRORS.has(normalized)) {
    return "terminal";
  }
  return "transient";
}

/**
 * Computes bounded exponential backoff in milliseconds for a given failure count.
 */
export function computeBackoffMs(
  failures: number,
  baseCooldownMs = BASE_COOLDOWN_MS,
  maxCooldownMs = MAX_COOLDOWN_MS,
): number {
  if (failures <= 0 || baseCooldownMs <= 0) {
    return 0;
  }
  const exponent = Math.min(failures - 1, 30);
  return Math.min(maxCooldownMs, baseCooldownMs * 2 ** exponent);
}

/**
 * Records a transient refresh failure for `key` and arms an exponential cooldown window.
 */
export function noteRefreshTransient(
  key: string,
  options: RefreshBackoffOptions = {},
): RefreshBackoffState & { cooldownMs: number } {
  const now = options.now ?? Date.now;
  const baseCooldownMs = options.baseCooldownMs ?? BASE_COOLDOWN_MS;
  const maxCooldownMs = options.maxCooldownMs ?? MAX_COOLDOWN_MS;
  const existing = backoffStates.get(key);
  const failures = (existing?.kind === "transient" ? existing.failures : 0) + 1;
  const cooldownMs = computeBackoffMs(failures, baseCooldownMs, maxCooldownMs);
  const state: RefreshBackoffState = {
    failures,
    cooldownUntil: now() + cooldownMs,
    kind: "transient",
    code: options.code,
  };
  backoffStates.set(key, state);
  return { ...state, cooldownMs };
}

/**
 * Records a terminal refresh failure for `key`, blocking automated retries until cleared.
 */
export function noteRefreshTerminal(
  key: string,
  options: Pick<RefreshBackoffOptions, "code" | "now"> = {},
): RefreshBackoffState {
  const existing = backoffStates.get(key);
  const state: RefreshBackoffState = {
    failures: (existing?.failures ?? 0) + 1,
    cooldownUntil: Number.POSITIVE_INFINITY,
    kind: "terminal",
    code: options.code,
  };
  backoffStates.set(key, state);
  return state;
}

/**
 * Clears recorded backoff/failure state for `key` after a successful refresh or token update.
 */
export function clearRefreshOutcome(key: string): void {
  backoffStates.delete(key);
}

/**
 * Returns true if automated refresh attempts for `key` should currently wait.
 */
export function isRefreshCooldownActive(
  key: string,
  now: () => number = Date.now,
): boolean {
  const state = backoffStates.get(key);
  if (!state) {
    return false;
  }
  if (state.kind === "terminal") {
    return true;
  }
  return now() < state.cooldownUntil;
}

/**
 * Returns the epoch timestamp (or `Infinity` for terminal errors) until which `key` is cooled down.
 */
export function getRefreshCooldownUntil(key: string): number | undefined {
  return backoffStates.get(key)?.cooldownUntil;
}

/**
 * Returns the last recorded failure classification for `key`, if any.
 */
export function getRefreshFailureKind(key: string): RefreshFailureKind | undefined {
  return backoffStates.get(key)?.kind;
}

/**
 * Clears all tracked refresh backoff states across keys. Intended for tests.
 */
export function resetRefreshBackoffState(): void {
  backoffStates.clear();
}
