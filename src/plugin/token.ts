import {
  GEMINI_CLIENT_ID,
  GEMINI_CLIENT_SECRET,
  GEMINI_PROVIDER_ID,
} from "../constants";
import { geminiFetch } from "../fetch";
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./auth";
import { clearCachedAuth, storeCachedAuth } from "./cache";
import {
  formatDebugBodyPreview,
  isGeminiDebugEnabled,
  logGeminiDebugMessage,
} from "./debug";
import { log } from "./logger";
import { invalidateProjectContextCache } from "./project";
import {
  classifyRefreshFailure,
  clearRefreshOutcome,
  getRefreshFailureKind,
  isRefreshCooldownActive,
  noteRefreshTerminal,
  noteRefreshTransient,
  type RefreshFailureKind,
} from "./refresh-backoff";
import { acquireRefreshLock, type RefreshLock } from "./refresh-lock";
import {
  DEFAULT_MAX_ATTEMPTS,
  getExponentialDelayWithJitter,
  isRetryableNetworkError,
  isRetryableStatus,
  resolveRetryDelayMs,
} from "./retry/helpers";
import type { OAuthAuthDetails, PluginClient, RefreshParts } from "./types";

const DEFAULT_LOCK_WAIT_MS = 15_000;
const DEFAULT_LOCK_POLL_INTERVAL_MS = 250;

export interface RefreshAccessTokenOptions {
  force?: boolean;
  signal?: AbortSignal;
  readLatest?: () => Promise<OAuthAuthDetails | undefined> | OAuthAuthDetails | undefined;
  persist?: (updated: OAuthAuthDetails) => Promise<void> | void;
  persistClientAlways?: boolean;
  lockDir?: string;
  lockTtlMs?: number;
  maxLockWaitMs?: number;
  pollIntervalMs?: number;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
}

interface OAuthErrorPayload {
  error?:
    | string
    | {
        code?: string;
        status?: string;
        message?: string;
      };
  error_description?: string;
}

const refreshInFlight = new Map<string, Promise<OAuthAuthDetails | undefined>>();

/**
 * Parses OAuth error payloads returned by Google token endpoints, tolerating varied shapes.
 */
function parseOAuthErrorPayload(text: string | undefined): { code?: string; description?: string } {
  if (!text) {
    return {};
  }

  try {
    const payload = JSON.parse(text) as OAuthErrorPayload;
    if (!payload || typeof payload !== "object") {
      return { description: text };
    }

    let code: string | undefined;
    if (typeof payload.error === "string") {
      code = payload.error;
    } else if (payload.error && typeof payload.error === "object") {
      code = payload.error.status ?? payload.error.code;
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message };
      }
    }

    const description = payload.error_description;
    if (description) {
      return { code, description };
    }

    if (payload.error && typeof payload.error === "object" && payload.error.message) {
      return { code, description: payload.error.message };
    }

    return { code };
  } catch {
    return { description: text };
  }
}

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timerId: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    timerId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
  });
}

function tryAcquireLockBestEffort(
  refreshToken: string,
  options: RefreshAccessTokenOptions | undefined,
): { acquired: true; lock: RefreshLock } | { acquired: false; unavailable: boolean } {
  try {
    const lock = acquireRefreshLock(refreshToken, {
      dir: options?.lockDir,
      ttlMs: options?.lockTtlMs,
      now: options?.now,
    });
    if (lock) {
      return { acquired: true, lock };
    }
    return { acquired: false, unavailable: false };
  } catch (error) {
    log("Refresh lock unavailable; falling back to in-process singleflight", { error });
    return { acquired: false, unavailable: true };
  }
}

async function tryAdoptLatest(
  currentAuth: OAuthAuthDetails,
  currentParts: RefreshParts,
  options: RefreshAccessTokenOptions | undefined,
): Promise<OAuthAuthDetails | undefined> {
  if (!options?.readLatest) {
    return undefined;
  }

  let latest: OAuthAuthDetails | undefined;
  try {
    latest = await options.readLatest();
  } catch {
    return undefined;
  }

  if (!latest || latest.type !== "oauth" || !latest.refresh || accessTokenExpired(latest)) {
    return undefined;
  }

  const latestParts = parseRefreshParts(latest.refresh);
  if (!latestParts.refreshToken) {
    return undefined;
  }

  const changed =
    latestParts.refreshToken !== currentParts.refreshToken ||
    latest.access !== currentAuth.access ||
    (latest.expires ?? 0) > (currentAuth.expires ?? 0);
  if (!changed) {
    return undefined;
  }

  storeCachedAuth(latest);
  clearRefreshOutcome(currentParts.refreshToken);
  clearRefreshOutcome(latestParts.refreshToken);
  log("Adopted refreshed OAuth credentials from store");
  return latest;
}

/**
 * Returns the last recorded failure classification (`"transient"` or `"terminal"`) for
 * a given auth object or refresh string, if a refresh failed without subsequent recovery.
 */
