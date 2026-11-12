/**
 * Antigravity (Google AI Pro / Ultra subscription) pipeline for OpenCode.
 *
 * Wire format and constants come from the vendored dsh-gemini-oauth-bridge
 * `lib/protocol.js` (see ./upstream.ts for the commit). The host-side logic below
 * (version tracking, token refresh, loadCodeAssist/onboardUser, model catalog)
 * is a port of that repo's `lib/index.js`, minus the DSH-specific parts.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GEMINI_CODE_ASSIST_ENDPOINT } from "../constants";
import { geminiFetch } from "../fetch";
import type { GeminiTokenExchangeResult } from "../gemini/oauth";
import { formatRefreshParts, parseRefreshParts } from "../plugin/auth";
import { getGeminiPluginDataDir } from "../plugin/storage-paths";
import type { OAuthAuthDetails } from "../plugin/types";
import { DSH_BRIDGE_UPSTREAM } from "./upstream";
import {
  API,
  OAUTH,
  VERSION,
  antigravityEnvelope,
  parseAvailableModels,
  parseVersionManifest,
  resolveTier,
  stableSessionId,
  tokenExchangeForm,
  tokenRefreshForm,
  userAgents,
} from "./vendor/protocol.js";

export const ANTIGRAVITY_PROVIDER_ID = "google-antigravity";

/** Same placeholder list the bridge uses until fetchAvailableModels succeeds. */
export const DEFAULT_MODELS = ["gemini-3.1-pro-high", "gemini-3.7-flash-high", "gemini-3.1-pro-low", "gemini-3-flash"];

const VERSION_TTL_MS = 6 * 60 * 60 * 1000;
const VERSION_MEMO_MS = 10 * 60 * 1000;
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelCaps {
  contextLength?: number;
  maxCompletionTokens?: number;
  supportsImages?: boolean;
}

export interface AntigravityCache {
  version?: string;
  versionFetchedAt?: number;
  models?: string[];
  modelCaps?: Record<string, ModelCaps>;
  updateCheckedAt?: number;
  upstreamSha?: string;
}

// ---------------------------------------------------------------------------
// Non-secret local cache (client version, model catalog, update check)
// ---------------------------------------------------------------------------

const cachePath = () => join(getGeminiPluginDataDir(), "antigravity.json");

export async function readCache(): Promise<AntigravityCache> {
  try {
    return JSON.parse(await readFile(cachePath(), "utf8")) as AntigravityCache;
  } catch {
    return {};
  }
}

async function writeCache(patch: AntigravityCache): Promise<void> {
  try {
    const next = { ...(await readCache()), ...patch };
    await mkdir(getGeminiPluginDataDir(), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(next, null, 2));
  } catch {}
}

// ---------------------------------------------------------------------------
// Client version tracking (the bridge's anti-drift User-Agent)
// ---------------------------------------------------------------------------

let versionMemo: { value: Promise<string>; expires: number } | undefined;

export function currentVersion(): Promise<string> {
  if (!versionMemo || Date.now() > versionMemo.expires) {
    versionMemo = { value: loadVersion(), expires: Date.now() + VERSION_MEMO_MS };
  }
  return versionMemo.value;
}

async function loadVersion(): Promise<string> {
  const now = Date.now();
  const cache = await readCache();
  const cacheAge = now - (cache.versionFetchedAt ?? 0);
  if (cache.version && cacheAge < VERSION_TTL_MS) return cache.version;
  try {
    const res = await geminiFetch(VERSION.manifestUrl, {
      headers: { "User-Agent": "electron-builder", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(10_000),
    });
    const version = res.status === 200 ? parseVersionManifest(await res.text()) : null;
    if (version) {
      await writeCache({ version, versionFetchedAt: now });
      return version;
    }
  } catch {}
  return cache.version && cacheAge < VERSION_TTL_MS * 4 ? cache.version : VERSION.fallback;
}

// ---------------------------------------------------------------------------
// Upstream helpers
// ---------------------------------------------------------------------------

async function upstreamJson(
  url: string,
  { token, ua, body, method = "POST", timeoutMs = 15_000 }: {
    token?: string;
    ua: string;
    body?: unknown;
    method?: string;
    timeoutMs?: number;
  },
): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "*/*", "User-Agent": ua };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await geminiFetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
}

