import { createHash, randomBytes } from "node:crypto";

import { readResponseText } from "./bounded";
import { currentVersion } from "./config";
import { ANTIGRAVITY_CODE_REDIRECT_URI } from "./constants";
import { geminiFetch, upstreamJson } from "./fetch";
import { refreshModels } from "./models";
import { createOAuthAuthorizeMethod } from "./oauth/authorize";
import { resolveProject } from "./project";
import { formatRefreshParts, parseRefreshParts } from "./refresh-parts";
import type { OAuthAuthDetails, TokenExchangeResult } from "./types";
import { OAUTH, buildAuthUrl, callbackUrl, tokenExchangeForm, tokenRefreshForm } from "./vendor/protocol.js";
import { TOKEN_USER_AGENT, userAgents } from "./wire";

/**
 * Authorization URL of one sign-in. The client secret is public, so the code is bound to this
 * sign-in with PKCE (RFC 7636, S256): Google documents it for desktop apps ("Always use PKCE"),
 * and a code read by another local process, or pasted from another sign-in, is useless without
 * the verifier. `redirectUri` is the local listener or the Google-hosted code page.
 */
export async function antigravityAuthorization(
  redirectUri = callbackUrl(),
): Promise<{ url: string; verifier: string; state: string }> {
  const state = randomBytes(32).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(buildAuthUrl(state));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), verifier, state };
}

/**
 * Google sign-in with the Antigravity OAuth client, like the Antigravity CLI: callback on
 * localhost:51121, or the code pasted from Google's page when no listener can be used.
 * Then Code Assist registration so the project id travels with the refresh token.
 */
export const authorizeAntigravity = createOAuthAuthorizeMethod({
  redirectUri: callbackUrl(),
  codeRedirectUri: ANTIGRAVITY_CODE_REDIRECT_URI,
  authorizeFn: antigravityAuthorization,
  exchangeFn: (code, verifier, redirectUri) => exchangeCode(code, verifier, redirectUri),
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

/** RFC 6749 Appendix A: a token is 1*VSCHAR. Anything else (a mis-decoded byte included) is not one. */
const isBoundedToken = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_TOKEN_LENGTH && /^[\x20-\x7e]+$/.test(value);

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
  // "|" separates the parts of the stored refresh string (refresh-parts.ts).
  if (value.refresh_token !== undefined && (!isBoundedToken(value.refresh_token) || value.refresh_token.includes("|"))) {
    return undefined;
  }
  const expires = now + expiresIn * 1000;
  // OpenCode compares it with the clock to decide when to refresh: an inexact date would never be reached.
  if (!Number.isSafeInteger(expires)) return undefined;
  return { access: value.access_token, expires, refresh: value.refresh_token as string | undefined };
}

/** Only Google's error code (e.g. invalid_grant), never the raw body. */
function oauthErrorCode(text: string): string {
  try {
    const code = JSON.parse(text)?.error;
    if (typeof code === "string" && /^[a-z_]{1,64}$/.test(code)) return code;
  } catch {}
  return "unknown_error";
}

/**
 * One POST to Google's token endpoint: bounded, no redirects, validated JSON. Nothing else is
 * awaited first: a refresh must not depend on the version manifest being reachable.
 */
async function postTokenForm(form: URLSearchParams): Promise<{ status: number; text: string }> {
  const res = await geminiFetch(OAUTH.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": TOKEN_USER_AGENT },
    body: form.toString(),
    redirect: "error",
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  return { status: res.status, text: await readResponseText(res, MAX_TOKEN_RESPONSE_BYTES, "Google token response") };
}

/** Exchanges the code with the PKCE verifier and redirect URI of the sign-in that produced it. */
export async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri = callbackUrl(),
): Promise<TokenExchangeResult> {
  try {
    const form = tokenExchangeForm(code);
    form.set("redirect_uri", redirectUri); // RFC 6749 §4.1.3: identical to the authorization request
    if (verifier) form.set("code_verifier", verifier);
    const res = await postTokenForm(form);
    if (res.status < 200 || res.status >= 300) {
      return { type: "failed", error: `Google rejected the authorization code (${res.status} ${oauthErrorCode(res.text)})` };
    }
    const tokens = parseTokenResponse(res.text);
    if (!tokens) return { type: "failed", error: "Google returned an invalid token response" };
    if (!tokens.refresh) return { type: "failed", error: "Missing refresh token in response" };
    let email: string | undefined;
    try {
      const ua = userAgents(await currentVersion()).short;
      const info = await upstreamJson(OAUTH.userinfoEndpoint, { method: "GET", token: tokens.access, ua });
      if (typeof info.json?.email === "string") email = info.json.email;
    } catch {}
    return { type: "success", refresh: tokens.refresh, access: tokens.access, expires: tokens.expires, email };
  } catch (error) {
    return { type: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

const refreshInFlight = new Map<string, Promise<TokenResponse>>();
/**
 * SHA-256 of the refresh tokens Google answered `invalid_grant` for: expired or revoked
 * (RFC 6749 §5.2), so sending one again can only fail. Kept for the life of the process;
 * a new sign-in has a new token. Network errors and other statuses are never recorded.
 */
const refusedRefreshTokens = new Set<string>();
const MAX_REFUSED_REFRESH_TOKENS = 256;
const refreshTokenKey = (token: string) => createHash("sha256").update(token).digest("base64url");
const SIGN_IN_AGAIN = "Sign in again with `opencode auth login google --method antigravity`.";

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
  if (refusedRefreshTokens.has(refreshTokenKey(parts.refreshToken))) {
    throw new Error(`Google refresh token rejected (invalid_grant); it will not be sent again. ${SIGN_IN_AGAIN}`);
  }
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
    const code = oauthErrorCode(res.text);
    if (res.status === 400 && code === "invalid_grant") {
      if (refusedRefreshTokens.size >= MAX_REFUSED_REFRESH_TOKENS) refusedRefreshTokens.clear();
      refusedRefreshTokens.add(refreshTokenKey(refreshToken));
    }
    throw new Error(`Google refresh token rejected (${code}). ${SIGN_IN_AGAIN}`);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Google token refresh failed (${res.status} ${oauthErrorCode(res.text)})`);
  }
  const tokens = parseTokenResponse(res.text);
  if (!tokens) throw new Error("Google token refresh returned an invalid token response");
  return tokens;
}
