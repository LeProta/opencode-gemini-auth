import { isGeminiDebugEnabled, logGeminiDebugMessage } from "../debug";
import type { OAuthAuthDetails, TokenExchangeResult } from "../types";

export interface OAuthAuthorization {
  url: string;
  /** PKCE verifier handed back to `exchangeFn`; empty when the client uses none. */
  verifier: string;
  state: string;
}

export interface OAuthAuthorizeMethodOptions {
  authorizeFn: () => Promise<OAuthAuthorization>;
  exchangeFn: (code: string, verifier: string) => Promise<TokenExchangeResult>;
  /** Runs once tokens are in hand (e.g. registration); may rewrite the stored refresh string. */
  resolveProjectContextFn?: (auth: OAuthAuthDetails, accessToken: string) => Promise<{ auth: OAuthAuthDetails }>;
}

/**
 * Builds the OAuth authorize callback: OpenCode shows the provider's URL, the provider's page
 * shows the authorization code, and the user pastes it. Same flow on a desktop and over SSH:
 * no local listener, no browser started from here.
 */
export function createOAuthAuthorizeMethod(options: OAuthAuthorizeMethodOptions): () => Promise<{
  url: string;
  instructions: string;
  callback: (pasted: string) => Promise<TokenExchangeResult>;
}> {
  const { authorizeFn, exchangeFn, resolveProjectContextFn } = options;

  return async () => {
    const maybeHydrateProjectId = async (result: TokenExchangeResult): Promise<TokenExchangeResult> => {
      if (result.type !== "success" || !result.access || !resolveProjectContextFn) {
        return result;
      }
      try {
        const authSnapshot = {
          type: "oauth",
          refresh: result.refresh,
          access: result.access,
          expires: result.expires,
        } satisfies OAuthAuthDetails;
        const { auth } = await resolveProjectContextFn(authSnapshot, result.access);
        if (auth.refresh !== result.refresh && isGeminiDebugEnabled()) {
          logGeminiDebugMessage("OAuth project resolved during auth");
        }
        return auth.refresh !== result.refresh ? { ...result, refresh: auth.refresh } : result;
      } catch (error) {
        if (isGeminiDebugEnabled()) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[leprota.google-auth] Project resolution skipped: ${message}`);
        }
        return result;
      }
    };

    // One verifier and one state per sign-in, kept with its own callback.
    const signIn = await authorizeFn();
    let submitted: { code: string; result: Promise<TokenExchangeResult> } | undefined;

    return {
      url: signIn.url,
      instructions: "Paste the authorization code here:",
      callback: async (pasted: string): Promise<TokenExchangeResult> => {
        try {
          if (pasted.length > 16 * 1024) {
            return { type: "failed", error: "The pasted authorization input is too long" };
          }
          const { code, state, error } = parseOAuthCallbackInput(pasted);
          if (state !== undefined && state !== signIn.state) {
            return { type: "failed", error: "State mismatch in callback input (possible CSRF attempt)" };
          }
          if (error) {
            return { type: "failed", error: "Google authorization failed or was cancelled. Start a new sign-in." };
          }
          if (!code) {
            return { type: "failed", error: "Missing authorization code in callback input" };
          }
          // RFC 6749 Appendix A: a code is 1*VSCHAR; anything else was not copied from the provider.
          if (!/^[\x20-\x7e]{1,4096}$/.test(code)) {
            return { type: "failed", error: "The pasted text is not an authorization code" };
          }
          // The provider's page shows the code without the state: only PKCE ties it to this sign-in.
          if (!state && !signIn.verifier) {
            return { type: "failed", error: "Paste the full redirected URL (it carries the state that ties it to this sign-in)" };
          }
          if (submitted) {
            return code === submitted.code
              ? await submitted.result
              : { type: "failed", error: "This sign-in has already submitted a code. Start a new sign-in." };
          }
          // A response lost after sending may already have consumed the code.
          const result = (async (): Promise<TokenExchangeResult> => {
            try {
              return await maybeHydrateProjectId(await exchangeFn(code, signIn.verifier));
            } catch {
              return { type: "failed", error: "Google code exchange failed. Start a new sign-in." };
            }
          })();
          submitted = { code, result };
          return await result;
        } catch (error) {
          return {
            type: "failed",
            error: "Invalid authorization input",
          };
        }
      },
    };
  };
}

function parseOAuthCallbackInput(input: string): {
  code?: string;
  state?: string;
  error?: string;
} {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (["code", "state", "error"].some((key) => url.searchParams.getAll(key).length > 1)) {
        return { error: "invalid_callback" };
      }
      return {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") ?? undefined,
        error: url.searchParams.get("error") || undefined,
      };
    } catch {
      return {};
    }
  }

  const candidate = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
  if (candidate.includes("=")) {
    const params = new URLSearchParams(candidate);
    if (["code", "state", "error"].some((key) => params.getAll(key).length > 1)) {
      return { error: "invalid_callback" };
    }
    const code = params.get("code") || undefined;
    const state = params.get("state") ?? undefined;
    const error = params.get("error") || undefined;
    if (code || state || error) {
      return { code, state, error };
    }
  }

  return { code: trimmed };
}