export function getLastRefreshFailureKind(
  authOrRefresh: OAuthAuthDetails | string,
): RefreshFailureKind | undefined {
  const raw = typeof authOrRefresh === "string" ? authOrRefresh : authOrRefresh.refresh;
  const parts = parseRefreshParts(raw);
  if (!parts.refreshToken) {
    return undefined;
  }
  return getRefreshFailureKind(parts.refreshToken);
}

/**
 * Refreshes a Gemini OAuth access token, updates persisted credentials, and handles revocation.
 */
export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  client?: PluginClient,
  options?: RefreshAccessTokenOptions,
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  if (options?.signal?.aborted) {
    return undefined;
  }

  const pending = refreshInFlight.get(parts.refreshToken);
  if (pending) {
    return pending;
  }

  const refreshPromise = refreshAccessTokenInternal(auth, client, parts, options);
  refreshInFlight.set(parts.refreshToken, refreshPromise);

  try {
    return await refreshPromise;
  } finally {
    refreshInFlight.delete(parts.refreshToken);
  }
}

async function persistUpdatedAuth(
  updatedAuth: OAuthAuthDetails,
  previousRefreshToken: string,
  nextRefreshToken: string,
  client: PluginClient | undefined,
  options: RefreshAccessTokenOptions | undefined,
): Promise<void> {
  if (options?.persist) {
    try {
      await options.persist(updatedAuth);
    } catch (storeError) {
      console.error("Failed to persist refreshed Gemini OAuth credentials:", storeError);
    }
  }

  const shouldPersistClient =
    nextRefreshToken !== previousRefreshToken || options?.persistClientAlways === true;
  if (client && shouldPersistClient) {
    try {
      await client.auth.set({
        path: { id: GEMINI_PROVIDER_ID },
        body: updatedAuth,
      });
    } catch (storeError) {
      console.error("Failed to persist refreshed Gemini OAuth credentials:", storeError);
    }
  }
}

async function persistClearedAuth(
  clearedAuth: OAuthAuthDetails,
  client: PluginClient | undefined,
  options: RefreshAccessTokenOptions | undefined,
): Promise<void> {
  if (options?.persist) {
    try {
      await options.persist(clearedAuth);
    } catch (storeError) {
      console.error("Failed to clear stored Gemini OAuth credentials:", storeError);
    }
  }

  if (client) {
    try {
      await client.auth.set({
        path: { id: GEMINI_PROVIDER_ID },
        body: clearedAuth,
      });
    } catch (storeError) {
      console.error("Failed to clear stored Gemini OAuth credentials:", storeError);
    }
  }
}