function extractProject(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = (data as Record<string, any>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object" && typeof value.id === "string" && value.id.trim()) return value.id.trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// OAuth token exchange / refresh
// ---------------------------------------------------------------------------

/** Matches `exchangeGeminiWithVerifier`'s shape; Antigravity's client uses no PKCE. */
export async function exchangeCode(code: string): Promise<GeminiTokenExchangeResult> {
  try {
    const ua = userAgents(await currentVersion());
    const res = await geminiFetch(OAUTH.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua.refresh },
      body: tokenExchangeForm(code).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) return { type: "failed", error: text };
    const tokens = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number };
    if (!tokens.refresh_token) return { type: "failed", error: "Missing refresh token in response" };
    let email: string | undefined;
    try {
      const info = await upstreamJson(OAUTH.userinfoEndpoint, { method: "GET", token: tokens.access_token, ua: ua.short });
      email = info.json?.email;
    } catch {}
    return {
      type: "success",
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      email,
    };
  } catch (error) {
    return { type: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

const refreshInFlight = new Map<string, Promise<OAuthAuthDetails>>();

/** Single-flight refresh per refresh token; persists the new access token. */
export function refreshAuth(
  auth: OAuthAuthDetails,
  persist: (auth: OAuthAuthDetails) => Promise<void>,
): Promise<OAuthAuthDetails> {
  const parts = parseRefreshParts(auth.refresh);
  const pending = refreshInFlight.get(parts.refreshToken);
  if (pending) return pending;
  const run = (async () => {
    const ua = userAgents(await currentVersion());
    const res = await geminiFetch(OAUTH.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua.refresh },
      body: tokenRefreshForm(parts.refreshToken).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (res.status === 400) {
      throw new Error(
        `Antigravity refresh token rejected (${text.slice(0, 200)}). Run \`opencode auth login\` and pick Google (Antigravity) again.`,
      );
    }
    if (!res.ok) throw new Error(`Antigravity token refresh failed (${res.status}): ${text.slice(0, 200)}`);
    const json = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number };
    const next: OAuthAuthDetails = {
      ...auth,
      access: json.access_token,
      expires: Date.now() + (Number(json.expires_in) || 3600) * 1000,
      refresh: formatRefreshParts({ ...parts, refreshToken: json.refresh_token || parts.refreshToken }),
    };
    await persist(next);
    return next;
  })().finally(() => refreshInFlight.delete(parts.refreshToken));
  refreshInFlight.set(parts.refreshToken, run);
  return run;
}

// ---------------------------------------------------------------------------
// Registration (loadCodeAssist / onboardUser) and model catalog
// ---------------------------------------------------------------------------

export async function resolveProject(accessToken: string): Promise<string> {
  const ua = userAgents(await currentVersion());
  const load = await upstreamJson(`${API.prodBase}${API.loadCodeAssistPath}`, {
    token: accessToken,
    ua: ua.short,
    body: { metadata: { ideType: "ANTIGRAVITY" } },
  });
  if (load.status !== 200) {
    throw new Error(`Antigravity loadCodeAssist failed (${load.status}): ${load.text.slice(0, 200)}`);
  }
  const existing = extractProject(load.json);
  if (existing) return existing;

  const tierId = resolveTier(load.json);
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await upstreamJson(`${API.dailyBase}${API.onboardUserPath}`, {
      token: accessToken,
      ua: ua.long,
      body: { tier_id: tierId, cloudaicompanionProject: "", metadata: { ideType: "ANTIGRAVITY" } },
      timeoutMs: 20_000,
    });
    if (res.status !== 200) {
      throw new Error(`Antigravity onboardUser failed (${res.status}): ${res.text.slice(0, 200)}`);
    }
    const project = extractProject(res.json?.response) || extractProject(res.json);
    if (project) return project;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Antigravity onboardUser did not complete in time");
}

/** Internal routing ids (`chat_*`, `tab_*`) upstream answers with 400. */
export function isPublishableModelId(id: string): boolean {
  return !!id && !/^(chat_|tab_)/.test(id);
}

/** Refreshes the cached catalog; the new list is registered on the next OpenCode start. */
export async function refreshModels(accessToken: string, project: string): Promise<string[] | undefined> {
  const ua = userAgents(await currentVersion());
  for (const base of [API.prodBase, API.dailyBase]) {
    try {
      const res = await upstreamJson(`${base}${API.fetchModelsPath}`, {
        token: accessToken,
        ua: ua.short,
        body: project ? { project } : {},
        timeoutMs: 20_000,
      });
      if (res.status !== 200 || !res.json?.models) continue;
      const { ids, caps } = parseAvailableModels(res.json);
      const models = ids.filter(isPublishableModelId);
      if (!models.length) continue;
      await writeCache({ models, modelCaps: caps as Record<string, ModelCaps> });
      return models;
    } catch {}
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Request rewrite: Gemini CLI Code Assist request -> Antigravity envelope
// ---------------------------------------------------------------------------

function firstUserText(contents: unknown): string {
  if (!Array.isArray(contents)) return "";
  const first = contents.find((c) => c && typeof c === "object" && c.role !== "model");
  if (!first || !Array.isArray(first.parts)) return "";
  return first.parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("");
}

/**
 * Takes the output of `prepareGeminiRequest` (already sanitized for Code Assist)
 * and re-targets it at the Antigravity surface the bridge speaks.
 */
export function toAntigravityRequest(
  url: string,
  init: RequestInit,
  project: string,
  version: string,
): { url: string; init: RequestInit } {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", userAgents(version).short);
  headers.delete("x-activity-request-id"); // Gemini CLI fingerprint, not sent by Antigravity

  const action = url.match(/v1internal:(\w+)/)?.[1];
  let body = init.body;
  if ((action === "generateContent" || action === "streamGenerateContent") && typeof body === "string") {
    const wrapped = JSON.parse(body) as { model: string; request?: Record<string, unknown> };
    const { session_id: _ignored, ...request } = wrapped.request ?? {};
    // One upstream session per conversation, derived like the bridge does.
    const sessionId = stableSessionId([{ role: "user", content: firstUserText(request.contents) }]);
    body = JSON.stringify(antigravityEnvelope(wrapped.model, project, request, sessionId));
  }

  return {
    url: url.replace(GEMINI_CODE_ASSIST_ENDPOINT, API.dailyBase),
    init: { ...init, headers, body },
  };
}

// ---------------------------------------------------------------------------
// Upstream update check (notice only: never downloads or runs code)
// ---------------------------------------------------------------------------

export async function checkBridgeUpdate(notify: (message: string) => void): Promise<void> {
  if (process.env.OPENCODE_ANTIGRAVITY_UPDATE_CHECK === "0") return;
  const vendored = DSH_BRIDGE_UPSTREAM.sha;
  const cache = await readCache();
  let latest = cache.upstreamSha;
  if (Date.now() - (cache.updateCheckedAt ?? 0) >= UPDATE_CHECK_TTL_MS) {
    try {
      const res = await geminiFetch(
        `https://api.github.com/repos/${DSH_BRIDGE_UPSTREAM.repo}/commits?path=lib&per_page=1`,
        {
          headers: { "User-Agent": "opencode-gemini-auth", Accept: "application/vnd.github+json" },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (res.ok) {
        const [commit] = (await res.json()) as Array<{ sha?: string }>;
        latest = commit?.sha;
        await writeCache({ updateCheckedAt: Date.now(), upstreamSha: latest });
      }
    } catch {}
  }
  if (latest && latest !== vendored) {
    notify(
      `${DSH_BRIDGE_UPSTREAM.repo} changed its pipeline (${latest.slice(0, 7)}, vendored ${vendored.slice(0, 7)}). ` +
        "Run `npm run update:dsh-bridge` in the plugin repo, review the diff, and rebuild.",
    );
  }
}
