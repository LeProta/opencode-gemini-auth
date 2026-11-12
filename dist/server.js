// src/plugin-v2.ts
import { Integration, Plugin } from "@opencode/plugin";

// src/antigravity/client.ts
import { mkdir, readFile, writeFile } from "fs/promises";
import { join as join2 } from "path";

// src/constants.ts
var GEMINI_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
var GEMINI_REDIRECT_URI = "http://localhost:51121/oauth-callback";

// src/fetch.ts
function geminiFetch(input, init) {
  const proxy = process.env.OPENCODE_GEMINI_AUTH_PROXY;
  if (!proxy) {
    return fetch(input, init);
  }
  return fetch(input, {
    ...init ?? {},
    proxy
  });
}

// src/plugin/auth.ts
var ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1e3;
function parseRefreshParts(refresh) {
  const [refreshToken = "", projectId = "", managedProjectId = ""] = (refresh ?? "").split("|");
  return {
    refreshToken,
    projectId: projectId || void 0,
    managedProjectId: managedProjectId || void 0
  };
}
function formatRefreshParts(parts) {
  if (!parts.refreshToken) {
    return "";
  }
  if (!parts.projectId && !parts.managedProjectId) {
    return parts.refreshToken;
  }
  const projectSegment = parts.projectId ?? "";
  const managedSegment = parts.managedProjectId ?? "";
  return `${parts.refreshToken}|${projectSegment}|${managedSegment}`;
}
function accessTokenExpired(auth) {
  if (!auth.access || typeof auth.expires !== "number" || !Number.isFinite(auth.expires)) {
    return true;
  }
  return auth.expires <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}

// src/plugin/storage-paths.ts
import { homedir } from "os";
import { join } from "path";
function getOpencodeDataDir(env2 = process.env, platform = process.platform, homeDir = homedir()) {
  const explicit = env2.OPENCODE_DATA_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  const xdgDataHome = env2.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return join(xdgDataHome, "opencode");
  }
  if (platform === "win32") {
    const localAppData = env2.LOCALAPPDATA?.trim() || env2.APPDATA?.trim();
    if (localAppData) {
      return join(localAppData, "opencode");
    }
    return join(homeDir, "AppData", "Local", "opencode");
  }
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "opencode");
  }
  return join(homeDir, ".local", "share", "opencode");
}
function getGeminiPluginDataDir(env2 = process.env, platform = process.platform, homeDir = homedir()) {
  return join(getOpencodeDataDir(env2, platform, homeDir), "gemini-auth");
}

// src/antigravity/upstream.ts
var CLIPROXY_UPSTREAM = {
  repo: "router-for-me/CLIProxyAPI",
  files: {
    "internal/misc/antigravity_version.go": "f72f8bfd6a1c7d69ca371dd4a7bdf490db50c154",
    "internal/auth/antigravity/constants.go": "7c627ffbdb4acff7107e05e4416e45c15a003d50",
    "internal/auth/antigravity/auth.go": "02e9e85204052dfed9bf73b7075c7b414111a4b3",
    "internal/runtime/executor/antigravity_executor_request.go": "cc95661ce438a528fa7283bf93f7dbf684d1e3fe"
  }
};

// src/antigravity/vendor/protocol.js
import { randomUUID, createHash } from "crypto";
var CLIENT_ID_B64 = "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==";
var CLIENT_SECRET_B64 = "R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=";
var OAUTH = {
  clientId: Buffer.from(CLIENT_ID_B64, "base64").toString("utf8"),
  clientSecret: Buffer.from(CLIENT_SECRET_B64, "base64").toString("utf8"),
  callbackPort: 51121,
  callbackPath: "/oauth-callback",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs"
  ],
  authEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  userinfoEndpoint: "https://www.googleapis.com/oauth2/v2/userinfo?alt=json"
};
var API = {
  prodBase: "https://cloudcode-pa.googleapis.com",
  dailyBase: "https://daily-cloudcode-pa.googleapis.com",
  apiVersion: "v1internal",
  loadCodeAssistPath: "/v1internal:loadCodeAssist",
  onboardUserPath: "/v1internal:onboardUser",
  generatePath: "/v1internal:generateContent",
  streamPath: "/v1internal:streamGenerateContent",
  fetchModelsPath: "/v1internal:fetchAvailableModels",
  countTokensPath: "/v1internal:countTokens",
  quotaSummaryPath: "/v1internal:retrieveUserQuotaSummary"
};
var VERSION = {
  manifestUrl: "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml",
  fallback: "2.9.1",
  hubPlatform: "darwin/arm64",
  nodeApiClientUA: "google-api-nodejs-client/10.3.0"
};
function callbackUrl() {
  return `http://localhost:${OAUTH.callbackPort}${OAUTH.callbackPath}`;
}
function buildAuthUrl(state) {
  const params = new URLSearchParams({
    access_type: "offline",
    client_id: OAUTH.clientId,
    prompt: "consent",
    redirect_uri: callbackUrl(),
    response_type: "code",
    scope: OAUTH.scopes.join(" "),
    state
  });
  return `${OAUTH.authEndpoint}?${params.toString()}`;
}
function tokenExchangeForm(code) {
  return new URLSearchParams({
    code,
    client_id: OAUTH.clientId,
    client_secret: OAUTH.clientSecret,
    redirect_uri: callbackUrl(),
    grant_type: "authorization_code"
  });
}
function tokenRefreshForm(refreshToken) {
  return new URLSearchParams({
    client_id: OAUTH.clientId,
    client_secret: OAUTH.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });
}
function parseVersionManifest(text) {
  if (typeof text !== "string") return null;
  const m = text.match(/^version:\s*("?)(\d+\.\d+\.\d+)\1\s*$/m);
  if (!m) return null;
  return m[2];
}
function firstNumber(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (Number.isFinite(value)) return value;
  }
  return void 0;
}
function parseAvailableModels(json) {
  const raw = json && json.models;
  const entries = Array.isArray(raw) ? raw.map((m) => [typeof m === "string" ? m : m?.id ?? m?.name, m]) : raw && typeof raw === "object" ? Object.entries(raw) : [];
  const ids = [];
  const caps = {};
  const unavailable = {};
  for (const [id, m] of entries) {
    if (typeof id !== "string" || !id) continue;
    if (m && typeof m === "object" && (m.disabled === true || m.available === false)) {
      unavailable[id] = String(m.tagDescription || m.tagTitle || "not available for this account");
      continue;
    }
    ids.push(id);
    const ctx = firstNumber(m, ["contextLength", "context_length", "maxTokens", "max_tokens"]);
    const maxOut = firstNumber(m, ["maxCompletionTokens", "max_completion_tokens", "maxOutputTokens", "max_output_tokens"]);
    if (ctx !== void 0 || maxOut !== void 0 || m.supportsImages === true) {
      caps[id] = {
        ...ctx !== void 0 ? { contextLength: ctx } : {},
        ...maxOut !== void 0 ? { maxCompletionTokens: maxOut } : {},
        ...m.supportsImages === true ? { supportsImages: true } : {}
      };
    }
  }
  return { ids, caps, unavailable };
}
function parseQuotaSummary(json) {
  const payload = json && typeof json === "object" && json.response && typeof json.response === "object" && Array.isArray(json.response.groups) ? json.response : json;
  const rawGroups = payload && Array.isArray(payload.groups) ? payload.groups : null;
  if (!rawGroups || !rawGroups.length) return null;
  const text = (value) => typeof value === "string" ? value : "";
  const groups = [];
  for (const group of rawGroups) {
    if (!group || typeof group !== "object") continue;
    const buckets = [];
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (!bucket || typeof bucket !== "object") continue;
      let resetAt = null;
      if (typeof bucket.resetTime === "string") {
        const parsed = Date.parse(bucket.resetTime);
        if (Number.isFinite(parsed) && parsed > 864e5) resetAt = parsed;
      }
      let remaining = null;
      if (Number.isFinite(bucket.remainingFraction)) {
        remaining = Math.max(0, Math.min(1, bucket.remainingFraction));
      } else if (bucket.remainingAmount === void 0 && resetAt !== null) {
        remaining = 0;
      }
      buckets.push({
        id: text(bucket.bucketId),
        name: text(bucket.displayName),
        description: text(bucket.description),
        window: text(bucket.window),
        remaining,
        resetAt,
        disabled: bucket.disabled === true
      });
    }
    groups.push({ name: text(group.displayName), description: text(group.description), buckets });
  }
  if (!groups.length) return null;
  return { description: text(payload.description), groups };
}
var EFFORT_SUFFIX_RE = new RegExp(`^(.+)-(minimal|low|medium|high|xhigh|max)$`);
function splitEffortModelId(id) {
  if (typeof id !== "string" || !id) return null;
  const m = id.match(EFFORT_SUFFIX_RE);
  if (!m) return null;
  return { baseId: m[1], effort: m[2] };
}

// src/antigravity/wire.ts
import { createHash as createHash2, randomBytes, randomUUID as randomUUID2 } from "crypto";
var FALLBACK_VERSION = "2.29.0";
var HUB_PLATFORM = "os_type=darwin; arch=arm64";
var NODE_API_CLIENT_UA = "google-api-nodejs-client/10.3.0";
var GOOG_API_CLIENT = "gl-node/22.21.1";
var HUB_CHANGELISTS = {
  "2.23.0": "998057262",
  "2.24.0": "1000335682",
  "2.29.0": "1013060670"
};
function userAgents(version) {
  const cl = HUB_CHANGELISTS[version];
  const short = `antigravity/hub/${version} (aidev_client; ${HUB_PLATFORM}${cl ? `; cl=${cl}` : ""})`;
  return {
    /** generate / stream / loadCodeAssist / fetchAvailableModels / quota */
    short,
    /** onboardUser */
    long: `${short} ${NODE_API_CLIENT_UA}`,
    /** OAuth token exchange and refresh */
    refresh: "Go-http-client/2.0"
  };
}
function onboardBody(tierId, version) {
  return {
    tier_id: tierId,
    metadata: { ide_type: "ANTIGRAVITY", ide_version: version, ide_name: "antigravity" }
  };
}
function defaultTierId(loadResp) {
  const tiers = Array.isArray(loadResp?.allowedTiers) ? loadResp.allowedTiers : [];
  const preferred = tiers.find((t) => t?.isDefault === true && typeof t.id === "string" && t.id.trim());
  if (preferred) return preferred.id.trim();
  const current = loadResp?.currentTier?.id;
  return typeof current === "string" && current.trim() ? current.trim() : "free-tier";
}
function stableSessionId(contents) {
  for (const content of Array.isArray(contents) ? contents : []) {
    if (content?.role !== "user") continue;
    const text = content?.parts?.[0]?.text;
    if (typeof text !== "string" || !text) continue;
    const value = createHash2("sha256").update(text).digest().readBigUInt64BE(0) & 0x7fffffffffffffffn;
    return `-${value}`;
  }
  return `-${randomBytes(8).readBigUInt64BE(0) & 0x7fffffffffffffffn}`;
}
function antigravityEnvelope(model, project, geminiRequest) {
  const { toolConfig: topToolConfig, ...rest } = geminiRequest;
  const request = { ...rest };
  if (topToolConfig && !request.toolConfig) request.toolConfig = topToolConfig;
  delete request.safetySettings;
  const isImage = model.includes("image");
  const isClaude = model.includes("claude");
  if (isClaude) {
    request.toolConfig = {
      ...request.toolConfig,
      functionCallingConfig: { ...request.toolConfig?.functionCallingConfig, mode: "VALIDATED" }
    };
  } else if (request.generationConfig) {
    const { maxOutputTokens: _dropped, ...generationConfig } = request.generationConfig;
    request.generationConfig = generationConfig;
  }
  const envelope = {
    model,
    userAgent: "antigravity",
    requestType: isImage ? "image_gen" : "agent"
  };
  if (project) envelope.project = project;
  if (isImage) {
    envelope.requestId = `image_gen/${Date.now()}/${randomUUID2()}/12`;
  } else {
    envelope.requestId = `agent-${randomUUID2()}`;
    if (!request.sessionId) request.sessionId = stableSessionId(request.contents);
  }
  envelope.request = request;
  return envelope;
}