async function refreshAccessTokenInternal(
  auth: OAuthAuthDetails,
  client: PluginClient | undefined,
  parts: RefreshParts,
  options: RefreshAccessTokenOptions | undefined,
): Promise<OAuthAuthDetails | undefined> {
  const now = options?.now ?? Date.now;
  let lock: RefreshLock | undefined;

  try {
    if (isRefreshCooldownActive(parts.refreshToken, now)) {
      const adopted = await tryAdoptLatest(auth, parts, options);
      if (adopted) {
        return adopted;
      }
      const kind = getRefreshFailureKind(parts.refreshToken);
      log("Skipping OAuth token refresh during active cooldown", { kind });
      return undefined;
    }

    const initialLock = tryAcquireLockBestEffort(parts.refreshToken, options);
    if (initialLock.acquired) {
      lock = initialLock.lock;
    } else if (!initialLock.unavailable) {
      const maxWaitMs = options?.maxLockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
      const pollMs = Math.max(10, options?.pollIntervalMs ?? DEFAULT_LOCK_POLL_INTERVAL_MS);
      const deadline = now() + maxWaitMs;
      const maxPolls = Math.max(1, Math.ceil(maxWaitMs / pollMs));

      for (let poll = 0; poll < maxPolls && now() < deadline; poll += 1) {
        const remaining = deadline - now();
        await waitWithSignal(Math.min(pollMs, remaining), options?.signal);

        const adopted = await tryAdoptLatest(auth, parts, options);
        if (adopted) {
          return adopted;
        }

        const retryLock = tryAcquireLockBestEffort(parts.refreshToken, options);
        if (retryLock.acquired) {
          lock = retryLock.lock;
          break;
        }
        if (retryLock.unavailable) {
          break;
        }
      }

      if (!lock) {
        const finalAdopted = await tryAdoptLatest(auth, parts, options);
        if (finalAdopted) {
          return finalAdopted;
        }
        log("Timed out waiting for peer OAuth refresh lock");
        return undefined;
      }

      if (isRefreshCooldownActive(parts.refreshToken, now)) {
        return await tryAdoptLatest(auth, parts, options);
      }
    }

    const response = await fetchTokenRefresh(parts.refreshToken, options);

    if (!response.ok) {
      let errorText: string | undefined;
      try {
        errorText = await response.text();
      } catch {
        errorText = undefined;
      }
      if (isGeminiDebugEnabled()) {
        logGeminiDebugMessage(
          `OAuth refresh response: ${response.status} ${response.statusText}`,
        );
        const preview = formatDebugBodyPreview(errorText);
        if (preview) {
          logGeminiDebugMessage(`OAuth refresh error body: ${preview}`);
        }
      }

      const { code, description } = parseOAuthErrorPayload(errorText);
      const kind = classifyRefreshFailure(code, response.status);
      const details = [code, description ?? errorText].filter(Boolean).join(": ");
      const baseMessage = `Gemini token refresh failed (${response.status} ${response.statusText})`;
      console.warn(`[Gemini OAuth] ${details ? `${baseMessage} - ${details}` : baseMessage}`);
      log("OAuth refresh failed", { status: response.status, code, kind });

      if (kind === "terminal") {
        noteRefreshTerminal(parts.refreshToken, { code, now });
        console.warn(
          "[Gemini OAuth] Google rejected the stored refresh token. Run `opencode auth login` and reauthenticate the Google provider.",
        );
        clearCachedAuth(auth.refresh);
        invalidateProjectContextCache(auth.refresh);
        const clearedAuth: OAuthAuthDetails = {
          type: "oauth",
          refresh: formatRefreshParts({
            refreshToken: "",
            projectId: parts.projectId,
            managedProjectId: parts.managedProjectId,
          }),
        };
        await persistClearedAuth(clearedAuth, client, options);
      } else {
        noteRefreshTransient(parts.refreshToken, {
          code,
          baseCooldownMs: options?.baseCooldownMs,
          maxCooldownMs: options?.maxCooldownMs,
          now,
        });
      }

      return undefined;
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
    };
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      noteRefreshTransient(parts.refreshToken, {
        code: "invalid_response",
        baseCooldownMs: options?.baseCooldownMs,
        maxCooldownMs: options?.maxCooldownMs,
        now,
      });
      return undefined;
    }

    const expiresInSeconds =
      typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
        ? payload.expires_in
        : 3600;

    if (isGeminiDebugEnabled()) {
      const rotated = payload.refresh_token && payload.refresh_token !== parts.refreshToken;
      logGeminiDebugMessage(
        `OAuth refresh success: expires_in=${expiresInSeconds}s refresh_rotated=${rotated ? "yes" : "no"}`,
      );
    }

    const refreshedParts: RefreshParts = {
      refreshToken: payload.refresh_token ?? parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
    };

    const updatedAuth: OAuthAuthDetails = {
      ...auth,
      access: payload.access_token,
      expires: now() + expiresInSeconds * 1000,
      refresh: formatRefreshParts(refreshedParts),
    };

    clearRefreshOutcome(parts.refreshToken);
    if (refreshedParts.refreshToken !== parts.refreshToken) {
      clearRefreshOutcome(refreshedParts.refreshToken);
    }
    clearCachedAuth(auth.refresh);
    storeCachedAuth(updatedAuth);
    invalidateProjectContextCache(auth.refresh);

    await persistUpdatedAuth(
      updatedAuth,
      parts.refreshToken,
      refreshedParts.refreshToken,
      client,
      options,
    );

    return updatedAuth;
  } catch (error) {
    if (isAbortError(error)) {
      log("OAuth token refresh aborted");
      return undefined;
    }
    noteRefreshTransient(parts.refreshToken, {
      code: error instanceof Error ? error.name : "unexpected_error",
      baseCooldownMs: options?.baseCooldownMs,
      maxCooldownMs: options?.maxCooldownMs,
      now,
    });
    console.error("Failed to refresh Gemini access token due to an unexpected error:", error);
    return undefined;
  } finally {
    lock?.release();
  }
}

async function fetchTokenRefresh(
  refreshToken: string,
  options: RefreshAccessTokenOptions | undefined,
): Promise<Response> {
  const tokenUrl = "https://oauth2.googleapis.com/token";
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
    }),
    signal: options?.signal,
  };

  let attempt = 1;
  while (attempt <= DEFAULT_MAX_ATTEMPTS) {
    if (isGeminiDebugEnabled()) {
      logGeminiDebugMessage(`OAuth refresh attempt ${attempt}: POST ${tokenUrl}`);
    }

    try {
      const response = await geminiFetch(tokenUrl, init);
      if (!isRetryableStatus(response.status) || attempt >= DEFAULT_MAX_ATTEMPTS) {
        return response;
      }

      const delayMs = await resolveRetryDelayMs(response, attempt);
      if (delayMs > 0) {
        await waitWithSignal(delayMs, options?.signal);
      }
      attempt += 1;
      continue;
    } catch (error) {
      if (
        isAbortError(error) ||
        options?.signal?.aborted ||
        attempt >= DEFAULT_MAX_ATTEMPTS ||
        !isRetryableNetworkError(error)
      ) {
        throw error;
      }
      await waitWithSignal(getExponentialDelayWithJitter(attempt), options?.signal);
      attempt += 1;
    }
  }

  return geminiFetch(tokenUrl, init);
}
