/** Request rewrite: Gemini CLI Code Assist request -> Antigravity envelope. */
import { GEMINI_CODE_ASSIST_ENDPOINT } from "./constants";
import { API, splitEffortModelId } from "./vendor/protocol.js";
import { antigravityEnvelope, userAgents } from "./wire";

/**
 * Asks upstream to stream the reasoning text (`thought: true` parts, which OpenCode
 * shows as reasoning). Upstream ignores `includeThoughts` on its own: like CLIProxyAPI,
 * pair it with a level (Gemini 3, from the `-low/-medium/-high` id suffix) or a budget.
 */
export function withThoughts(model: string, request: Record<string, any>): Record<string, any> {
  if (model.includes("image")) return request;
  const generationConfig = request.generationConfig ?? {};
  const current = generationConfig.thinkingConfig ?? {};
  if (current.includeThoughts === false) return request;
  const thinkingConfig: Record<string, unknown> = { ...current, includeThoughts: true };
  if (current.thinkingLevel === undefined && current.thinkingBudget === undefined) {
    // The upstream id carries the effort (`gemini-3.8-flash-low`).
    const idEffort = splitEffortModelId(model)?.effort;
    if (/gemini-3/.test(model)) thinkingConfig.thinkingLevel = idEffort === "medium" || idEffort === "low" ? idEffort : "high";
    else thinkingConfig.thinkingBudget = -1; // dynamic (Gemini 2.5)
  }
  return { ...request, generationConfig: { ...generationConfig, thinkingConfig } };
}

/**
 * Takes the output of `prepareGeminiRequest` (already sanitized for Code Assist)
 * and re-targets it at the Antigravity surface.
 */
export function toAntigravityRequest(
  url: string,
  init: RequestInit,
  project: string,
  version: string,
): { url: string; init: RequestInit } {
  // The request is rebuilt from the client profile: CLIProxyAPI's Antigravity request carries
  // these three headers, plus Accept for SSE. Whatever the host or its SDK added (their own
  // User-Agent, x-goog-api-client, headers describing the body before the rewrite) stays here.
  const headers = new Headers({ "User-Agent": userAgents(version).short });
  const authorization = new Headers(init.headers).get("Authorization");
  if (authorization) headers.set("Authorization", authorization);
  if (init.body != null) headers.set("Content-Type", "application/json");
  if (url.includes("alt=sse")) headers.set("Accept", "text/event-stream");

  const action = url.match(/v1internal:(\w+)/)?.[1];
  let body = init.body;
  if ((action === "generateContent" || action === "streamGenerateContent") && typeof body === "string") {
    const wrapped = JSON.parse(body) as { model: string; request?: Record<string, unknown> };
    // Drop the Gemini CLI per-process session_id; the envelope derives one per conversation.
    const { session_id: _ignored, ...request } = wrapped.request ?? {};
    body = JSON.stringify(antigravityEnvelope(wrapped.model, project, withThoughts(wrapped.model, request)));
  }

  const target = url.replace(GEMINI_CODE_ASSIST_ENDPOINT, API.dailyBase);
  if (!isTrustedGoogleUrl(target)) {
    throw new Error("Refusing to send Google OAuth credentials to an untrusted origin");
  }
  return { url: target, init: { ...init, headers, body, redirect: "error" } };
}

const TRUSTED_ORIGINS = new Set([API.dailyBase, API.prodBase]);

/** The bearer token only ever goes to the two Cloud Code hosts. */
export function isTrustedGoogleUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.username === "" && url.password === "" && TRUSTED_ORIGINS.has(url.origin);
  } catch {
    return false;
  }
}
