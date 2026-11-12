/**
 * Antigravity (Google AI Pro / Ultra subscription) pipeline for OpenCode.
 *
 * Drifting wire details (User-Agent, registration, envelope) follow CLIProxyAPI,
 * see ./wire.ts. Stable helpers (OAuth client, forms, manifest and catalog
 * parsing) come from the vendored dsh-gemini-oauth-bridge `lib/protocol.js`.
 * The host logic below started as a port of that bridge's `lib/index.js`.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GEMINI_CODE_ASSIST_ENDPOINT } from "../constants";
import { geminiFetch } from "../fetch";
import { formatRefreshParts, parseRefreshParts } from "../plugin/auth";
import { getGeminiPluginDataDir } from "../plugin/storage-paths";
import type { OAuthAuthDetails, TokenExchangeResult } from "../plugin/types";
import { CLIPROXY_UPSTREAM } from "./upstream";
import {
  API,
  OAUTH,
  VERSION,
  parseAvailableModels,
  parseQuotaSummary,
  parseVersionManifest,
  splitEffortModelId,
  tokenExchangeForm,
  tokenRefreshForm,
} from "./vendor/protocol.js";
import { FALLBACK_VERSION, GOOG_API_CLIENT, antigravityEnvelope, defaultTierId, onboardBody, userAgents } from "./wire";

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
  upstreamShas?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Non-secret local cache (client version, model catalog, update check)
// ---------------------------------------------------------------------------

const cachePath = () => join(getGeminiPluginDataDir(), "antigravity.json");
const STORAGE_KEY = "antigravity-cache";

export interface CacheStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: any): Promise<void>;
}

let storage: CacheStorage | undefined;
let memo: Promise<AntigravityCache> | undefined;

/** OpenCode V2: keep the cache in the plugin's storage instead of a file of our own. */
export function useCacheStorage(next: CacheStorage): void {
  if (storage) return;
  storage = next;
  memo = undefined;
}

async function readFileCache(): Promise<AntigravityCache> {
  try {
    return JSON.parse(await readFile(cachePath(), "utf8")) as AntigravityCache;
  } catch {
    return {};
  }
}

async function loadCache(): Promise<AntigravityCache> {
  if (!storage) return readFileCache();
  try {
    const stored = await storage.get(STORAGE_KEY);
    if (stored && typeof stored === "object") return stored as AntigravityCache;
  } catch {}
  return readFileCache(); // one-time migration from the old file
}

export function readCache(): Promise<AntigravityCache> {
  memo ??= loadCache();
  return memo;
}

