import { randomBytes } from "node:crypto";

import { readResponseText } from "./bounded";
import { currentVersion } from "./config";
import { geminiFetch, upstreamJson } from "./fetch";
import { refreshModels } from "./models";
import { createOAuthAuthorizeMethod } from "./oauth/authorize";
import { resolveProject } from "./project";
import { formatRefreshParts, parseRefreshParts } from "./refresh-parts";
import type { OAuthAuthDetails, TokenExchangeResult } from "./types";
import { OAUTH, buildAuthUrl, callbackUrl, tokenExchangeForm, tokenRefreshForm } from "./vendor/protocol.js";
import { userAgents } from "./wire";

/**
 * Google sign-in with the Antigravity OAuth client (callback on localhost:51121),
 * then Code Assist registration so the project id travels with the refresh token.
 */
export const authorizeAntigravity = createOAuthAuthorizeMethod({
  redirectUri: callbackUrl(),
  authorizeFn: async () => {
    const state = randomBytes(32).toString("hex");
    return { url: buildAuthUrl(state), verifier: "", state };
  },
  exchangeFn: (code) => exchangeCode(code),
  resolveProjectContextFn: async (auth, accessToken) => {
    const projectId = await resolveProject(accessToken);
    void refreshModels(accessToken, projectId);
    const { refreshToken } = parseRefreshParts(auth.refresh);
    return { auth: { ...auth, refresh: formatRefreshParts({ refreshToken, projectId }) } };
  },
});

const TOKEN_TIMEOUT_MS = 15_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 8 * 1024;

export interface TokenResponse {
  access: string;
  expires: number;
  refresh?: string;
}

const isBoundedToken = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH;

/** Validates Google's token JSON at runtime; undefined when anything is missing or malformed. */
export function parseTokenResponse(text: string, now = Date.now()): TokenResponse | undefined {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || !isBoundedToken(value.access_token)) return undefined;
  const expiresIn = value.expires_in === undefined ? 3600 : value.expires_in;
  if (typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0) return undefined;
  if (value.refresh_token !== undefined && !isBoundedToken(value.refresh_token)) return undefined;
  return { access: value.access_token, expires: now + expiresIn * 1000, refresh: value.refresh_token as string | undefined };
}

/** Only Google's error code (e.g. invalid_grant), never the raw body. */
function oauthErrorCode(text: string): string {
  try {
    const code = JSON.parse(text)?.error;
    if (typeof code === "string" && /^[a-z_]{1,64}$/.test(code)) return code;
  } catch {}
  return "unknown_error";
}

/** One POST to Google's token endpoint: bounded, no redirects, validated JSON. */
async function postTokenForm(form: URLSearchParams): Promise<{ status: number; text: string }> {
  const ua = userAgents(await currentVersion());
  const res = await geminiFetch(OAUTH.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua.refresh },
    body: form.toString(),
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  return { status: res.status, text: await readResponseText(res, MAX_TOKEN_RESPONSE_BYTES, "Google token response") };
}

/** Matches `exchangeGeminiWithVerifier`'s shape; Antigravity's client uses no PKCE. */
export async function exchangeCode(code: string): Promise<TokenExchangeResult> {
  try {
    const ua = userAgents(await currentVersion());
    const res = await postTokenForm(tokenExchangeForm(code));
    if (res.status < 200 || res.status >= 300) {
      return { type: "failed", error: `Google rejected the authorization code (${res.status} ${oauthErrorCode(res.text)})` };
    }
    const tokens = parseTokenResponse(res.text);
    if (!tokens) return { type: "failed", error: "Google returned an invalid token response" };
    if (!tokens.refresh) return { type: "failed", error: "Missing refresh token in response" };
    let email: string | undefined;
    try {
      const info = await upstreamJson(OAUTH.userinfoEndpoint, { method: "GET", token: tokens.access, ua: ua.short });
      if (typeof info.json?.email === "string") email = info.json.email;
    } catch {}
    return { type: "success", refresh: tokens.refresh, access: tokens.access, expires: tokens.expires, email };
  } catch (error) {
    return { type: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

const refreshInFlight = new Map<string, Promise<TokenResponse>>();

/**
 * One token request per refresh token at a time; every caller then builds and
 * persists its own copy, so a caller that joined an in-flight refresh still
 * records the new token.
 */
export async function refreshAuth(
  auth: OAuthAuthDetails,
  persist: (auth: OAuthAuthDetails) => Promise<void>,
): Promise<OAuthAuthDetails> {
  const parts = parseRefreshParts(auth.refresh);
  let run = refreshInFlight.get(parts.refreshToken);
  if (!run) {
    run = requestRefresh(parts.refreshToken).finally(() => refreshInFlight.delete(parts.refreshToken));
    refreshInFlight.set(parts.refreshToken, run);
  }
  const tokens = await run;
  const next: OAuthAuthDetails = {
    ...auth,
    access: tokens.access,
    expires: tokens.expires,
    refresh: formatRefreshParts({ ...parts, refreshToken: tokens.refresh ?? parts.refreshToken }),
  };
  await persist(next);
  return next;
}

async function requestRefresh(refreshToken: string): Promise<TokenResponse> {
  let res: { status: number; text: string };
  try {
    res = await postTokenForm(tokenRefreshForm(refreshToken));
  } catch (error) {
    throw new Error(`Google token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (res.status === 400 || res.status === 401) {
    throw new Error(
      `Google refresh token rejected (${oauthErrorCode(res.text)}). Sign in again with \`opencode auth login google --method antigravity\`.`,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Google token refresh failed (${res.status} ${oauthErrorCode(res.text)})`);
  }
  const tokens = parseTokenResponse(res.text);
  if (!tokens) throw new Error("Google token refresh returned an invalid token response");
  return tokens;
}
