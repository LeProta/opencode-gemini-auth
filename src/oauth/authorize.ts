import { spawn } from "node:child_process";

import { isGeminiDebugEnabled, logGeminiDebugMessage } from "../debug";
import {
  startOAuthListener,
  type OAuthCallbackResponse,
  type OAuthListener,
} from "./server";
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
  timeoutMs?: number;
  redirectUri?: string;
  isHeadless?: () => boolean;
  openBrowser?: (url: string) => void;
  startListenerFn?: typeof startOAuthListener;
}

/**
 * Builds the OAuth authorize callback: local callback listener when possible,
 * pasted redirect URL or code otherwise.
 */
export function createOAuthAuthorizeMethod(options: OAuthAuthorizeMethodOptions): () => Promise<
  {
    url: string;
    instructions: string;
  } & (
    | { method: "auto"; callback: () => Promise<TokenExchangeResult> }
    | { method: "code"; callback: (callbackUrl: string) => Promise<TokenExchangeResult> }
  )
> {
  const { authorizeFn, exchangeFn, resolveProjectContextFn } = options;
  const startListenerFn = options.startListenerFn ?? startOAuthListener;
  const openBrowser = options.openBrowser ?? openBrowserUrl;

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

    const isHeadless =
      options.isHeadless?.() ??
      !!(
        process.env.SSH_CONNECTION ||
        process.env.SSH_CLIENT ||
        process.env.SSH_TTY ||
        process.env.OPENCODE_HEADLESS
      );

    const authorization = await authorizeFn();

    let settled = false;
    let exchangeInFlight = false;
    let finalResult: TokenExchangeResult | undefined;

    const handleCallbackUrl = async (callbackUrl: URL): Promise<OAuthCallbackResponse> => {
      if (settled) {
        return {
          ok: finalResult?.type === "success",
          terminal: false,
          status: finalResult?.type === "success" ? 200 : 400,
          message:
            finalResult?.type === "failed"
              ? finalResult.error
              : "OAuth sign-in has already completed.",
        };
      }

      const callbackError = callbackUrl.searchParams.get("error");
      const callbackErrorDescription = callbackUrl.searchParams.get("error_description");
      if (callbackError) {
        const errorMessage = callbackErrorDescription || callbackError;
        settled = true;
        finalResult = { type: "failed", error: errorMessage };
        return { ok: false, terminal: true, status: 400, message: errorMessage };
      }

      const code = callbackUrl.searchParams.get("code");
      const state = callbackUrl.searchParams.get("state");
      if (!code || !state) {
        return {
          ok: false,
          terminal: false,
          status: 400,
          message: "Missing authorization code or state.",
        };
      }

      if (state !== authorization.state) {
        if (isGeminiDebugEnabled()) {
          logGeminiDebugMessage("Ignoring OAuth callback with mismatched state");
        }
        return {
          ok: false,
          terminal: false,
          status: 400,
          message: "Invalid OAuth state parameter. Return to the sign-in flow and try again.",
        };
      }

      if (exchangeInFlight) {
        return {
          ok: false,
          terminal: false,
          status: 409,
          message: "OAuth callback exchange is already in progress.",
        };
      }

      exchangeInFlight = true;
      try {
        const exchangeResult = await exchangeFn(code, authorization.verifier);
        if (shouldIgnoreMalformedAuthCode(exchangeResult)) {
          if (isGeminiDebugEnabled()) {
            logGeminiDebugMessage(
              "Ignoring malformed OAuth callback code and waiting for the next redirect",
            );
          }
          return {
            ok: false,
            terminal: false,
            status: 400,
            message: "Malformed authorization code. Waiting for valid redirect.",
          };
        }

        if (exchangeResult.type === "failed") {
          settled = true;
          finalResult = exchangeResult;
          return {
            ok: false,
            terminal: true,
            status: 502,
            message: exchangeResult.error,
          };
        }

        const hydrated = await maybeHydrateProjectId(exchangeResult);
        settled = true;
        finalResult = hydrated;
        return { ok: true, terminal: true, status: 200 };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        settled = true;
        finalResult = { type: "failed", error: errorMessage };
        return { ok: false, terminal: true, status: 502, message: errorMessage };
      } finally {
        exchangeInFlight = false;
      }
    };

    let listener: OAuthListener | null = null;
    if (!isHeadless) {
      try {
        listener = await startListenerFn({
          timeoutMs: options.timeoutMs,
          redirectUri: options.redirectUri,
          onCallback: handleCallbackUrl,
        });
      } catch (error) {
        const detail = error instanceof Error ? ` (${error.message})` : "";
        console.log(
          `Warning: Couldn't start the local callback listener${detail}. You'll need to paste the callback URL or authorization code.`,
        );
      }
    } else {
      console.log(
        "Headless environment detected. You'll need to paste the callback URL or authorization code.",
      );
    }

    if (!isHeadless) {
      openBrowser(authorization.url);
    }

    if (listener) {
      return {
        url: authorization.url,
        instructions:
          "Complete the sign-in flow in your browser. We'll automatically detect the redirect back to localhost.",
        method: "auto",
        callback: async (): Promise<TokenExchangeResult> => {
          try {
            await listener.waitForCallback();
            return (
              finalResult ?? {
                type: "failed",
                error: "OAuth listener exited without producing credentials",
              }
            );
          } catch (error) {
            return {
              type: "failed",
              error: error instanceof Error ? error.message : "Unknown error",
            };
          } finally {
            try {
              await listener?.close();
            } catch {}
          }
        },
      };
    }

    return {
      url: authorization.url,
      instructions:
        `Complete OAuth in your browser, then paste the full redirected URL from the address bar (e.g., ${options.redirectUri ?? "http://localhost:<port>/callback"}?code=...&state=...).`,
      method: "code",
      callback: async (callbackUrl: string): Promise<TokenExchangeResult> => {
        try {
          const { code, state, error, errorDescription } = parseOAuthCallbackInput(callbackUrl);
          if (error) {
            return { type: "failed", error: errorDescription || error };
          }
          if (!code) {
            return { type: "failed", error: "Missing authorization code in callback input" };
          }
          // A bare code cannot be tied to this sign-in, so the state is required.
          if (!state) {
            return { type: "failed", error: "Paste the full redirected URL (it carries the state that ties it to this sign-in)" };
          }
          if (state !== authorization.state) {
            return { type: "failed", error: "State mismatch in callback input (possible CSRF attempt)" };
          }
          return await maybeHydrateProjectId(
            await exchangeFn(code, authorization.verifier),
          );
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

function openBrowserUrl(url: string): void {
  try {
    const platform = process.platform;
    const command =
      platform === "darwin" ? "open" : platform === "win32" ? "rundll32" : "xdg-open";
    const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref?.();
  } catch {}
}

function shouldIgnoreMalformedAuthCode(result: TokenExchangeResult): boolean {
  if (result.type !== "failed") {
    return false;
  }

  return /invalid_grant/i.test(result.error) && /malformed auth code/i.test(result.error);
}
