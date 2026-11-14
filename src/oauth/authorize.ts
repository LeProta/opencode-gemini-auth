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

    return {
      url: signIn.url,
      instructions: "Paste the authorization code here:",
      callback: async (pasted: string): Promise<TokenExchangeResult> => {
        try {
          const { code, state, error, errorDescription } = parseOAuthCallbackInput(pasted);
          if (error) {
            return { type: "failed", error: errorDescription || error };
          }
          if (!code) {
            return { type: "failed", error: "Missing authorization code in callback input" };
          }
          // RFC 6749 Appendix A: a code is 1*VSCHAR; anything else was not copied from the provider.
          if (!/^[\x20-\x7e]{1,4096}$/.test(code)) {
            return { type: "failed", error: "The pasted text is not an authorization code" };
          }
          if (state && state !== signIn.state) {
            return { type: "failed", error: "State mismatch in callback input (possible CSRF attempt)" };
          }
          // The provider's page shows the code without the state: only PKCE ties it to this sign-in.
          if (!state && !signIn.verifier) {
            return { type: "failed", error: "Paste the full redirected URL (it carries the state that ties it to this sign-in)" };
          }
          return await maybeHydrateProjectId(await exchangeFn(code, signIn.verifier));
        } catch (error) {
          return {
            type: "failed",
            error: error instanceof Error ? error.message : "Unknown error",
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
  errorDescription?: string;
} {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
        errorDescription: url.searchParams.get("error_description") || undefined,
      };
    } catch {
      return {};
    }
  }

  const candidate = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
  if (candidate.includes("=")) {
    const params = new URLSearchParams(candidate);
    const code = params.get("code") || undefined;
    const state = params.get("state") || undefined;
    const error = params.get("error") || undefined;
    const errorDescription = params.get("error_description") || undefined;
    if (code || state || error) {
      return { code, state, error, errorDescription };
    }
  }

  return { code: trimmed };
}
