import { spawn } from "node:child_process";

import { authorizeGemini, exchangeGeminiWithVerifier } from "../gemini/oauth";
import type { GeminiTokenExchangeResult } from "../gemini/oauth";
import { isGeminiDebugEnabled, logGeminiDebugMessage } from "./debug";
import { resolveProjectContextFromAccessToken } from "./project";
import { resolveConfiguredProjectId } from "./provider";
import {
  startOAuthListener,
  type OAuthCallbackResponse,
  type OAuthListener,
} from "./server";
import type { OAuthAuthDetails } from "./types";

export interface OAuthAuthorizeInputs {
  projectId?: unknown;
  [key: string]: unknown;
}

export interface OAuthAuthorizeMethodOptions {
  getConfiguredProjectId?: () => Promise<string | undefined> | string | undefined;
  getUserAgentModel?: () => Promise<string | undefined> | string | undefined;
  timeoutMs?: number;
  redirectUri?: string;
  isHeadless?: () => boolean;
  openBrowser?: (url: string) => void;
  authorizeFn?: typeof authorizeGemini;
  exchangeFn?: typeof exchangeGeminiWithVerifier;
  resolveProjectContextFn?: typeof resolveProjectContextFromAccessToken;
  startListenerFn?: typeof startOAuthListener;
}

/**
 * Builds the OAuth authorize callback used by plugin auth methods.
 */
export function createOAuthAuthorizeMethod(options?: OAuthAuthorizeMethodOptions): (
  inputs?: OAuthAuthorizeInputs,
) => Promise<
  {
    url: string;
    instructions: string;
  } & (
    | { method: "auto"; callback: () => Promise<GeminiTokenExchangeResult> }
    | { method: "code"; callback: (callbackUrl: string) => Promise<GeminiTokenExchangeResult> }
  )
> {
  const authorizeFn = options?.authorizeFn ?? authorizeGemini;
  const exchangeFn = options?.exchangeFn ?? exchangeGeminiWithVerifier;
  const resolveProjectContextFn =
    options?.resolveProjectContextFn ?? resolveProjectContextFromAccessToken;
  const startListenerFn = options?.startListenerFn ?? startOAuthListener;
  const openBrowser = options?.openBrowser ?? openBrowserUrl;

  return async (inputs?: OAuthAuthorizeInputs) => {
    const inputProjectId =
      typeof inputs?.projectId === "string" && inputs.projectId.trim()
        ? inputs.projectId.trim()
        : undefined;

    const maybeHydrateProjectId = async (
      result: GeminiTokenExchangeResult,
    ): Promise<GeminiTokenExchangeResult> => {
      if (result.type !== "success" || !result.access) {
        return result;
      }

      const configuredProjectId =
        inputProjectId ??
        resolveConfiguredProjectId({
          configProjectId: await options?.getConfiguredProjectId?.(),
        });

      try {
        const authSnapshot = {
          type: "oauth",
          refresh: result.refresh,
          access: result.access,
          expires: result.expires,
        } satisfies OAuthAuthDetails;
        const projectContext = await resolveProjectContextFn(
          authSnapshot,
          result.access,
          configuredProjectId,
          undefined,
          await options?.getUserAgentModel?.(),
        );

        if (projectContext.auth.refresh !== result.refresh && isGeminiDebugEnabled()) {
          logGeminiDebugMessage(
            `OAuth project resolved during auth: ${projectContext.effectiveProjectId || "none"}`,
          );
        }
        return projectContext.auth.refresh !== result.refresh
          ? { ...result, refresh: projectContext.auth.refresh }
          : result;
      } catch (error) {
        if (isGeminiDebugEnabled()) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[Gemini OAuth] Project resolution skipped: ${message}`);
        }
        return result;
      }
    };

    const isHeadless =
      options?.isHeadless?.() ??
      !!(
        process.env.SSH_CONNECTION ||
        process.env.SSH_CLIENT ||
        process.env.SSH_TTY ||
        process.env.OPENCODE_HEADLESS
      );

    const authorization = await authorizeFn();

    let settled = false;
    let exchangeInFlight = false;
    let finalResult: GeminiTokenExchangeResult | undefined;

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
          timeoutMs: options?.timeoutMs,
          redirectUri: options?.redirectUri,
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
        callback: async (): Promise<GeminiTokenExchangeResult> => {
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
        "Complete OAuth in your browser, then paste the full redirected URL (e.g., http://localhost:8085/oauth2callback?code=...&state=...) or just the authorization code.",
      method: "code",
      callback: async (callbackUrl: string): Promise<GeminiTokenExchangeResult> => {
        try {
          const { code, state, error, errorDescription } = parseOAuthCallbackInput(callbackUrl);
          if (error) {
            return { type: "failed", error: errorDescription || error };
          }
          if (!code) {
            return { type: "failed", error: "Missing authorization code in callback input" };
          }
          if (state && state !== authorization.state) {
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

function shouldIgnoreMalformedAuthCode(result: GeminiTokenExchangeResult): boolean {
  if (result.type !== "failed") {
    return false;
  }

  return /invalid_grant/i.test(result.error) && /malformed auth code/i.test(result.error);
}