async function writeCache(patch: AntigravityCache): Promise<void> {
  const next = { ...(await readCache()), ...patch };
  memo = Promise.resolve(next);
  try {
    if (storage) {
      await storage.set(STORAGE_KEY, next);
      return;
    }
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
  return cache.version && cacheAge < VERSION_TTL_MS * 4 ? cache.version : FALLBACK_VERSION;
}

// ---------------------------------------------------------------------------
// Upstream helpers
// ---------------------------------------------------------------------------

async function upstreamJson(
  url: string,
  { token, ua, body, method = "POST", timeoutMs = 15_000, extraHeaders }: {
    token?: string;
    ua: string;
    extraHeaders?: Record<string, string>;
    body?: unknown;
    method?: string;
    timeoutMs?: number;
  },
): Promise<{ status: number; text: string; json: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "*/*", "User-Agent": ua, ...extraHeaders };
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
export async function exchangeCode(code: string): Promise<TokenExchangeResult> {
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
  const version = await currentVersion();
  const ua = userAgents(version);
  const load = await upstreamJson(`${API.dailyBase}${API.loadCodeAssistPath}`, {
    token: accessToken,
    ua: ua.short,
    body: { metadata: { ideType: "ANTIGRAVITY" } },
  });
  if (load.status !== 200) {
    throw new Error(`Antigravity loadCodeAssist failed (${load.status}): ${load.text.slice(0, 200)}`);
  }
  const existing = extractProject(load.json);
  if (existing) return existing;

  const tierId = defaultTierId(load.json);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await upstreamJson(`${API.dailyBase}${API.onboardUserPath}`, {
      token: accessToken,
      ua: ua.long,
      body: onboardBody(tierId, version),
      extraHeaders: { "X-Goog-Api-Client": GOOG_API_CLIENT },
      timeoutMs: 30_000,
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

/** Refreshes the cached catalog. Returns the publishable ids, or undefined when upstream gave none. */
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

/** Subscription quota pools (weekly / 5-hour windows), as the bridge reads them. */
export async function fetchQuotaSummary(accessToken: string, project: string): Promise<QuotaSummary | null> {
  const ua = userAgents(await currentVersion());
  for (const base of [API.dailyBase, API.prodBase]) {
    try {
      const res = await upstreamJson(`${base}${API.quotaSummaryPath}`, {
        token: accessToken,
        ua: ua.short,
        body: project ? { project } : {},
      });
      if (res.status !== 200) continue;
      const summary = parseQuotaSummary(res.json) as QuotaSummary | null;
      if (summary) return summary;
    } catch {}
  }
  return null;
}

export interface QuotaSummary {
  description: string;
  groups: Array<{
    name: string;
    description: string;
    buckets: Array<{ name: string; window: string; remaining: number | null; resetAt: number | null; disabled: boolean }>;
  }>;
}

export function formatQuotaSummary(summary: QuotaSummary, now = Date.now()): string {
  const lines = ["Google subscription quota:"];
  for (const group of summary.groups) {
    lines.push("", `${group.name || "Models"}`);
    for (const bucket of group.buckets) {
      const label = bucket.name || bucket.window || "quota";
      const left = bucket.disabled ? "inactive" : bucket.remaining === null ? "unknown" : `${Math.round(bucket.remaining * 100)}% left`;
      const reset = bucket.resetAt ? `, resets in ${formatDuration(bucket.resetAt - now)}` : "";
      lines.push(`- ${label}: ${left}${reset}`);
    }
  }
  return lines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.round(hours / 24)} days`;
}

// ---------------------------------------------------------------------------
// Request rewrite: Gemini CLI Code Assist request -> Antigravity envelope
// ---------------------------------------------------------------------------

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
  const headers = new Headers(init.headers);
  headers.set("User-Agent", userAgents(version).short);
  headers.delete("x-activity-request-id"); // Gemini CLI fingerprint, not sent by Antigravity

  const action = url.match(/v1internal:(\w+)/)?.[1];
  let body = init.body;
  if ((action === "generateContent" || action === "streamGenerateContent") && typeof body === "string") {
    const wrapped = JSON.parse(body) as { model: string; request?: Record<string, unknown> };
    // Drop the Gemini CLI per-process session_id; the envelope derives one per conversation.
    const { session_id: _ignored, ...request } = wrapped.request ?? {};
    body = JSON.stringify(antigravityEnvelope(wrapped.model, project, withThoughts(wrapped.model, request)));
  }

  return {
    url: url.replace(GEMINI_CODE_ASSIST_ENDPOINT, API.dailyBase),
    init: { ...init, headers, body },
  };
}

// ---------------------------------------------------------------------------
// Upstream update check (notice only: never downloads or runs code)
// ---------------------------------------------------------------------------

let updateChecked = false;

export async function checkUpstreamUpdate(notify: (message: string) => void): Promise<void> {
  if (process.env.OPENCODE_ANTIGRAVITY_UPDATE_CHECK === "0" || updateChecked) return;
  updateChecked = true;
  const { repo, files } = CLIPROXY_UPSTREAM;
  const cache = await readCache();
  let latest = cache.upstreamShas;
  if (Date.now() - (cache.updateCheckedAt ?? 0) >= UPDATE_CHECK_TTL_MS) {
    try {
      const entries = await Promise.all(
        Object.keys(files).map(async (path) => {
          const res = await geminiFetch(`https://api.github.com/repos/${repo}/commits?path=${path}&per_page=1`, {
            headers: { "User-Agent": "opencode-gemini-auth", Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(5_000),
          });
          if (!res.ok) throw new Error(`GitHub ${res.status}`);
          const [commit] = (await res.json()) as Array<{ sha?: string }>;
          return [path, commit?.sha ?? ""] as const;
        }),
      );
      latest = Object.fromEntries(entries);
      await writeCache({ updateCheckedAt: Date.now(), upstreamShas: latest });
    } catch {}
  }
  const changed = Object.entries(files)
    .filter(([path, reviewed]) => latest?.[path] && latest[path] !== reviewed)
    .map(([path]) => path.split("/").pop());
  if (changed.length) {
    notify(
      `${repo} changed its Antigravity protocol files (${changed.join(", ")}). ` +
        "Run `npm run check:cliproxy` in the plugin repo, port the diff into src/antigravity/wire.ts, then accept.",
    );
  }
}