// src/antigravity/client.ts
var VERSION_TTL_MS = 6 * 60 * 60 * 1e3;
var VERSION_MEMO_MS = 10 * 60 * 1e3;
var UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1e3;
var cachePath = () => join2(getGeminiPluginDataDir(), "antigravity.json");
var STORAGE_KEY = "antigravity-cache";
var storage;
var memo;
function useCacheStorage(next) {
  if (storage) return;
  storage = next;
  memo = void 0;
}
async function readFileCache() {
  try {
    return JSON.parse(await readFile(cachePath(), "utf8"));
  } catch {
    return {};
  }
}
async function loadCache() {
  if (!storage) return readFileCache();
  try {
    const stored = await storage.get(STORAGE_KEY);
    if (stored && typeof stored === "object") return stored;
  } catch {
  }
  return readFileCache();
}
function readCache() {
  memo ??= loadCache();
  return memo;
}
async function writeCache(patch) {
  const next = { ...await readCache(), ...patch };
  memo = Promise.resolve(next);
  try {
    if (storage) {
      await storage.set(STORAGE_KEY, next);
      return;
    }
    await mkdir(getGeminiPluginDataDir(), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(next, null, 2));
  } catch {
  }
}
var versionMemo;
function currentVersion() {
  if (!versionMemo || Date.now() > versionMemo.expires) {
    versionMemo = { value: loadVersion(), expires: Date.now() + VERSION_MEMO_MS };
  }
  return versionMemo.value;
}
async function loadVersion() {
  const now = Date.now();
  const cache = await readCache();
  const cacheAge = now - (cache.versionFetchedAt ?? 0);
  if (cache.version && cacheAge < VERSION_TTL_MS) return cache.version;
  try {
    const res = await geminiFetch(VERSION.manifestUrl, {
      headers: { "User-Agent": "electron-builder", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(1e4)
    });
    const version = res.status === 200 ? parseVersionManifest(await res.text()) : null;
    if (version) {
      await writeCache({ version, versionFetchedAt: now });
      return version;
    }
  } catch {
  }
  return cache.version && cacheAge < VERSION_TTL_MS * 4 ? cache.version : FALLBACK_VERSION;
}
async function upstreamJson(url, { token, ua, body, method = "POST", timeoutMs = 15e3, extraHeaders }) {
  const headers = { "Content-Type": "application/json", Accept: "*/*", "User-Agent": ua, ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await geminiFetch(url, {
    method,
    headers,
    body: body === void 0 ? void 0 : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
  }
  return { status: res.status, text, json };
}
function extractProject(data) {
  if (!data || typeof data !== "object") return "";
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object" && typeof value.id === "string" && value.id.trim()) return value.id.trim();
  }
  return "";
}
async function exchangeCode(code) {
  try {
    const ua = userAgents(await currentVersion());
    const res = await geminiFetch(OAUTH.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua.refresh },
      body: tokenExchangeForm(code).toString(),
      signal: AbortSignal.timeout(15e3)
    });
    const text = await res.text();
    if (!res.ok) return { type: "failed", error: text };
    const tokens = JSON.parse(text);
    if (!tokens.refresh_token) return { type: "failed", error: "Missing refresh token in response" };
    let email;
    try {
      const info = await upstreamJson(OAUTH.userinfoEndpoint, { method: "GET", token: tokens.access_token, ua: ua.short });
      email = info.json?.email;
    } catch {
    }
    return {
      type: "success",
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1e3,
      email
    };
  } catch (error) {
    return { type: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
var refreshInFlight = /* @__PURE__ */ new Map();
function refreshAuth(auth, persist) {
  const parts = parseRefreshParts(auth.refresh);
  const pending = refreshInFlight.get(parts.refreshToken);
  if (pending) return pending;
  const run = (async () => {
    const ua = userAgents(await currentVersion());
    const res = await geminiFetch(OAUTH.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": ua.refresh },
      body: tokenRefreshForm(parts.refreshToken).toString(),
      signal: AbortSignal.timeout(15e3)
    });
    const text = await res.text();
    if (res.status === 400) {
      throw new Error(
        `Antigravity refresh token rejected (${text.slice(0, 200)}). Run \`opencode auth login\` and pick Google (Antigravity) again.`
      );
    }
    if (!res.ok) throw new Error(`Antigravity token refresh failed (${res.status}): ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    const next = {
      ...auth,
      access: json.access_token,
      expires: Date.now() + (Number(json.expires_in) || 3600) * 1e3,
      refresh: formatRefreshParts({ ...parts, refreshToken: json.refresh_token || parts.refreshToken })
    };
    await persist(next);
    return next;
  })().finally(() => refreshInFlight.delete(parts.refreshToken));
  refreshInFlight.set(parts.refreshToken, run);
  return run;
}
async function resolveProject(accessToken) {
  const version = await currentVersion();
  const ua = userAgents(version);
  const load = await upstreamJson(`${API.dailyBase}${API.loadCodeAssistPath}`, {
    token: accessToken,
    ua: ua.short,
    body: { metadata: { ideType: "ANTIGRAVITY" } }
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
      timeoutMs: 3e4
    });
    if (res.status !== 200) {
      throw new Error(`Antigravity onboardUser failed (${res.status}): ${res.text.slice(0, 200)}`);
    }
    const project = extractProject(res.json?.response) || extractProject(res.json);
    if (project) return project;
    await new Promise((resolve) => setTimeout(resolve, 1e3));
  }
  throw new Error("Antigravity onboardUser did not complete in time");
}
function isPublishableModelId(id) {
  return !!id && !/^(chat_|tab_)/.test(id);
}
async function refreshModels(accessToken, project) {
  const ua = userAgents(await currentVersion());
  for (const base of [API.prodBase, API.dailyBase]) {
    try {
      const res = await upstreamJson(`${base}${API.fetchModelsPath}`, {
        token: accessToken,
        ua: ua.short,
        body: project ? { project } : {},
        timeoutMs: 2e4
      });
      if (res.status !== 200 || !res.json?.models) continue;
      const { ids, caps } = parseAvailableModels(res.json);
      const models = ids.filter(isPublishableModelId);
      if (!models.length) continue;
      await writeCache({ models, modelCaps: caps });
      return models;
    } catch {
    }
  }
  return void 0;
}
async function fetchQuotaSummary(accessToken, project) {
  const ua = userAgents(await currentVersion());
  for (const base of [API.dailyBase, API.prodBase]) {
    try {
      const res = await upstreamJson(`${base}${API.quotaSummaryPath}`, {
        token: accessToken,
        ua: ua.short,
        body: project ? { project } : {}
      });
      if (res.status !== 200) continue;
      const summary = parseQuotaSummary(res.json);
      if (summary) return summary;
    } catch {
    }
  }
  return null;
}
function formatQuotaSummary(summary, now = Date.now()) {
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
function formatDuration(ms) {
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 6e4);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.round(hours / 24)} days`;
}
function withThoughts(model, request) {
  if (model.includes("image")) return request;
  const generationConfig = request.generationConfig ?? {};
  const current = generationConfig.thinkingConfig ?? {};
  if (current.includeThoughts === false) return request;
  const thinkingConfig = { ...current, includeThoughts: true };
  if (current.thinkingLevel === void 0 && current.thinkingBudget === void 0) {
    const idEffort = splitEffortModelId(model)?.effort;
    if (/gemini-3/.test(model)) thinkingConfig.thinkingLevel = idEffort === "medium" || idEffort === "low" ? idEffort : "high";
    else thinkingConfig.thinkingBudget = -1;
  }
  return { ...request, generationConfig: { ...generationConfig, thinkingConfig } };
}
function toAntigravityRequest(url, init, project, version) {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", userAgents(version).short);
  headers.delete("x-activity-request-id");
  const action = url.match(/v1internal:(\w+)/)?.[1];
  let body = init.body;
  if ((action === "generateContent" || action === "streamGenerateContent") && typeof body === "string") {
    const wrapped = JSON.parse(body);
    const { session_id: _ignored, ...request } = wrapped.request ?? {};
    body = JSON.stringify(antigravityEnvelope(wrapped.model, project, withThoughts(wrapped.model, request)));
  }
  return {
    url: url.replace(GEMINI_CODE_ASSIST_ENDPOINT, API.dailyBase),
    init: { ...init, headers, body }
  };
}
var updateChecked = false;
async function checkUpstreamUpdate(notify) {
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
            signal: AbortSignal.timeout(5e3)
          });
          if (!res.ok) throw new Error(`GitHub ${res.status}`);
          const [commit] = await res.json();
          return [path, commit?.sha ?? ""];
        })
      );
      latest = Object.fromEntries(entries);
      await writeCache({ updateCheckedAt: Date.now(), upstreamShas: latest });
    } catch {
    }
  }
  const changed = Object.entries(files).filter(([path, reviewed]) => latest?.[path] && latest[path] !== reviewed).map(([path]) => path.split("/").pop());
  if (changed.length) {
    notify(
      `${repo} changed its Antigravity protocol files (${changed.join(", ")}). Run \`npm run check:cliproxy\` in the plugin repo, port the diff into src/antigravity/wire.ts, then accept.`
    );
  }
}

// src/antigravity/models.ts
var EFFORT_ORDER = ["high", "medium", "low"];
function upstreamModelFor(id, available, level) {
  const known = new Set(available);
  const stems = id.endsWith("-preview") ? [id, id.slice(0, -"-preview".length)] : [id];
  for (const stem of stems) {
    if (known.has(stem)) return stem;
    const efforts = level ? [level, ...EFFORT_ORDER] : EFFORT_ORDER;
    for (const effort of efforts) {
      if (known.has(`${stem}-${effort}`)) return `${stem}-${effort}`;
    }
  }
  return void 0;
}
function requestedThinkingLevel(body) {
  if (!body) return void 0;
  try {
    const level = JSON.parse(body)?.generationConfig?.thinkingConfig?.thinkingLevel;
    return typeof level === "string" && level ? level.toLowerCase() : void 0;
  } catch {
    return void 0;
  }
}

// src/antigravity/oauth.ts
import { randomBytes as randomBytes2 } from "crypto";

// src/plugin/oauth-authorize.ts
import { spawn } from "child_process";

// src/plugin/debug.ts
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync2 } from "fs";
import { dirname as dirname2, join as join4 } from "path";
import { env } from "process";

// src/plugin/logger.ts
import { appendFileSync, mkdirSync } from "fs";
import { dirname, join as join3 } from "path";
var SECRET_KEY_NAMES = /* @__PURE__ */ new Set([
  "access",
  "accesstoken",
  "apikey",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "idtoken",
  "password",
  "proxyauthorization",
  "refresh",
  "refreshtoken",
  "secret",
  "setcookie",
  "token",
  "xapikey",
  "xgoogapikey"
]);
var REDACTED = "[redacted]";
function isSensitiveKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_KEY_NAMES.has(normalized);
}
function redact(value, seen = /* @__PURE__ */ new WeakSet()) {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || value === void 0 || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }
  if (value instanceof Error) {
    const out2 = {
      name: value.name,
      message: redactString(value.message)
    };
    if (value.stack) {
      out2.stack = redactString(value.stack);
    }
    const extra = value;
    if ("code" in extra) {
      out2.code = redact(extra.code, seen);
    }
    if ("status" in extra) {
      out2.status = extra.status;
    }
    return out2;
  }
  if (value instanceof Headers) {
    const out2 = {};
    value.forEach((v, k) => {
      out2[k] = isSensitiveKey(k) ? REDACTED : redactString(v);
    });
    return out2;
  }
  if (value instanceof URLSearchParams) {
    const out2 = {};
    value.forEach((v, k) => {
      out2[k] = isSensitiveKey(k) ? REDACTED : redactString(v);
    });
    return out2;
  }
  const record = value;
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (isSensitiveKey(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out;
}
function redactString(input) {
  return input.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`).replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED).replace(/\bya29\.[A-Za-z0-9._-]{8,}\b/g, REDACTED).replace(/\b1\/\/[A-Za-z0-9._-]{8,}\b/g, REDACTED).replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED).replace(/\bGOCSPX-[0-9A-Za-z_-]{10,}\b/g, REDACTED).replace(
    /("(?:access_token|refresh_token|id_token|client_secret|authorization|x-goog-api-key|x-api-key|api_key|apiKey)"\s*:\s*")([^"]*)(")/gi,
    `$1${REDACTED}$3`
  ).replace(
    /\b(access_token|refresh_token|id_token|client_secret|authorization|api_key)=([^&\s]+)/gi,
    `$1=${REDACTED}`
  );
}

// src/plugin/debug.ts
var MAX_BODY_PREVIEW_CHARS = 2e3;
var SENSITIVE_HEADER_KEYS = /* @__PURE__ */ new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie"
]);
var cachedLogDir;
var cachedLogFilePath;
var requestCounter = 0;
function isGeminiDebugEnabled() {
  return (env.OPENCODE_GEMINI_DEBUG ?? "").trim() === "1";
}
function logGeminiDebugMessage(message) {
  if (!isGeminiDebugEnabled()) {
    return;
  }
  logDebug(`[Gemini Debug] ${redactString(message)}`);
}
function startGeminiDebugRequest(meta) {
  if (!isGeminiDebugEnabled()) {
    return null;
  }
  const id = `GEMINI-${++requestCounter}`;
  const method = meta.method ?? "GET";
  const safeResolvedUrl = redactString(meta.resolvedUrl);
  const safeOriginalUrl = meta.originalUrl ? redactString(meta.originalUrl) : "";
  logDebug(`[Gemini Debug ${id}] ${method} ${safeResolvedUrl}`);
  if (safeOriginalUrl && safeOriginalUrl !== safeResolvedUrl) {
    logDebug(`[Gemini Debug ${id}] Original URL: ${safeOriginalUrl}`);
  }
  if (meta.projectId) {
    logDebug(`[Gemini Debug ${id}] Project: ${meta.projectId}`);
  }
  logDebug(`[Gemini Debug ${id}] Streaming: ${meta.streaming ? "yes" : "no"}`);
  logDebug(`[Gemini Debug ${id}] Headers: ${JSON.stringify(maskHeaders(meta.headers))}`);
  const bodyPreview = formatBodyPreview(meta.body);
  if (bodyPreview) {
    logDebug(`[Gemini Debug ${id}] Body Preview: ${bodyPreview}`);
  }
  return { id, streaming: meta.streaming, startedAt: Date.now() };
}
function logGeminiDebugResponse(context, response, meta = {}) {
  if (!isGeminiDebugEnabled() || !context) {
    return;
  }
  const durationMs = Date.now() - context.startedAt;
  logDebug(
    `[Gemini Debug ${context.id}] Response ${response.status} ${response.statusText} (${durationMs}ms)`
  );
  logDebug(
    `[Gemini Debug ${context.id}] Response Headers: ${JSON.stringify(
      maskHeaders(meta.headersOverride ?? response.headers)
    )}`
  );
  const traceId = getHeaderValue(meta.headersOverride ?? response.headers, "x-cloudaicompanion-trace-id");
  if (traceId) {
    logDebug(`[Gemini Debug ${context.id}] Trace ID: ${traceId}`);
  }
  if (meta.note) {
    logDebug(`[Gemini Debug ${context.id}] Note: ${meta.note}`);
  }
  if (meta.error) {
    logDebug(`[Gemini Debug ${context.id}] Error: ${formatError(meta.error)}`);
  }
  if (meta.body) {
    logDebug(
      `[Gemini Debug ${context.id}] Response Body Preview: ${truncateForLog(meta.body)}`
    );
  }
}
function maskHeaders(headers) {
  if (!headers) {
    return {};
  }
  const result = {};
  const parsed = headers instanceof Headers ? headers : new Headers(headers);
  parsed.forEach((value, key) => {
    if (SENSITIVE_HEADER_KEYS.has(key.toLowerCase())) {
      result[key] = "[redacted]";
    } else {
      result[key] = redactString(value);
    }
  });
  return result;
}
function getHeaderValue(headers, key) {
  const target = key.toLowerCase();
  if (headers instanceof Headers) {
    const value = headers.get(key);
    return value ?? void 0;
  }
  if (Array.isArray(headers)) {
    for (const [headerKey, headerValue] of headers) {
      if (headerKey.toLowerCase() === target) {
        return headerValue;
      }
    }
    return void 0;
  }
  const record = headers;
  for (const [headerKey, headerValue] of Object.entries(record)) {
    if (headerKey.toLowerCase() === target) {
      return headerValue ?? void 0;
    }
  }
  return void 0;
}
function formatBodyPreview(body) {
  if (body == null) {
    return void 0;
  }
  if (typeof body === "string") {
    return truncateForLog(body);
  }
  if (body instanceof URLSearchParams) {
    return truncateForLog(body.toString());
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return `[Blob size=${body.size}]`;
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return "[FormData payload omitted]";
  }
  return `[${body.constructor?.name ?? typeof body} payload omitted]`;
}
function truncateForLog(text) {
  const safeText = redactString(text);
  if (safeText.length <= MAX_BODY_PREVIEW_CHARS) {
    return safeText;
  }
  return `${safeText.slice(0, MAX_BODY_PREVIEW_CHARS)}... (truncated ${safeText.length - MAX_BODY_PREVIEW_CHARS} chars)`;
}
function logDebug(line) {
  const filePath = resolveDebugLogFilePath();
  try {
    mkdirSync2(dirname2(filePath), { recursive: true });
    appendFileSync2(filePath, `${redactString(line)}
`, "utf8");
  } catch {
  }
}
function formatError(error) {
  if (error instanceof Error) {
    return redactString(error.stack ?? error.message);
  }
  try {
    return JSON.stringify(redact(error));
  } catch {
    return redactString(String(error));
  }
}
function resolveDebugLogFilePath() {
  const logDir = join4(getGeminiPluginDataDir(), "logs");
  if (!cachedLogFilePath || cachedLogDir !== logDir) {
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    cachedLogDir = logDir;
    cachedLogFilePath = join4(logDir, `gemini-debug-${timestamp}.log`);
  }
  return cachedLogFilePath;
}

// src/plugin/server.ts
import { createServer } from "http";
var defaultRedirectUri = new URL(GEMINI_REDIRECT_URI);
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function renderFailureResponse(message) {
  const detail = escapeHtml(
    message?.trim() || "Authentication could not be completed. Return to Opencode and try again."
  );
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenCode Google sign-in failed</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: "Roboto", "Google Sans", arial, sans-serif;
        background: #f1f3f4;
        color: #202124;
      }
      main {
        width: min(448px, calc(100% - 3rem));
        background: #ffffff;
        border-radius: 28px;
        padding: 2.5rem 2.75rem;
        box-shadow: 0 1px 2px rgba(60, 64, 67, 0.3), 0 2px 6px rgba(60, 64, 67, 0.15);
      }
      h1 { margin: 0 0 0.75rem; font-size: 1.5rem; font-weight: 500; color: #c5221f; }
      p { margin: 0; font-size: 0.95rem; line-height: 1.5; color: #3c4043; word-break: break-word; }
      @media (prefers-color-scheme: dark) {
        body { background: #1f1f1f; color: #e8eaed; }
        main { background: #2d2e30; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); }
        h1 { color: #f28b82; }
        p { color: #bdc1c6; }
      }
    </style>
  </head>
  <body>
    <main role="main">
      <h1>Authentication failed</h1>
      <p>${detail}</p>
    </main>
  </body>
</html>`;
}
function createOAuthCallbackRequestHandler(deps) {
  const successHtml = deps.successResponse ?? "<!DOCTYPE html><html><body>You're connected to OpenCode</body></html>";
  return (request, response) => {
    const finishResponse = (statusCode, headers, body, afterFlush) => {
      response.writeHead(statusCode, { Connection: "close", ...headers });
      response.end(body, () => {
        afterFlush?.();
      });
    };
    if (!request.url) {
      finishResponse(400, { "Content-Type": "text/plain; charset=utf-8" }, "Invalid request");
      return;
    }
    const url = new URL(request.url, deps.getOrigin());
    if (url.pathname !== deps.callbackPath) {
      finishResponse(404, { "Content-Type": "text/plain; charset=utf-8" }, "Not found");
      return;
    }
    const hasCode = !!url.searchParams.get("code");
    const hasState = !!url.searchParams.get("state");
    const hasError = !!url.searchParams.get("error");
    if (!hasError && (!hasCode || !hasState)) {
      finishResponse(
        400,
        { "Content-Type": "text/plain; charset=utf-8" },
        "Ignoring incomplete OAuth callback. Return to the Google sign-in flow."
      );
      return;
    }
    if (!deps.onCallback) {
      finishResponse(200, { "Content-Type": "text/html; charset=utf-8" }, successHtml, () => {
        deps.deliverCallback(url);
      });
      return;
    }
    void (async () => {
      try {
        const reply = await deps.onCallback(url);
        const status = reply.status ?? (reply.ok ? 200 : 400);
        const body = reply.html ?? (reply.ok ? successHtml : renderFailureResponse(reply.message));
        const shouldDeliver = reply.terminal !== false;
        finishResponse(status, { "Content-Type": "text/html; charset=utf-8" }, body, () => {
          if (shouldDeliver) {
            deps.deliverCallback(url);
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finishResponse(
          500,
          { "Content-Type": "text/html; charset=utf-8" },
          renderFailureResponse(message),
          () => {
            deps.failPendingWaiters(error instanceof Error ? error : new Error(message));
          }
        );
      }
    })();
  };
}
async function startOAuthListener({ timeoutMs = 5 * 60 * 1e3, redirectUri: redirectUriOverride, onCallback } = {}) {
  const parsedRedirectUri = redirectUriOverride ? new URL(redirectUriOverride) : defaultRedirectUri;
  const callbackPath = parsedRedirectUri.pathname || "/";
  const requestedPort = parsedRedirectUri.port ? Number.parseInt(parsedRedirectUri.port, 10) : parsedRedirectUri.protocol === "https:" ? 443 : 80;
  let boundPort = requestedPort;
  let origin = `${parsedRedirectUri.protocol}//${parsedRedirectUri.host}`;
  const callbackQueue = [];
  const callbackWaiters = [];
  let terminalError;
  const successResponse = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenCode Google sign-in</title>
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: "Roboto", "Google Sans", arial, sans-serif;
        background: #f1f3f4;
        color: #202124;
      }
      main {
        width: min(448px, calc(100% - 3rem));
        background: #ffffff;
        border-radius: 28px;
        padding: 2.5rem 2.75rem;
        box-shadow: 0 1px 2px rgba(60, 64, 67, 0.3), 0 2px 6px rgba(60, 64, 67, 0.15);
      }
      header {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin-bottom: 1.5rem;
      }
      .logo {
        width: 40px;
        height: 40px;
        display: inline-flex;
      }
      .logo svg {
        width: 100%;
        height: 100%;
      }
      .brand {
        font-size: 1.1rem;
        font-weight: 500;
        letter-spacing: 0.01em;
      }
      h1 {
        margin: 0 0 0.75rem;
        font-size: 1.75rem;
        font-weight: 500;
        letter-spacing: -0.01em;
      }
      p {
        margin: 0 0 1.75rem;
        font-size: 1.05rem;
        line-height: 1.6;
        color: #3c4043;
      }
      .note {
        margin: 1.5rem 0 0;
        font-size: 0.92rem;
        color: #5f6368;
      }
      .action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.65rem 1.85rem;
        border-radius: 999px;
        background: #1a73e8;
        color: #ffffff;
        font-weight: 500;
        font-size: 0.95rem;
        letter-spacing: 0.02em;
        text-decoration: none;
        transition: box-shadow 0.2s ease, transform 0.2s ease;
      }
      .action:hover {
        transform: translateY(-1px);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 1px 3px rgba(60, 64, 67, 0.15);
      }
      .action:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.3);
      }
      @media (prefers-color-scheme: dark) {
        body {
          background: #131314;
          color: #e8eaed;
        }
        main {
          background: #202124;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.4);
        }
        p {
          color: #e8eaed;
        }
        .note {
          color: #bdc1c6;
        }
        .action {
          background: #8ab4f8;
          color: #202124;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <span class="logo" aria-hidden="true">
          <svg viewBox="0 0 46 46" xmlns="http://www.w3.org/2000/svg" role="img">
            <title>Google linked to OpenCode</title>
            <path fill="#4285F4" d="M43.6 23.5c0-1.5-.1-3-.4-4.4H23v8.3h11.6c-.5 2.8-2 5.1-4.2 6.7v5.5h6.8c4-3.7 6.4-9.1 6.4-16.1z"/>
            <path fill="#34A853" d="M23 45c5.8 0 10.6-1.9 14.1-5.2l-6.8-5.5c-1.9 1.3-4.3 2-7.3 2-5.6 0-10.4-3.7-12.1-8.7H3.8v5.6C7.3 39.9 14.6 45 23 45z"/>
            <path fill="#FBBC04" d="M10.9 28.6c-.5-1.3-.8-2.7-.8-4.1 0-1.5.3-2.8.8-4.1v-5.6H3.8C2.3 17.7 1.5 20.2 1.5 24s.8 6.3 2.3 9.2l6.9-5.6z"/>
            <path fill="#EA4335" d="M23 9.5c3.2 0 6 .9 8.3 2.7l6.2-6.2C33.6 2.2 28.8 0 23 0 14.6 0 7.3 5.1 3.8 12.4l7.1 5.6c1.7-5 6.5-8.5 12.1-8.5z"/>
          </svg>
        </span>
        <span class="brand">Google linked to OpenCode</span>
      </header>
      <h1>You're connected to OpenCode</h1>
      <p>Your Google account is now linked to Opencode. You can close this window and continue in the CLI.</p>
      <a class="action" href="javascript:window.close()">Close window</a>
      <p class="note">Need to reconnect later? Re-run the authentication command in Opencode.</p>
    </main>
  </body>
</html>`;
  const deliverCallback = (url) => {
    const waiter = callbackWaiters.shift();
    if (waiter) {
      waiter.resolve(url);
      return;
    }
    callbackQueue.push(url);
  };
  const failPendingWaiters = (error) => {
    if (terminalError) {
      return;
    }
    terminalError = error;
    while (callbackWaiters.length > 0) {
      callbackWaiters.shift()?.reject(error);
    }
  };
  const timeoutHandle = setTimeout(() => {
    failPendingWaiters(new Error("Timed out waiting for OAuth callback"));
  }, timeoutMs);
  timeoutHandle.unref?.();
  const server = createServer(
    createOAuthCallbackRequestHandler({
      getOrigin: () => origin,
      callbackPath,
      successResponse,
      onCallback,
      deliverCallback,
      failPendingWaiters
    })
  );
  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off("error", handleError);
      reject(error);
    };
    server.once("error", handleError);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.off("error", handleError);
      const addr = server.address();
      if (addr && typeof addr === "object") {
        boundPort = addr.port;
        const responseHost = parsedRedirectUri.hostname || "127.0.0.1";
        origin = `${parsedRedirectUri.protocol}//${responseHost}:${boundPort}`;
      }
      resolve();
    });
  });
  const resolvedRedirectUri = new URL(callbackPath, origin).toString();
  server.on("error", (error) => {
    failPendingWaiters(error instanceof Error ? error : new Error(String(error)));
  });
  return {
    port: boundPort,
    redirectUri: resolvedRedirectUri,
    waitForCallback: async () => {
      if (callbackQueue.length > 0) {
        return callbackQueue.shift();
      }
      if (terminalError) {
        throw terminalError;
      }
      return await new Promise((resolve, reject) => {
        callbackWaiters.push({ resolve, reject });
      });
    },
    close: () => new Promise((resolve, reject) => {
      server.closeIdleConnections?.();
      server.close((error) => {
        if (error && error.code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
          return;
        }
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        failPendingWaiters(new Error("OAuth listener closed before callback"));
        resolve();
      });
    })
  };
}

// src/plugin/oauth-authorize.ts
function createOAuthAuthorizeMethod(options) {
  const { authorizeFn, exchangeFn, resolveProjectContextFn } = options;
  const startListenerFn = options.startListenerFn ?? startOAuthListener;
  const openBrowser = options.openBrowser ?? openBrowserUrl;
  return async () => {
    const maybeHydrateProjectId = async (result) => {
      if (result.type !== "success" || !result.access || !resolveProjectContextFn) {
        return result;
      }
      try {
        const authSnapshot = {
          type: "oauth",
          refresh: result.refresh,
          access: result.access,
          expires: result.expires
        };
        const { auth } = await resolveProjectContextFn(authSnapshot, result.access);
        if (auth.refresh !== result.refresh && isGeminiDebugEnabled()) {
          logGeminiDebugMessage("OAuth project resolved during auth");
        }
        return auth.refresh !== result.refresh ? { ...result, refresh: auth.refresh } : result;
      } catch (error) {
        if (isGeminiDebugEnabled()) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[Google OAuth] Project resolution skipped: ${message}`);
        }
        return result;
      }
    };
    const isHeadless = options.isHeadless?.() ?? !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.OPENCODE_HEADLESS);
    const authorization = await authorizeFn();
    let settled = false;
    let exchangeInFlight = false;
    let finalResult;
    const handleCallbackUrl = async (callbackUrl2) => {
      if (settled) {
        return {
          ok: finalResult?.type === "success",
          terminal: false,
          status: finalResult?.type === "success" ? 200 : 400,
          message: finalResult?.type === "failed" ? finalResult.error : "OAuth sign-in has already completed."
        };
      }
      const callbackError = callbackUrl2.searchParams.get("error");
      const callbackErrorDescription = callbackUrl2.searchParams.get("error_description");
      if (callbackError) {
        const errorMessage = callbackErrorDescription || callbackError;
        settled = true;
        finalResult = { type: "failed", error: errorMessage };
        return { ok: false, terminal: true, status: 400, message: errorMessage };
      }
      const code = callbackUrl2.searchParams.get("code");
      const state = callbackUrl2.searchParams.get("state");
      if (!code || !state) {
        return {
          ok: false,
          terminal: false,
          status: 400,
          message: "Missing authorization code or state."
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
          message: "Invalid OAuth state parameter. Return to the sign-in flow and try again."
        };
      }
      if (exchangeInFlight) {
        return {
          ok: false,
          terminal: false,
          status: 409,
          message: "OAuth callback exchange is already in progress."
        };
      }
      exchangeInFlight = true;
      try {
        const exchangeResult = await exchangeFn(code, authorization.verifier);
        if (shouldIgnoreMalformedAuthCode(exchangeResult)) {
          if (isGeminiDebugEnabled()) {
            logGeminiDebugMessage(
              "Ignoring malformed OAuth callback code and waiting for the next redirect"
            );
          }
          return {
            ok: false,
            terminal: false,
            status: 400,
            message: "Malformed authorization code. Waiting for valid redirect."
          };
        }
        if (exchangeResult.type === "failed") {
          settled = true;
          finalResult = exchangeResult;
          return {
            ok: false,
            terminal: true,
            status: 502,
            message: exchangeResult.error
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
    let listener = null;
    if (!isHeadless) {
      try {
        listener = await startListenerFn({
          timeoutMs: options.timeoutMs,
          redirectUri: options.redirectUri,
          onCallback: handleCallbackUrl
        });
      } catch (error) {
        const detail = error instanceof Error ? ` (${error.message})` : "";
        console.log(
          `Warning: Couldn't start the local callback listener${detail}. You'll need to paste the callback URL or authorization code.`
        );
      }
    } else {
      console.log(
        "Headless environment detected. You'll need to paste the callback URL or authorization code."
      );
    }
    if (!isHeadless) {
      openBrowser(authorization.url);
    }
    if (listener) {
      return {
        url: authorization.url,
        instructions: "Complete the sign-in flow in your browser. We'll automatically detect the redirect back to localhost.",
        method: "auto",
        callback: async () => {
          try {
            await listener.waitForCallback();
            return finalResult ?? {
              type: "failed",
              error: "OAuth listener exited without producing credentials"
            };
          } catch (error) {
            return {
              type: "failed",
              error: error instanceof Error ? error.message : "Unknown error"
            };
          } finally {
            try {
              await listener?.close();
            } catch {
            }
          }
        }
      };
    }
    return {
      url: authorization.url,
      instructions: `Complete OAuth in your browser, then paste the full redirected URL (e.g., ${options.redirectUri ?? "http://localhost:<port>/callback"}?code=...&state=...) or just the authorization code.`,
      method: "code",
      callback: async (callbackUrl2) => {
        try {
          const { code, state, error, errorDescription } = parseOAuthCallbackInput(callbackUrl2);
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
            await exchangeFn(code, authorization.verifier)
          );
        } catch (error) {
          return {
            type: "failed",
            error: error instanceof Error ? error.message : "Unknown error"
          };
        }
      }
    };
  };
}
function parseOAuthCallbackInput(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        code: url.searchParams.get("code") || void 0,
        state: url.searchParams.get("state") || void 0,
        error: url.searchParams.get("error") || void 0,
        errorDescription: url.searchParams.get("error_description") || void 0
      };
    } catch {
      return {};
    }
  }
  const candidate = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
  if (candidate.includes("=")) {
    const params = new URLSearchParams(candidate);
    const code = params.get("code") || void 0;
    const state = params.get("state") || void 0;
    const error = params.get("error") || void 0;
    const errorDescription = params.get("error_description") || void 0;
    if (code || state || error) {
      return { code, state, error, errorDescription };
    }
  }
  return { code: trimmed };
}
function openBrowserUrl(url) {
  try {
    const platform = process.platform;
    const command = platform === "darwin" ? "open" : platform === "win32" ? "rundll32" : "xdg-open";
    const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true
    });
    child.unref?.();
  } catch {
  }
}
function shouldIgnoreMalformedAuthCode(result) {
  if (result.type !== "failed") {
    return false;
  }
  return /invalid_grant/i.test(result.error) && /malformed auth code/i.test(result.error);
}

// src/antigravity/oauth.ts
var authorizeAntigravity = createOAuthAuthorizeMethod({
  redirectUri: callbackUrl(),
  authorizeFn: async () => {
    const state = randomBytes2(32).toString("hex");
    return { url: buildAuthUrl(state), verifier: "", state };
  },
  exchangeFn: (code) => exchangeCode(code),
  resolveProjectContextFn: async (auth, accessToken) => {
    const projectId = await resolveProject(accessToken);
    void refreshModels(accessToken, projectId);
    const { refreshToken } = parseRefreshParts(auth.refresh);
    return { auth: { ...auth, refresh: formatRefreshParts({ refreshToken, projectId }) } };
  }
});

// src/plugin/request/prepare.ts
import { randomUUID as randomUUID5 } from "crypto";

// src/plugin/model-config.ts
var MODEL_PREFIX_RE = /^(?:google\/|models\/)+/;
var GEMINI_VERSION_RE = /^gemini(?:-live)?-(\d+)(?:\.(\d+))?(?:\b|-|$)/;
var IMAGE_MODEL_RE = /(?:^|-)image(?:-|$)|^imagen(?:-|$)/;
function normalizeModelId(modelId) {
  return modelId.trim().toLowerCase().replace(MODEL_PREFIX_RE, "");
}
function getGeminiModelCapabilities(modelId) {
  const normalized = normalizeModelId(modelId);
  if (!normalized) {
    return {
      family: "unknown",
      thinkingMode: "none",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false
    };
  }
  const versionMatch = normalized.match(GEMINI_VERSION_RE);
  const major = versionMatch ? Number(versionMatch[1]) : null;
  const minor = versionMatch && versionMatch[2] !== void 0 ? Number(versionMatch[2]) : null;
  if (IMAGE_MODEL_RE.test(normalized)) {
    const isGemini3OrNewer = major !== null && major >= 3;
    return {
      family: "gemini-image",
      thinkingMode: "none",
      usesFunctionCallIds: isGemini3OrNewer,
      requiresThoughtSignatureFallback: isGemini3OrNewer
    };
  }
  if (major !== null) {
    if (major >= 3) {
      return {
        family: "gemini-3",
        thinkingMode: "level",
        usesFunctionCallIds: true,
        requiresThoughtSignatureFallback: true
      };
    }
    if (major === 2 && minor === 5) {
      return {
        family: "gemini-2.5",
        thinkingMode: "budget",
        usesFunctionCallIds: false,
        requiresThoughtSignatureFallback: false
      };
    }
    if (major === 2) {
      return {
        family: "gemini-2.0",
        thinkingMode: "none",
        usesFunctionCallIds: false,
        requiresThoughtSignatureFallback: false
      };
    }
    return {
      family: "gemini-1.x",
      thinkingMode: "none",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false
    };
  }
  if (normalized === "gemini-pro" || normalized === "gemini-pro-vision" || normalized.startsWith("gemini-robotics-")) {
    return {
      family: "gemini-1.x",
      thinkingMode: "none",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false
    };
  }
  if (normalized.startsWith("gemini-")) {
    return {
      family: "unknown",
      thinkingMode: "none",
      usesFunctionCallIds: true,
      requiresThoughtSignatureFallback: true
    };
  }
  return {
    family: "unknown",
    thinkingMode: "none",
    usesFunctionCallIds: false,
    requiresThoughtSignatureFallback: false
  };
}

// src/plugin/request-helpers/types.ts
var GEMINI_PREVIEW_LINK = "https://goo.gle/enable-preview-features";
var CLOUDCODE_DOMAINS = [
  "cloudcode-pa.googleapis.com",
  "staging-cloudcode-pa.googleapis.com",
  "autopush-cloudcode-pa.googleapis.com",
  "cloudaicompanion.googleapis.com"
];

// src/plugin/request-helpers/thinking.ts
function normalizeThinkingConfig(config, options) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return void 0;
  }
  const thinkingMode = options?.thinkingMode;
  if (thinkingMode === "none") {
    return void 0;
  }
  const record = config;
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const levelRaw = record.thinkingLevel ?? record.thinking_level;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;
  const thinkingBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : void 0;
  const thinkingLevel = typeof levelRaw === "string" && levelRaw.trim().length > 0 ? levelRaw.trim().toLowerCase() : void 0;
  const includeThoughts = typeof includeRaw === "boolean" ? includeRaw : void 0;
  const effectiveBudget = thinkingMode === "level" ? void 0 : thinkingBudget;
  const effectiveLevel = thinkingMode === "budget" ? void 0 : thinkingLevel;
  if (effectiveBudget === void 0 && effectiveLevel === void 0 && (thinkingBudget !== void 0 || thinkingLevel !== void 0)) {
    return void 0;
  }
  if (effectiveBudget === void 0 && effectiveLevel === void 0 && includeThoughts === void 0) {
    return void 0;
  }
  const budgetEnabled = effectiveBudget !== void 0 && (effectiveBudget > 0 || effectiveBudget === -1);
  const levelEnabled = effectiveLevel !== void 0 && effectiveLevel !== "none" && effectiveLevel !== "off";
  const thinkingEnabled = budgetEnabled || levelEnabled;
  const finalIncludeThoughts = thinkingEnabled ? includeThoughts ?? false : false;
  const normalized = {};
  if (effectiveBudget !== void 0) {
    normalized.thinkingBudget = effectiveBudget;
  }
  if (effectiveLevel !== void 0) {
    normalized.thinkingLevel = effectiveLevel;
  }
  normalized.includeThoughts = finalIncludeThoughts;
  return normalized;
}

// src/plugin/request-helpers/parsing.ts
function parseGeminiApiBody(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      const firstObject = parsed.find(
        (item) => typeof item === "object" && item !== null && !Array.isArray(item)
      );
      return firstObject && typeof firstObject === "object" && !Array.isArray(firstObject) ? firstObject : null;
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function extractUsageMetadata(body) {
  const responseUsage = body.response && typeof body.response === "object" && !Array.isArray(body.response) ? body.response.usageMetadata : void 0;
  const usage = responseUsage ?? body.usageMetadata;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  const asRecord = usage;
  const toNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
  return {
    totalTokenCount: toNumber(asRecord.totalTokenCount),
    promptTokenCount: toNumber(asRecord.promptTokenCount),
    candidatesTokenCount: toNumber(asRecord.candidatesTokenCount),
    cachedContentTokenCount: toNumber(asRecord.cachedContentTokenCount)
  };
}

// src/plugin/request-helpers/errors.ts
function rewriteGeminiPreviewAccessError(body, status, requestedModel) {
  if (!needsPreviewAccessOverride(status, body, requestedModel)) {
    return null;
  }
  const error = body.error ?? {};
  const trimmedMessage = typeof error.message === "string" ? error.message.trim() : "";
  const messagePrefix = trimmedMessage.length > 0 ? trimmedMessage : "Gemini 3 preview features are not enabled for this account.";
  const enhancedMessage = `${messagePrefix} Request preview access at ${GEMINI_PREVIEW_LINK} before using Gemini 3 models.`;
  return {
    ...body,
    error: {
      ...error,
      message: enhancedMessage
    }
  };
}
function enhanceGeminiErrorResponse(body, status) {
  const error = body.error;
  if (!error) {
    return null;
  }
  const details = Array.isArray(error.details) ? error.details : [];
  const retryAfterMs = extractRetryDelay(details, error.message) ?? void 0;
  if (status === 403) {
    const validationInfo = extractValidationInfo(details);
    if (validationInfo) {
      const message = [
        error.message ?? "Account validation required for Gemini Code Assist.",
        validationInfo.link ? `Complete validation: ${validationInfo.link}` : void 0,
        validationInfo.learnMore ? `Learn more: ${validationInfo.learnMore}` : void 0
      ].filter(Boolean).join(" ");
      return {
        body: {
          ...body,
          error: {
            ...error,
            message
          }
        },
        retryAfterMs
      };
    }
  }
  if (status === 429) {
    const quotaInfo = extractQuotaInfo(details);
    if (quotaInfo) {
      const rawMessage = typeof error.message === "string" ? error.message.trim() : "";
      const isGenericMessage = !rawMessage || /^(?:rate limit(?:ed)?|quota exhausted|rate limit exceeded)$/i.test(rawMessage);
      const detailSuffix = !isGenericMessage ? ` (${rawMessage})` : "";
      let baseMessage;
      if (!quotaInfo.retryable) {
        baseMessage = "Quota exhausted (quota exceeded) for this account. Please wait for your quota to reset or upgrade your plan.";
      } else if (quotaInfo.reason === "MODEL_CAPACITY_EXHAUSTED") {
        baseMessage = `Model capacity temporarily exhausted. ${retryAfterMs ? "Please retry shortly." : "Please retry."}`;
      } else {
        baseMessage = `Rate limit exceeded. ${retryAfterMs ? "Please retry shortly." : "Please retry."}`;
      }
      return {
        body: {
          ...body,
          error: {
            ...error,
            message: `${baseMessage}${detailSuffix}`
          }
        },
        retryAfterMs
      };
    }
  }
  return retryAfterMs !== void 0 ? { retryAfterMs } : null;
}
function needsPreviewAccessOverride(status, body, requestedModel) {
  if (status !== 404) {
    return false;
  }
  if (isGeminiThreeModel(requestedModel)) {
    return true;
  }
  return isGeminiThreeModel(typeof body.error?.message === "string" ? body.error.message : "");
}
function isGeminiThreeModel(target) {
  return !!target && /gemini[\s-]?3/i.test(target);
}
function isErrorInfoDetail(detail) {
  return typeof detail === "object" && detail !== null && detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo";
}
function extractValidationInfo(details) {
  const errorInfo = details.find(
    (detail) => isErrorInfoDetail(detail) && detail.reason === "VALIDATION_REQUIRED" && typeof detail.domain === "string" && CLOUDCODE_DOMAINS.includes(detail.domain)
  );
  if (!errorInfo) {
    return null;
  }
  const helpDetail = details.find(
    (detail) => typeof detail === "object" && detail !== null && detail["@type"] === "type.googleapis.com/google.rpc.Help"
  );
  let link;
  let learnMore;
  if (helpDetail?.links && helpDetail.links.length > 0) {
    const learnMoreLink = helpDetail.links.find((candidate) => {
      if (!candidate?.url) {
        return false;
      }
      if (candidate.description?.toLowerCase().trim() === "learn more") {
        return true;
      }
      try {
        return new URL(candidate.url).hostname === "support.google.com";
      } catch {
        return false;
      }
    });
    learnMore = learnMoreLink?.url;
    link = helpDetail.links.find((candidate) => candidate?.url && candidate !== learnMoreLink)?.url;
  }
  if (!link && errorInfo.metadata?.validation_link) {
    link = errorInfo.metadata.validation_link;
  }
  return link || learnMore ? { link, learnMore } : null;
}
function extractQuotaInfo(details) {
  const errorInfos = details.filter(isErrorInfoDetail);
  for (const errorInfo of errorInfos) {
    if (errorInfo.reason === "RATE_LIMIT_EXCEEDED") {
      return { retryable: true, reason: "RATE_LIMIT_EXCEEDED" };
    }
    if (errorInfo.reason === "MODEL_CAPACITY_EXHAUSTED") {
      return { retryable: true, reason: "MODEL_CAPACITY_EXHAUSTED" };
    }
    if (errorInfo.reason === "QUOTA_EXHAUSTED") {
      return { retryable: false, reason: "QUOTA_EXHAUSTED" };
    }
  }
  const quotaFailure = details.find(
    (detail) => typeof detail === "object" && detail !== null && detail["@type"] === "type.googleapis.com/google.rpc.QuotaFailure"
  );
  if (!quotaFailure?.violations?.length) {
    return null;
  }
  const violationText = quotaFailure.violations.map((violation) => `${violation.quotaId ?? ""} ${violation.description ?? ""}`.toLowerCase()).join(" ");
  if (violationText.includes("daily") || violationText.includes("per day") || violationText.includes("perday")) {
    return { retryable: false, reason: "QUOTA_EXHAUSTED" };
  }
  return { retryable: true };
}
function extractRetryDelay(details, errorMessage) {
  const retryInfo = details.find(
    (detail) => typeof detail === "object" && detail !== null && detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
  );
  if (retryInfo?.retryDelay) {
    const delayMs = parseRetryDelayValue(retryInfo.retryDelay);
    if (delayMs !== null) {
      return delayMs;
    }
  }
  return parseRetryDelayFromMessage(errorMessage);
}
function parseRetryDelayFromMessage(errorMessage) {
  if (!errorMessage) {
    return null;
  }
  const retryMatch = errorMessage.match(/Please retry in ([0-9.]+(?:ms|s))/i);
  if (retryMatch?.[1]) {
    return parseRetryDelayValue(retryMatch[1]);
  }
  const resetMatch = errorMessage.match(/after\s+([0-9.]+(?:ms|s))/i);
  if (resetMatch?.[1]) {
    return parseRetryDelayValue(resetMatch[1]);
  }
  return null;
}
function parseRetryDelayValue(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.endsWith("ms")) {
      const ms = Number(trimmed.slice(0, -2));
      return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
    }
    const match = trimmed.match(/^([\d.]+)s$/);
    if (match?.[1]) {
      const seconds2 = Number(match[1]);
      return Number.isFinite(seconds2) && seconds2 > 0 ? Math.round(seconds2 * 1e3) : null;
    }
    return null;
  }
  const seconds = typeof value.seconds === "number" ? value.seconds : 0;
  const nanos = typeof value.nanos === "number" ? value.nanos : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
    return null;
  }
  const totalMs = Math.round(seconds * 1e3 + nanos / 1e6);
  return totalMs > 0 ? totalMs : null;
}

// src/plugin/request/identifiers.ts
import { randomUUID as randomUUID3 } from "crypto";

// src/plugin/request/shared.ts
var REQUEST_MODEL_FALLBACKS = {
  "gemini-2.5-flash-image": "gemini-2.5-flash"
};
function toRequestUrlString(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  const candidate = value.url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}
function isGenerativeLanguageRequest(input) {
  try {
    return new URL(toRequestUrlString(input)).hostname === "generativelanguage.googleapis.com";
  } catch {
    return false;
  }
}
function parseGenerativeLanguageRequest(input) {
  const match = toRequestUrlString(input).match(/\/models\/([^:]+):(\w+)/);
  if (!match) {
    return void 0;
  }
  const [, requestedModel = "", action = ""] = match;
  return {
    requestedModel,
    effectiveModel: REQUEST_MODEL_FALLBACKS[requestedModel] ?? requestedModel,
    action
  };
}
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function readString(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function pickString(...values) {
  for (const value of values) {
    const str = readString(value);
    if (str) {
      return str;
    }
  }
  return void 0;
}
function injectResponseIdFromTrace(body) {
  const traceId = readString(body.traceId);
  if (!traceId) {
    return body;
  }
  const response = body.response;
  if (!isRecord(response)) {
    return body;
  }
  if (readString(response.responseId)) {
    return body;
  }
  return {
    ...body,
    response: {
      ...response,
      responseId: traceId
    }
  };
}

// src/plugin/request/identifiers.ts
var PROCESS_SESSION_ID = randomUUID3();
function resolveUserPromptId(payload, request) {
  const extra = isRecord(payload.extra_body) ? payload.extra_body : void 0;
  const requestExtra = isRecord(request?.extra_body) ? request.extra_body : void 0;
  return pickString(
    payload.user_prompt_id,
    payload.userPromptId,
    payload.prompt_id,
    payload.promptId,
    payload.request_id,
    payload.requestId,
    request?.user_prompt_id,
    request?.userPromptId,
    request?.prompt_id,
    request?.promptId,
    request?.request_id,
    request?.requestId,
    extra?.user_prompt_id,
    extra?.userPromptId,
    extra?.prompt_id,
    extra?.promptId,
    extra?.request_id,
    extra?.requestId,
    requestExtra?.user_prompt_id,
    requestExtra?.userPromptId,
    requestExtra?.prompt_id,
    requestExtra?.promptId,
    requestExtra?.request_id,
    requestExtra?.requestId
  ) ?? randomUUID3();
}
function resolveSessionId(payload, request) {
  const extra = isRecord(payload.extra_body) ? payload.extra_body : void 0;
  const requestExtra = isRecord(request?.extra_body) ? request.extra_body : void 0;
  return pickString(
    request?.session_id,
    request?.sessionId,
    payload.session_id,
    payload.sessionId,
    extra?.session_id,
    extra?.sessionId,
    requestExtra?.session_id,
    requestExtra?.sessionId
  ) ?? PROCESS_SESSION_ID;
}
function stripPromptIdentifierAliases(payload, keepCanonical = false) {
  if (!keepCanonical) {
    delete payload.user_prompt_id;
  }
  delete payload.userPromptId;
  delete payload.prompt_id;
  delete payload.promptId;
  delete payload.request_id;
  delete payload.requestId;
}
function stripSessionIdentifierAliases(payload, keepCanonical = false) {
  if (!keepCanonical) {
    delete payload.session_id;
  }
  delete payload.sessionId;
}
function stripExtraBodyIdentifierAliases(payload) {
  if (!isRecord(payload.extra_body)) {
    return;
  }
  const extra = { ...payload.extra_body };
  stripPromptIdentifierAliases(extra, false);
  stripSessionIdentifierAliases(extra, false);
  if (Object.keys(extra).length === 0) {
    delete payload.extra_body;
  } else {
    payload.extra_body = extra;
  }
}
function normalizeWrappedIdentifiers(wrapped) {
  const request = isRecord(wrapped.request) ? { ...wrapped.request } : {};
  const userPromptId = resolveUserPromptId(wrapped, request);
  const sessionId = resolveSessionId(wrapped, request);
  request.session_id = sessionId;
  stripSessionIdentifierAliases(request, true);
  stripPromptIdentifierAliases(request, false);
  stripExtraBodyIdentifierAliases(request);
  wrapped.request = request;
  wrapped.user_prompt_id = userPromptId;
  stripPromptIdentifierAliases(wrapped, true);
  stripSessionIdentifierAliases(wrapped, false);
  stripExtraBodyIdentifierAliases(wrapped);
  return { userPromptId, sessionId };
}
function normalizeRequestPayloadIdentifiers(payload) {
  const userPromptId = resolveUserPromptId(payload);
  const sessionId = resolveSessionId(payload);
  payload.session_id = sessionId;
  stripSessionIdentifierAliases(payload, true);
  stripPromptIdentifierAliases(payload, false);
  stripExtraBodyIdentifierAliases(payload);
  return { userPromptId, sessionId };
}

// src/plugin/request/openai.ts
import { randomUUID as randomUUID4 } from "crypto";
var THOUGHT_SIGNATURE_FALLBACK = "skip_thought_signature_validator";
var INTERRUPTED_TOOL_ERROR = "Tool call was interrupted before receiving a response.";
function makeFunctionCallId(name) {
  return `${name}__${randomUUID4()}`;
}
function transformOpenAIToolCalls(requestPayload, modelId) {
  const messages = requestPayload.messages;
  if (!messages || !Array.isArray(messages)) {
    return;
  }
  const capabilities = modelId ? getGeminiModelCapabilities(modelId) : void 0;
  const usesIds = capabilities ? capabilities.usesFunctionCallIds : true;
  const needsSignatureFallback = capabilities ? capabilities.requiresThoughtSignatureFallback : true;
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const msgObj = message;
    const toolCalls = msgObj.tool_calls;
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      continue;
    }
    const parts = [];
    if (typeof msgObj.content === "string" && msgObj.content.length > 0) {
      parts.push({ text: msgObj.content });
    }
    let attachedSignatureFallback = false;
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) {
        continue;
      }
      const fn = toolCall.function;
      if (!isRecord(fn)) {
        continue;
      }
      const resolvedName = readString(fn.name) ?? "";
      const args = parseJsonObject(fn.arguments);
      const functionCall = {
        name: resolvedName,
        args
      };
      if (usesIds) {
        functionCall.id = readString(toolCall.id) ?? makeFunctionCallId(resolvedName);
      }
      const part = { functionCall };
      if (needsSignatureFallback && !attachedSignatureFallback) {
        part.thoughtSignature = THOUGHT_SIGNATURE_FALLBACK;
        attachedSignatureFallback = true;
      }
      parts.push(part);
    }
    msgObj.parts = parts;
    delete msgObj.tool_calls;
    delete msgObj.content;
  }
}
function addThoughtSignaturesToFunctionCalls(requestPayload, modelId) {
  const capabilities = modelId ? getGeminiModelCapabilities(modelId) : void 0;
  const usesIds = capabilities ? capabilities.usesFunctionCallIds : true;
  const needsSignatureFallback = capabilities ? capabilities.requiresThoughtSignatureFallback : true;
  const processContents = (contents) => {
    if (!contents || !Array.isArray(contents)) {
      return;
    }
    for (const content of contents) {
      if (!isRecord(content)) {
        continue;
      }
      const parts = content.parts;
      if (!parts || !Array.isArray(parts)) {
        continue;
      }
      let hasTurnSignature = parts.some(
        (part) => isRecord(part) && isRecord(part.functionCall) && typeof part.thoughtSignature === "string" && part.thoughtSignature.length > 0
      );
      for (const part of parts) {
        if (!isRecord(part) || !isRecord(part.functionCall)) {
          continue;
        }
        if (needsSignatureFallback && !hasTurnSignature) {
          part.thoughtSignature = THOUGHT_SIGNATURE_FALLBACK;
          hasTurnSignature = true;
        }
        const fc = part.functionCall;
        if (usesIds && !readString(fc.id)) {
          fc.id = makeFunctionCallId(readString(fc.name) ?? "");
        }
      }
    }
  };
  processContents(requestPayload.contents);
  if (isRecord(requestPayload.request)) {
    processContents(requestPayload.request.contents);
  }
}
function makePlaceholderFunctionResponse(call, usesIds) {
  const functionResponse = {
    name: call.name,
    response: { error: INTERRUPTED_TOOL_ERROR }
  };
  if (usesIds && call.id) {
    functionResponse.id = call.id;
  }
  return { functionResponse };
}
function takeMatchingPendingCallIndex(pendingCalls, functionResponse) {
  const responseId = readString(functionResponse.id);
  if (responseId) {
    const byId = pendingCalls.findIndex((call) => call.id === responseId);
    if (byId !== -1) {
      return byId;
    }
  }
  const responseName = readString(functionResponse.name) ?? "";
  return pendingCalls.findIndex((call) => call.name === responseName);
}
function repairGeminiToolPairs(contents, modelId) {
  const capabilities = modelId ? getGeminiModelCapabilities(modelId) : void 0;
  const usesIds = capabilities ? capabilities.usesFunctionCallIds : true;
  const repaired = [];
  let pendingCalls = [];
  const flushPendingCalls = () => {
    if (pendingCalls.length === 0) {
      return;
    }
    repaired.push({
      role: "user",
      parts: pendingCalls.map((call) => makePlaceholderFunctionResponse(call, usesIds))
    });
    pendingCalls = [];
  };
  for (const content of contents) {
    if (!isRecord(content) || !Array.isArray(content.parts)) {
      flushPendingCalls();
      repaired.push(content);
      continue;
    }
    if (content.role === "model") {
      flushPendingCalls();
      for (const part of content.parts) {
        if (isRecord(part) && isRecord(part.functionCall)) {
          pendingCalls.push({
            id: readString(part.functionCall.id),
            name: readString(part.functionCall.name) ?? ""
          });
        }
      }
      repaired.push(content);
      continue;
    }
    const frParts = [];
    const otherParts = [];
    for (const part of content.parts) {
      if (isRecord(part) && isRecord(part.functionResponse)) {
        frParts.push(part);
      } else {
        otherParts.push(part);
      }
    }
    if (pendingCalls.length === 0) {
      if (otherParts.length > 0) {
        repaired.push(
          frParts.length === 0 ? content : { ...content, parts: otherParts }
        );
      }
      continue;
    }
    const matchedFrParts = [];
    for (const frPart of frParts) {
      const fnResp = frPart.functionResponse;
      const matchIndex = takeMatchingPendingCallIndex(pendingCalls, fnResp);
      if (matchIndex !== -1) {
        pendingCalls.splice(matchIndex, 1);
        matchedFrParts.push(frPart);
      }
    }
    const missingPlaceholderParts = pendingCalls.map(
      (call) => makePlaceholderFunctionResponse(call, usesIds)
    );
    pendingCalls = [];
    const combinedFrParts = [...matchedFrParts, ...missingPlaceholderParts];
    if (matchedFrParts.length === 0 && otherParts.length > 0) {
      repaired.push({
        role: "user",
        parts: combinedFrParts
      });
      repaired.push({
        ...content,
        parts: otherParts
      });
    } else if (combinedFrParts.length > 0 || otherParts.length > 0) {
      repaired.push({
        ...content,
        parts: [...combinedFrParts, ...otherParts]
      });
    }
  }
  flushPendingCalls();
  return repaired;
}
function parseJsonObject(value) {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// src/plugin/request/prepare.ts
var STREAM_ACTION = "streamGenerateContent";
function prepareGeminiRequest(input, init, accessToken, projectId, thinkingConfigDefaults) {
  const baseInit = { ...init };
  const resolvedHeadersSource = init?.headers !== void 0 ? init.headers : input instanceof Request ? input.headers : void 0;
  const headers = new Headers(resolvedHeadersSource);
  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false
    };
  }
  const requestTarget = parseGenerativeLanguageRequest(input);
  if (!requestTarget) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false
    };
  }
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");
  headers.delete("x-goog-api-key");
  const { requestedModel: rawModel, effectiveModel, action: rawAction } = requestTarget;
  const streaming = rawAction === STREAM_ACTION;
  const transformedUrl = `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:${rawAction}${streaming ? "?alt=sse" : ""}`;
  let body = baseInit.body;
  if (typeof baseInit.body === "string" && baseInit.body) {
    const transformed = transformRequestBody(
      baseInit.body,
      projectId,
      effectiveModel,
      rawModel,
      thinkingConfigDefaults
    );
    if (transformed.body) {
      body = transformed.body;
    }
  }
  if (streaming) {
    headers.set("Accept", "text/event-stream");
  }
  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body
    },
    streaming,
    requestedModel: rawModel
  };
}
function sanitizeRequestPayload(requestPayload, effectiveModel, requestedModel, thinkingConfigDefaults) {
  const capabilities = getGeminiModelCapabilities(effectiveModel);
  const thinkingMode = capabilities.family === "unknown" ? void 0 : capabilities.thinkingMode;
  transformOpenAIToolCalls(requestPayload, effectiveModel);
  stripThoughtPartsFromHistory(requestPayload);
  if (Array.isArray(requestPayload.contents)) {
    requestPayload.contents = repairGeminiToolPairs(requestPayload.contents, effectiveModel);
  }
  addThoughtSignaturesToFunctionCalls(requestPayload, effectiveModel);
  normalizeThinking(
    requestPayload,
    resolveDefaultThinkingConfig(thinkingConfigDefaults, requestedModel, effectiveModel),
    thinkingConfigDefaults?.provider,
    thinkingMode
  );
  normalizeSystemInstruction(requestPayload);
  normalizeCachedContent(requestPayload);
  if ("model" in requestPayload) {
    delete requestPayload.model;
  }
}
function transformRequestBody(body, projectId, effectiveModel, requestedModel, thinkingConfigDefaults) {
  const fallbackId = randomUUID5();
  try {
    const parsedBody = JSON.parse(body);
    if (!isRecord(parsedBody)) {
      return { userPromptId: fallbackId };
    }
    const isWrapped = typeof parsedBody.project === "string" && isRecord(parsedBody.request);
    if (isWrapped) {
      const requestPayload2 = { ...parsedBody.request };
      sanitizeRequestPayload(
        requestPayload2,
        effectiveModel,
        requestedModel,
        thinkingConfigDefaults
      );
      const wrappedBody2 = {
        ...parsedBody,
        model: effectiveModel,
        request: requestPayload2
      };
      const { userPromptId: userPromptId2 } = normalizeWrappedIdentifiers(wrappedBody2);
      return { body: JSON.stringify(wrappedBody2), userPromptId: userPromptId2 };
    }
    const requestPayload = { ...parsedBody };
    sanitizeRequestPayload(
      requestPayload,
      effectiveModel,
      requestedModel,
      thinkingConfigDefaults
    );
    const { userPromptId } = normalizeRequestPayloadIdentifiers(requestPayload);
    const wrappedBody = {
      project: projectId,
      model: effectiveModel,
      user_prompt_id: userPromptId,
      request: requestPayload
    };
    return { body: JSON.stringify(wrappedBody), userPromptId };
  } catch (error) {
    console.error("Failed to transform Gemini request body:", error);
    return { userPromptId: fallbackId };
  }
}
function resolveDefaultThinkingConfig(thinkingConfigDefaults, requestedModel, effectiveModel) {
  if (!thinkingConfigDefaults?.models) {
    return void 0;
  }
  return thinkingConfigDefaults.models[requestedModel] ?? thinkingConfigDefaults.models[effectiveModel];
}
function normalizeThinking(requestPayload, modelThinkingConfig, providerThinkingConfig, thinkingMode) {
  const rawGenerationConfig = isRecord(requestPayload.generationConfig) ? { ...requestPayload.generationConfig } : void 0;
  const hasRootThinkingConfig = Object.prototype.hasOwnProperty.call(requestPayload, "thinkingConfig");
  const hasRequestThinkingConfig = hasRootThinkingConfig || !!rawGenerationConfig && Object.prototype.hasOwnProperty.call(rawGenerationConfig, "thinkingConfig");
  const mergedDefaultThinking = isRecord(providerThinkingConfig) && isRecord(modelThinkingConfig) ? { ...providerThinkingConfig, ...modelThinkingConfig } : modelThinkingConfig ?? providerThinkingConfig;
  const sourceThinkingConfig = hasRootThinkingConfig ? requestPayload.thinkingConfig : hasRequestThinkingConfig ? rawGenerationConfig?.thinkingConfig : mergedDefaultThinking;
  const normalizedThinking = normalizeThinkingConfig(
    sourceThinkingConfig,
    thinkingMode ? { thinkingMode } : void 0
  );
  if (hasRootThinkingConfig) {
    delete requestPayload.thinkingConfig;
  }
  if (normalizedThinking) {
    if (rawGenerationConfig) {
      rawGenerationConfig.thinkingConfig = normalizedThinking;
      requestPayload.generationConfig = rawGenerationConfig;
    } else {
      requestPayload.generationConfig = { thinkingConfig: normalizedThinking };
    }
    return;
  }
  if (hasRequestThinkingConfig && rawGenerationConfig) {
    delete rawGenerationConfig.thinkingConfig;
    requestPayload.generationConfig = rawGenerationConfig;
  }
}
function normalizeSystemInstruction(requestPayload) {
  if ("system_instruction" in requestPayload) {
    requestPayload.systemInstruction = requestPayload.system_instruction;
    delete requestPayload.system_instruction;
  }
}
function normalizeCachedContent(requestPayload) {
  const extraBody = isRecord(requestPayload.extra_body) ? { ...requestPayload.extra_body } : void 0;
  const cachedContentFromExtra = extraBody?.cached_content ?? extraBody?.cachedContent;
  const cachedContent = readString(requestPayload.cached_content) ?? readString(requestPayload.cachedContent) ?? readString(cachedContentFromExtra);
  if (cachedContent) {
    requestPayload.cachedContent = cachedContent;
  }
  delete requestPayload.cached_content;
  if (!extraBody) {
    return;
  }
  delete extraBody.cached_content;
  delete extraBody.cachedContent;
  if (Object.keys(extraBody).length === 0) {
    delete requestPayload.extra_body;
  } else {
    requestPayload.extra_body = extraBody;
  }
}
function stripThoughtPartsFromHistory(requestPayload) {
  const contents = requestPayload.contents;
  if (!Array.isArray(contents)) {
    return;
  }
  const sanitizedContents = [];
  for (const content of contents) {
    if (!isRecord(content)) {
      sanitizedContents.push(content);
      continue;
    }
    const parts = Array.isArray(content.parts) ? content.parts : void 0;
    if (!parts) {
      sanitizedContents.push(content);
      continue;
    }
    let rescuedSignature;
    const keptParts = [];
    for (const part of parts) {
      if (isRecord(part) && part.thought === true) {
        if (!rescuedSignature) {
          rescuedSignature = readString(part.thoughtSignature);
        }
        continue;
      }
      keptParts.push(isRecord(part) ? { ...part } : part);
    }
    if (keptParts.length === 0 && content.role === "model") {
      continue;
    }
    if (rescuedSignature && content.role === "model") {
      const hasExistingSignature = keptParts.some(
        (part) => isRecord(part) && Boolean(readString(part.thoughtSignature))
      );
      if (!hasExistingSignature) {
        const targetPart = keptParts.find((part) => isRecord(part) && isRecord(part.functionCall)) ?? keptParts.find((part) => isRecord(part));
        if (isRecord(targetPart)) {
          targetPart.thoughtSignature = rescuedSignature;
        }
      }
    }
    sanitizedContents.push({
      ...content,
      parts: keptParts
    });
  }
  requestPayload.contents = sanitizedContents;
}

// src/plugin/request/response.ts
function parseGeminiSseBody(rawText) {
  const dataLines = [];
  let lastParsed = null;
  const flush = () => {
    if (dataLines.length === 0) {
      return;
    }
    const payload = dataLines.join("\n").trim();
    dataLines.length = 0;
    if (!payload || payload === "[DONE]") {
      return;
    }
    const parsed = parseGeminiApiBody(payload);
    if (parsed) {
      lastParsed = parsed;
    }
  };
  for (const rawLine of rawText.split(/\r?\n/)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  flush();
  return lastParsed;
}
async function transformGeminiResponse(response, streaming, debugContext, requestedModel) {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");
  if (!isJsonResponse && !isEventStreamResponse) {
    logGeminiDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)"
    });
    return response;
  }
  let bufferedText = null;
  try {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    if (streaming && response.ok && isEventStreamResponse && response.body) {
      logGeminiDebugResponse(debugContext, response, {
        note: "Streaming SSE payload (body omitted)",
        headersOverride: headers
      });
      return new Response(transformStreamingPayloadStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }
    const text = await response.text();
    bufferedText = text;
    const init = {
      status: response.status,
      statusText: response.statusText,
      headers
    };
    const parsedJson = parseGeminiApiBody(text);
    const parsedFromSse = !parsedJson && isEventStreamResponse ? parseGeminiSseBody(text) : null;
    const parsed = parsedJson ?? parsedFromSse;
    const enhanced = !response.ok && parsed ? enhanceGeminiErrorResponse(parsed, response.status) : null;
    if (enhanced?.retryAfterMs) {
      const retryAfterSec = Math.ceil(enhanced.retryAfterMs / 1e3).toString();
      headers.set("Retry-After", retryAfterSec);
      headers.set("retry-after-ms", String(enhanced.retryAfterMs));
    }
    const previewPatched = parsed ? rewriteGeminiPreviewAccessError(enhanced?.body ?? parsed, response.status, requestedModel) : null;
    const effectiveBodyRaw = previewPatched ?? enhanced?.body ?? parsed ?? void 0;
    const effectiveBody = effectiveBodyRaw && isRecord(effectiveBodyRaw) ? injectResponseIdFromTrace(effectiveBodyRaw) : effectiveBodyRaw;
    attachUsageHeaders(headers, effectiveBody);
    logGeminiDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (buffered)" : void 0,
      headersOverride: headers
    });
    if (!parsed) {
      return new Response(text, init);
    }
    if (effectiveBody && isRecord(effectiveBody) && "response" in effectiveBody) {
      if (isEventStreamResponse) {
        headers.set("content-type", "application/json; charset=utf-8");
      }
      return new Response(JSON.stringify(effectiveBody.response), init);
    }
    const wasModified = Boolean(enhanced?.body) || Boolean(previewPatched) || effectiveBody !== void 0 && effectiveBody !== parsed || Boolean(parsedFromSse);
    if (effectiveBody && wasModified) {
      if (isEventStreamResponse) {
        headers.set("content-type", "application/json; charset=utf-8");
      }
      return new Response(JSON.stringify(effectiveBody), init);
    }
    return new Response(text, init);
  } catch (error) {
    logGeminiDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Gemini response"
    });
    console.error("Failed to transform Gemini response:", error);
    if (bufferedText !== null) {
      const fallbackHeaders = new Headers(response.headers);
      fallbackHeaders.delete("content-length");
      fallbackHeaders.delete("content-encoding");
      return new Response(bufferedText, {
        status: response.status,
        statusText: response.statusText,
        headers: fallbackHeaders
      });
    }
    return response;
  }
}
function attachUsageHeaders(headers, effectiveBody) {
  if (!isRecord(effectiveBody)) {
    return;
  }
  const usage = extractUsageMetadata(effectiveBody);
  if (!usage) {
    return;
  }
  if (usage.cachedContentTokenCount !== void 0) {
    headers.set("x-gemini-cached-content-token-count", String(usage.cachedContentTokenCount));
  }
  if (usage.totalTokenCount !== void 0) {
    headers.set("x-gemini-total-token-count", String(usage.totalTokenCount));
  }
  if (usage.promptTokenCount !== void 0) {
    headers.set("x-gemini-prompt-token-count", String(usage.promptTokenCount));
  }
  if (usage.candidatesTokenCount !== void 0) {
    headers.set("x-gemini-candidates-token-count", String(usage.candidatesTokenCount));
  }
}
function transformStreamingPayloadStream(stream) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let pendingDataLines = [];
  let pendingOtherLines = [];
  let pendingLineEnding = "\n";
  let reader = null;
  const flushEvent = (controller, trailingSeparator) => {
    const hasData = pendingDataLines.length > 0;
    const hasOther = pendingOtherLines.length > 0;
    if (!hasData && !hasOther) {
      if (trailingSeparator) {
        controller.enqueue(encoder.encode(trailingSeparator));
      }
      return;
    }
    const outputLines = [...pendingOtherLines];
    if (hasData) {
      const joinedData = pendingDataLines.join("\n").trim();
      outputLines.push(transformStreamingDataPayload(joinedData));
    }
    pendingDataLines = [];
    pendingOtherLines = [];
    controller.enqueue(encoder.encode(`${outputLines.join(pendingLineEnding)}${trailingSeparator}`));
  };
  const processLine = (rawLine, lineEnding, controller) => {
    if (rawLine === "") {
      const separator = lineEnding ? `${pendingLineEnding}${lineEnding}` : pendingLineEnding;
      flushEvent(controller, separator);
      pendingLineEnding = "\n";
      return;
    }
    if (lineEnding) {
      pendingLineEnding = lineEnding;
    } else if (pendingDataLines.length === 0 && pendingOtherLines.length === 0) {
      pendingLineEnding = "";
    }
    if (rawLine.startsWith("data:")) {
      pendingDataLines.push(rawLine.slice(5).trimStart());
      return;
    }
    pendingOtherLines.push(rawLine);
  };
  return new ReadableStream({
    start(controller) {
      reader = stream.getReader();
      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) {
            buffer += decoder.decode();
            if (buffer.length > 0) {
              const rawLine = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
              buffer = "";
              processLine(rawLine, "", controller);
            }
            flushEvent(controller, pendingLineEnding);
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            const hasCr = line.endsWith("\r");
            const rawLine = hasCr ? line.slice(0, -1) : line;
            processLine(rawLine, hasCr ? "\r\n" : "\n", controller);
            newlineIndex = buffer.indexOf("\n");
          }
          pump();
        }).catch((error) => {
          controller.error(error);
        });
      };
      pump();
    },
    cancel(reason) {
      if (reader) {
        reader.cancel(reason).catch(() => {
        });
      }
    }
  });
}
function transformStreamingDataPayload(json) {
  if (!json || json === "[DONE]") {
    return json ? `data: ${json}` : "data:";
  }
  try {
    const parsed = JSON.parse(json);
    if (!isRecord(parsed)) {
      return `data: ${json}`;
    }
    const patched = injectResponseIdFromTrace(parsed);
    if (patched.response !== void 0) {
      return `data: ${JSON.stringify(patched.response)}`;
    }
    return `data: ${JSON.stringify(patched)}`;
  } catch {
    return `data: ${json}`;
  }
}

// src/plugin/retry/quota.ts
var CLOUDCODE_DOMAINS2 = new Set(CLOUDCODE_DOMAINS);
async function classifyQuotaResponse(response) {
  const payload = await parseErrorBody(response);
  if (!payload) {
    return null;
  }
  const details = Array.isArray(payload.details) ? payload.details : [];
  const retryInfo = details.find(
    (detail) => isObject(detail) && detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
  );
  const retryDelayMs = (retryInfo?.retryDelay ? parseRetryDelayValue(retryInfo.retryDelay) : null) ?? parseRetryDelayFromMessage(payload.message ?? "") ?? void 0;
  const errorInfos = details.filter(
    (detail) => isObject(detail) && detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo"
  );
  const cloudCodeErrorInfos = errorInfos.filter(
    (info) => !info.domain || CLOUDCODE_DOMAINS2.has(info.domain)
  );
  if (errorInfos.length > 0 && cloudCodeErrorInfos.length === 0) {
    return null;
  }
  const prioritizedErrorInfo = cloudCodeErrorInfos.find(
    (info) => info.reason === "QUOTA_EXHAUSTED" || info.reason === "RATE_LIMIT_EXCEEDED" || info.reason === "MODEL_CAPACITY_EXHAUSTED"
  ) ?? cloudCodeErrorInfos[0];
  if (prioritizedErrorInfo?.reason === "QUOTA_EXHAUSTED") {
    return { terminal: true, retryDelayMs, reason: prioritizedErrorInfo.reason };
  }
  if (prioritizedErrorInfo?.reason === "RATE_LIMIT_EXCEEDED") {
    return {
      terminal: false,
      retryDelayMs: retryDelayMs ?? 1e4,
      reason: prioritizedErrorInfo.reason
    };
  }
  if (prioritizedErrorInfo?.reason === "MODEL_CAPACITY_EXHAUSTED") {
    return {
      terminal: retryDelayMs === void 0,
      retryDelayMs,
      reason: prioritizedErrorInfo.reason
    };
  }
  const quotaFailure = details.find(
    (detail) => isObject(detail) && detail["@type"] === "type.googleapis.com/google.rpc.QuotaFailure"
  );
  if (quotaFailure?.violations?.length) {
    const allTexts = quotaFailure.violations.flatMap((violation) => [violation.quotaId ?? "", violation.description ?? ""]).join(" ").toLowerCase();
    if (allTexts.includes("perday") || allTexts.includes("daily") || allTexts.includes("per day")) {
      return { terminal: true, retryDelayMs, reason: prioritizedErrorInfo?.reason };
    }
    if (allTexts.includes("perminute") || allTexts.includes("per minute")) {
      return {
        terminal: false,
        retryDelayMs: retryDelayMs ?? 6e4,
        reason: prioritizedErrorInfo?.reason
      };
    }
    return { terminal: false, retryDelayMs, reason: prioritizedErrorInfo?.reason };
  }
  const quotaLimit = cloudCodeErrorInfos.map((info) => info.metadata?.quota_limit?.toLowerCase() ?? "").find((value) => value.length > 0) ?? "";
  if (quotaLimit.includes("perminute") || quotaLimit.includes("per minute")) {
    return {
      terminal: false,
      retryDelayMs: retryDelayMs ?? 6e4,
      reason: prioritizedErrorInfo?.reason
    };
  }
  return { terminal: false, retryDelayMs, reason: prioritizedErrorInfo?.reason };
}
async function parseRetryDelayFromBody(response) {
  const payload = await parseErrorBody(response);
  if (!payload) {
    return null;
  }
  const details = Array.isArray(payload.details) ? payload.details : [];
  const retryInfo = details.find(
    (detail) => isObject(detail) && detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
  );
  if (retryInfo?.retryDelay) {
    const delayMs = parseRetryDelayValue(retryInfo.retryDelay);
    if (delayMs !== null) {
      return delayMs;
    }
  }
  if (typeof payload.message === "string") {
    return parseRetryDelayFromMessage(payload.message);
  }
  return null;
}
function parseJsonSafe(rawText) {
  try {
    return JSON.parse(rawText);
  } catch {
    return void 0;
  }
}
function extractSseErrorPayloads(rawText) {
  const parsedItems = [];
  const dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) {
      return;
    }
    const payload = dataLines.join("\n").trim();
    dataLines.length = 0;
    if (!payload || payload === "[DONE]") {
      return;
    }
    const parsed = parseJsonSafe(payload);
    if (parsed !== void 0) {
      parsedItems.push(parsed);
    }
  };
  for (const rawLine of rawText.split(/\r?\n/)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  flush();
  return parsedItems;
}
async function parseErrorBody(response) {
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return null;
  }
  if (!text) {
    return null;
  }
  const directParsed = parseJsonSafe(text);
  const candidates = directParsed !== void 0 ? [directParsed] : extractSseErrorPayloads(text);
  for (const candidate of candidates) {
    const normalized = normalizeErrorEnvelope(candidate);
    if (!normalized || !isObject(normalized.error)) {
      continue;
    }
    const error = normalized.error;
    return {
      message: typeof error.message === "string" ? error.message : void 0,
      details: Array.isArray(error.details) ? error.details : void 0
    };
  }
  return null;
}
function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function normalizeErrorEnvelope(parsed) {
  if (Array.isArray(parsed)) {
    const withError = parsed.find((item) => isObject(item) && isObject(item.error));
    if (isObject(withError)) {
      return withError;
    }
    const firstObject = parsed.find(isObject);
    return isObject(firstObject) ? firstObject : null;
  }
  return isObject(parsed) ? parsed : null;
}

// src/plugin/retry/helpers.ts
var DEFAULT_MAX_ATTEMPTS = 3;
var DEFAULT_INITIAL_DELAY_MS = 5e3;
var DEFAULT_MAX_DELAY_MS = 3e4;
var DEFAULT_MAX_RETRY_DELAY_MS = 6e4;
var MODEL_CAPACITY_COOLDOWN_MS = 8e3;
function getMaxRetryDelayMs() {
  const raw = process.env.OPENCODE_GEMINI_MAX_RETRY_MS;
  if (!raw) {
    return DEFAULT_MAX_RETRY_DELAY_MS;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_MAX_RETRY_DELAY_MS;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MAX_RETRY_DELAY_MS;
  }
  return Math.round(parsed);
}
function isRetryableStatus(status) {
  return status === 429 || status >= 500 && status < 600;
}
async function resolveRetryDelayMs(response, attempt, quotaDelayMs) {
  const retryAfterMsHeader = parseRetryAfterMs(response.headers.get("retry-after-ms"));
  if (retryAfterMsHeader !== null) {
    return retryAfterMsHeader;
  }
  const retryAfterHeader = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfterHeader !== null) {
    return retryAfterHeader;
  }
  if (quotaDelayMs !== void 0 && Number.isFinite(quotaDelayMs)) {
    return Math.max(0, Math.round(quotaDelayMs));
  }
  const bodyDelay = await parseRetryDelayFromBody(response);
  if (bodyDelay !== null) {
    return Math.max(0, Math.round(bodyDelay));
  }
  return getExponentialDelayWithJitter(attempt);
}
async function computeGeminiRetryDecision(response, attempt, quotaContext, options) {
  if (!isRetryableStatus(response.status)) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: "non_retryable_status"
    };
  }
  if (response.status === 429 && quotaContext?.terminal) {
    const cooldownMs = quotaContext.reason === "MODEL_CAPACITY_EXHAUSTED" ? quotaContext.retryDelayMs ?? MODEL_CAPACITY_COOLDOWN_MS : void 0;
    return {
      shouldRetry: false,
      delayMs: 0,
      cooldownMs,
      reason: "terminal_quota"
    };
  }
  if (options?.signal?.aborted) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: "aborted"
    };
  }
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (attempt >= maxAttempts) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: "max_attempts_reached"
    };
  }
  const delayMs = await resolveRetryDelayMs(response, attempt, quotaContext?.retryDelayMs);
  const maxRetryDelayMs = options?.maxRetryDelayMs ?? getMaxRetryDelayMs();
  if (delayMs > maxRetryDelayMs) {
    return {
      shouldRetry: false,
      delayMs,
      reason: "retry_delay_exceeds_max"
    };
  }
  return {
    shouldRetry: true,
    delayMs,
    cooldownMs: delayMs > 0 && response.status === 429 ? delayMs : void 0,
    reason: "retryable"
  };
}
function getExponentialDelayWithJitter(attempt) {
  const base = Math.min(DEFAULT_MAX_DELAY_MS, DEFAULT_INITIAL_DELAY_MS * Math.pow(2, attempt - 1));
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return clampDelay(base + jitter);
}
function sleepUnlessAborted(ms, signal) {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== void 0) {
        clearTimeout(timer);
      }
      cleanup();
      resolve();
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    }, ms);
  });
}
function parseRetryAfterMs(value) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed);
}
function parseRetryAfter(value) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1e3);
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }
  return null;
}
function clampDelay(delayMs) {
  if (!Number.isFinite(delayMs)) {
    return DEFAULT_MAX_DELAY_MS;
  }
  return Math.min(Math.max(0, Math.round(delayMs)), DEFAULT_MAX_DELAY_MS);
}

// src/plugin/retry/index.ts
var retryCooldownByKey = /* @__PURE__ */ new Map();
function buildRetryThrottleKey(input, init) {
  const url = readRequestUrl(input);
  const body = typeof init?.body === "string" ? safeParseBody(init.body) : null;
  const project = readString2(body?.project);
  const model = readString2(body?.model);
  return `${url}|${project ?? ""}|${model ?? ""}`;
}
function pruneExpiredCooldowns(now = Date.now()) {
  for (const [key, until] of retryCooldownByKey.entries()) {
    if (until <= now) {
      retryCooldownByKey.delete(key);
    }
  }
}
async function waitForRetryCooldown(key, signal) {
  const until = retryCooldownByKey.get(key);
  if (!until) {
    return;
  }
  const remaining = until - Date.now();
  if (remaining <= 0) {
    if (retryCooldownByKey.get(key) === until) {
      retryCooldownByKey.delete(key);
    }
    return;
  }
  if (signal?.aborted) {
    debugRetry(`cooldown skipped due to abort (key=${shortKey(key)})`);
    return;
  }
  debugRetry(`cooldown wait ${remaining}ms (key=${shortKey(key)})`);
  await sleepUnlessAborted(remaining, signal);
  if (!signal?.aborted && retryCooldownByKey.get(key) === until) {
    retryCooldownByKey.delete(key);
  }
}
function recordRetryCooldown(key, delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return;
  }
  const now = Date.now();
  pruneExpiredCooldowns(now);
  const next = now + Math.round(delayMs);
  const current = retryCooldownByKey.get(key) ?? 0;
  retryCooldownByKey.set(key, Math.max(current, next));
  debugRetry(`cooldown set ${Math.round(delayMs)}ms (key=${shortKey(key)})`);
}
function readRequestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  const request = input;
  if (request.url) {
    return request.url;
  }
  return input.toString();
}
function safeParseBody(body) {
  if (!body) {
    return null;
  }
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
  }
  return null;
}
function readString2(value) {
  return typeof value === "string" && value.trim() ? value : void 0;
}
function debugRetry(message) {
  if (!isGeminiDebugEnabled()) {
    return;
  }
  logGeminiDebugMessage(`Retry: ${message}`);
}
function shortKey(key) {
  return key.length <= 120 ? key : `${key.slice(0, 120)}...`;
}

// src/plugin-v2.ts
var GOOGLE_ID = "google";
var METHOD_ID = Integration.MethodID.make("antigravity");
var MARKER = "opencode.provider.google-oauth";
var QUOTA_TOOL_NAME = "google_quota";
var RECENT_FAILURE_TTL_MS = 3e4;
var catalog;
var projectByToken = /* @__PURE__ */ new Map();
var fallbackAuth = /* @__PURE__ */ new Map();
function toCredential(result) {
  if (result.type !== "success") throw new Error(result.error);
  const { projectId } = parseRefreshParts(result.refresh);
  return {
    type: "oauth",
    methodID: METHOD_ID,
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    metadata: { plugin: MARKER, ...result.email ? { email: result.email } : {}, ...projectId ? { projectId } : {} }
  };
}
function isOurCredential(value) {
  const v = value;
  return v?.type === "oauth" && v.methodID === METHOD_ID;
}
async function activeCredential(ctx) {
  const connection = await ctx.integration.connection.active(GOOGLE_ID);
  const credential = connection ? await ctx.integration.connection.resolve(connection) : void 0;
  return isOurCredential(credential) ? credential : void 0;
}
async function activeAuth(ctx) {
  const credential = await activeCredential(ctx);
  if (!credential) return void 0;
  const auth = {
    type: "oauth",
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires
  };
  if (!accessTokenExpired(auth)) return auth;
  const key = parseRefreshParts(auth.refresh).refreshToken;
  const memo2 = fallbackAuth.get(key);
  if (memo2 && !accessTokenExpired(memo2)) return memo2;
  logGeminiDebugMessage("Google OAuth: OpenCode handed over an expired credential, refreshing in the plugin");
  return refreshAuth(auth, async (next) => {
    fallbackAuth.set(key, next);
  });
}
async function projectFor(auth) {
  const parts = parseRefreshParts(auth.refresh);
  if (parts.projectId) return parts.projectId;
  let project = projectByToken.get(parts.refreshToken);
  if (!project) {
    project = await resolveProject(auth.access);
    projectByToken.set(parts.refreshToken, project);
  }
  return project;
}
async function quotaReport(ctx) {
  try {
    const auth = await activeAuth(ctx);
    if (!auth?.access) {
      return { ok: false, text: 'Google quota: connect Google with "OAuth with Google (AI Pro/Ultra)" first.' };
    }
    const summary = await fetchQuotaSummary(auth.access, await projectFor(auth));
    return summary ? { ok: true, text: formatQuotaSummary(summary) } : { ok: false, text: "Google quota lookup returned no data." };
  } catch (error) {
    return { ok: false, text: `Google quota lookup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
async function setup(ctx) {
  if (ctx.storage) useCacheStorage(ctx.storage);
  void checkUpstreamUpdate((message) => console.warn(`[Google OAuth] ${message}`));
  const requests = /* @__PURE__ */ new WeakMap();
  const recentFailures = /* @__PURE__ */ new Map();
  const eventAbort = new AbortController();
  let oauthActive = false;
  const syncActive = async () => {
    oauthActive = !!await activeCredential(ctx).catch(() => void 0);
  };
  if (!catalog) {
    const cached = (await readCache()).models;
    if (cached?.length) catalog = cached;
  }
  await syncActive();
  await ctx.integration.transform((draft) => {
    draft.method.update({
      integrationID: GOOGLE_ID,
      method: { id: METHOD_ID, type: "oauth", label: "OAuth with Google (AI Pro/Ultra)" },
      authorize: async () => {
        const authorization = await authorizeAntigravity();
        return authorization.method === "auto" ? {
          url: authorization.url,
          instructions: authorization.instructions,
          mode: "auto",
          callback: authorization.callback().then(toCredential)
        } : {
          url: authorization.url,
          instructions: authorization.instructions,
          mode: "code",
          callback: (code) => authorization.callback(code).then(toCredential)
        };
      },
      // OpenCode calls this when the stored credential expires and persists the result.
      refresh: async (credential) => {
        const next = await refreshAuth(
          { type: "oauth", refresh: credential.refresh, access: credential.access, expires: credential.expires },
          async () => {
          }
        );
        return { ...credential, refresh: next.refresh, access: next.access, expires: next.expires };
      },
      label: (credential) => typeof credential.metadata?.email === "string" ? credential.metadata.email : void 0
    });
  });
  await ctx.provider.transform((draft) => {
    const record = draft.get(GOOGLE_ID);
    if (!record || !oauthActive) return;
    for (const modelID of [...record.models.keys()]) {
      if (catalog && !upstreamModelFor(modelID, catalog)) {
        draft.models.remove(GOOGLE_ID, modelID);
        continue;
      }
      draft.models.update(GOOGLE_ID, modelID, (model) => {
        model.cost = [];
      });
    }
  });
  const syncModels = async (auth) => {
    const ids = await refreshModels(auth.access, await projectFor(auth));
    if (!ids) return;
    const changed = JSON.stringify(ids) !== JSON.stringify(catalog);
    catalog = ids;
    if (changed) await ctx.provider.reload();
  };
  let modelsSynced = false;
  if (typeof ctx.event?.subscribe === "function") {
    const stream = ctx.event.subscribe({ signal: eventAbort.signal });
    void (async () => {
      try {
        for await (const event of stream) {
          if (event.type !== "credential.updated" && event.type !== "credential.switched") continue;
          const integrationID = event.data?.integrationID;
          if (integrationID && integrationID !== GOOGLE_ID) continue;
          const wasActive = oauthActive;
          await syncActive();
          const auth = oauthActive ? await activeAuth(ctx).catch(() => void 0) : void 0;
          if (auth?.access) await syncModels(auth).catch(() => {
          });
          if (wasActive !== oauthActive) await ctx.provider.reload();
        }
      } catch {
      }
    })();
  }
  await ctx.session.hook(
    "http.request",
    async (event) => {
      if (!isGenerativeLanguageRequest(event.request)) return;
      const auth = await activeAuth(ctx);
      if (!auth?.access) return;
      const projectId = await projectFor(auth);
      if (!catalog) await syncModels(auth).catch(() => {
      });
      else if (!modelsSynced) void syncModels(auth).catch(() => {
      });
      modelsSynced = true;
      const original = event.request;
      const body = original.method === "GET" || original.method === "HEAD" ? void 0 : await original.clone().text();
      const modelID = original.url.match(/\/models\/([^:]+):/)?.[1];
      const upstream = modelID && catalog ? upstreamModelFor(modelID, catalog, requestedThinkingLevel(body)) : modelID;
      if (!upstream) {
        throw new Error(
          `${modelID} is not available with your Google subscription. Pick another Google model, or connect an API key.`
        );
      }
      const url = original.url.replace(`/models/${modelID}:`, `/models/${upstream}:`);
      const prepared = prepareGeminiRequest(
        url,
        { method: original.method, headers: original.headers, body, signal: original.signal },
        auth.access,
        projectId
      );
      const target = toAntigravityRequest(String(prepared.request), prepared.init, projectId, await currentVersion());
      const throttleKey = buildRetryThrottleKey(target.url, target.init);
      await waitForRetryCooldown(throttleKey, original.signal);
      const debugContext = startGeminiDebugRequest({
        originalUrl: original.url,
        resolvedUrl: target.url,
        method: target.init.method,
        headers: target.init.headers,
        body: target.init.body,
        streaming: prepared.streaming,
        projectId
      });
      if (debugContext && typeof target.init.body === "string") {
        const sent = JSON.parse(target.init.body);
        logGeminiDebugMessage(`Google ${modelID} -> ${sent.model} generationConfig: ${JSON.stringify(sent.request?.generationConfig ?? null)}`);
      }
      const request = new Request(target.url, target.init);
      requests.set(request, {
        modelID: event.model.id,
        streaming: prepared.streaming,
        requestedModel: prepared.requestedModel,
        url: target.url,
        init: target.init,
        auth,
        throttleKey,
        signal: original.signal,
        replayed: false,
        debugContext
      });
      event.request = request;
    },
    { providerID: GOOGLE_ID }
  );
  await ctx.session.hook(
    "http.response",
    async (event) => {
      const snapshot = requests.get(event.request);
      if (!snapshot) return;
      requests.delete(event.request);
      if (event.response.status === 401 && !snapshot.replayed) {
        snapshot.replayed = true;
        await event.response.body?.cancel().catch(() => {
        });
        const next = await refreshAuth(snapshot.auth, async (refreshed) => {
          fallbackAuth.set(parseRefreshParts(refreshed.refresh).refreshToken, refreshed);
        });
        const headers = new Headers(snapshot.init.headers);
        headers.set("Authorization", `Bearer ${next.access}`);
        event.response = await geminiFetch(snapshot.url, { ...snapshot.init, headers, signal: snapshot.signal });
      }
      if (isRetryableStatus(event.response.status)) {
        const quotaContext = event.response.status === 429 ? await classifyQuotaResponse(event.response) : null;
        const decision = await computeGeminiRetryDecision(event.response, 1, quotaContext, { signal: snapshot.signal });
        if (decision.cooldownMs !== void 0 && decision.cooldownMs > 0) {
          recordRetryCooldown(
            snapshot.throttleKey,
            Math.min(decision.cooldownMs, Math.max(getMaxRetryDelayMs(), MODEL_CAPACITY_COOLDOWN_MS))
          );
        }
        recentFailures.set(snapshot.modelID, {
          status: event.response.status,
          quotaContext,
          decision,
          recordedAt: Date.now()
        });
      }
      if (snapshot.debugContext) {
        void event.response.clone().text().then((raw) => logGeminiDebugMessage(`Google raw response: ${raw.slice(0, 4e3)}`)).catch(() => {
        });
      }
      event.response = await transformGeminiResponse(
        event.response,
        snapshot.streaming,
        snapshot.debugContext,
        snapshot.requestedModel
      );
    },
    { providerID: GOOGLE_ID }
  );
  await ctx.session.hook(
    "retry",
    async (event) => {
      if (!oauthActive) return;
      if (event.attempt >= DEFAULT_MAX_ATTEMPTS) {
        event.decision = { retry: false };
        return;
      }
      const failure = recentFailures.get(event.model.id);
      recentFailures.delete(event.model.id);
      const recent = failure && Date.now() - failure.recordedAt <= RECENT_FAILURE_TTL_MS ? failure : void 0;
      if (recent?.quotaContext?.terminal) {
        event.decision = { retry: false };
        return;
      }
      const status = event.error.status ?? recent?.status;
      if (status !== void 0 && !isRetryableStatus(status)) {
        event.decision = { retry: false };
        return;
      }
      const maxRetryDelayMs = getMaxRetryDelayMs();
      const delayMs = recent?.quotaContext?.retryDelayMs ?? (recent?.decision.shouldRetry ? recent.decision.delayMs : void 0) ?? parseRetryDelayFromMessage(event.error.message) ?? void 0;
      if (delayMs !== void 0 && delayMs > maxRetryDelayMs) {
        event.decision = { retry: false };
        return;
      }
      const decision = await computeGeminiRetryDecision(
        new Response(null, { status: status ?? 503 }),
        event.attempt,
        recent?.quotaContext ?? (delayMs !== void 0 ? { terminal: false, retryDelayMs: delayMs } : null),
        { maxAttempts: DEFAULT_MAX_ATTEMPTS, maxRetryDelayMs }
      );
      event.decision = decision.shouldRetry ? { retry: true, delay: decision.delayMs } : { retry: false };
    },
    { providerID: GOOGLE_ID }
  );
  if (typeof ctx.tool?.transform === "function") {
    await ctx.tool.transform((draft) => {
      draft.add({
        name: QUOTA_TOOL_NAME,
        description: "Show the Google AI subscription quota (weekly and 5-hour pools) for the active Google login.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          const report = await quotaReport(ctx);
          return { content: report.text, metadata: { ok: report.ok } };
        }
      });
    });
  }
  if (typeof ctx.command?.transform === "function") {
    await ctx.command.transform((draft) => {
      draft.add({
        name: "gquota",
        description: "Show Google AI subscription quota",
        execute: async (input) => {
          const report = await quotaReport(ctx);
          if (typeof ctx.session.synthetic === "function") {
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text: report.text,
              delivery: input.delivery,
              resume: false
            });
          }
        }
      });
    });
  }
  return () => {
    eventAbort.abort();
  };
}
var plugin_v2_default = Plugin.define({
  // Kept from the original plugin so its V2 storage (cache) carries over.
  id: "Gemini OAuth Plugin",
  setup
});
export {
  plugin_v2_default as default
};
//# sourceMappingURL=server.js.map