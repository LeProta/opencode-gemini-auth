/**
 * OpenCode V2 plugin: Google AI Pro / Ultra subscription OAuth for the built-in
 * Google provider.
 *
 * Like the Claude subscription plugins do for Anthropic, nothing new is added to
 * the model picker: the plugin registers an OAuth method on OpenCode's own `google`
 * integration and, while that login is the active connection, sends the built-in
 * Google models through the Antigravity (Cloud Code) surface instead of the Gemini
 * API. With an API key connected the plugin stays out of the way.
 */
import { Integration, Plugin, type Credential } from "@opencode/plugin";

import { authorizeAntigravity, refreshAuth } from "./auth";
import { readCache, useCacheStorage } from "./cache";
import { currentVersion } from "./config";
import { refreshModels, requestedThinkingLevel, upstreamModelFor } from "./models";
import { resolveProject } from "./project";
import { fetchQuotaSummary, formatQuotaSummary } from "./quota";
import { toAntigravityRequest } from "./transform";
import { checkUpstreamUpdate } from "./upstream";
import { readBoundedText, readPrefix } from "./bounded";
import { geminiFetch } from "./fetch";
import { accessTokenExpired, parseRefreshParts } from "./refresh-parts";
import { logGeminiDebugMessage, startGeminiDebugRequest, type GeminiDebugContext } from "./debug";
import { isGenerativeLanguageRequest, prepareGeminiRequest, transformGeminiResponse } from "./request";
import { parseRetryDelayFromMessage } from "./request/helpers";
import {
  buildRetryThrottleKey,
  classifyQuotaResponse,
  computeGeminiRetryDecision,
  DEFAULT_MAX_ATTEMPTS,
  getMaxRetryDelayMs,
  isRetryableStatus,
  MODEL_CAPACITY_COOLDOWN_MS,
  recordRetryCooldown,
  waitForRetryCooldown,
  type GeminiRetryDecision,
  type QuotaContext,
} from "./rate-limit";
import type { OAuthAuthDetails, TokenExchangeResult } from "./types";

const GOOGLE_ID = "google";
const METHOD_ID = Integration.MethodID.make("antigravity");
const MARKER = "opencode.provider.google-oauth";
const QUOTA_TOOL_NAME = "google_quota";
const RECENT_FAILURE_TTL_MS = 30_000;
/** Retry state belongs to one conversation turn: session + agent + model. */
const failureKey = (event: { sessionID?: string; agent?: string; model: { id: string } }) =>
  `${event.sessionID ?? ""}\u0000${event.agent ?? ""}\u0000${event.model.id}`;
const MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024; // inline images included; Anthropic plugin's limit
const DEBUG_EXCERPT_BYTES = 4000;

type V2Context = Pick<Plugin.Context, "provider" | "integration" | "session"> &
  Partial<Pick<Plugin.Context, "event" | "storage" | "tool" | "command">>;

interface Snapshot {
  modelID: string;
  streaming: boolean;
  requestedModel?: string;
  url: string;
  init: RequestInit;
  auth: OAuthAuthDetails;
  authKey: string;
  throttleKey: string;
  signal: AbortSignal;
  replayed: boolean;
  debugContext: GeminiDebugContext | null;
}

interface RecentFailure {
  status: number;
  quotaContext: QuotaContext | null;
  decision: GeminiRetryDecision;
  recordedAt: number;
}

// Shared by every plugin instance in the process (OpenCode sets the plugin up once per directory).
/** Model ids each account's Antigravity catalog serves, by Cloud Code project. */
const catalogs = new Map<string, string[]>();
const projectByToken = new Map<string, string>();
/** Only used when OpenCode hands over an already expired credential. */
const fallbackAuth = new Map<string, OAuthAuthDetails>();

function toCredential(result: TokenExchangeResult): Credential.OAuth {
  if (result.type !== "success") throw new Error(result.error);
  const { projectId } = parseRefreshParts(result.refresh);
  return {
    type: "oauth",
    methodID: METHOD_ID,
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    metadata: { plugin: MARKER, ...(result.email ? { email: result.email } : {}), ...(projectId ? { projectId } : {}) },
  };
}

function isOurCredential(value: unknown): value is Credential.OAuth {
  const v = value as Credential.OAuth | undefined;
  return v?.type === "oauth" && v.methodID === METHOD_ID;
}

async function activeCredential(ctx: V2Context): Promise<Credential.OAuth | undefined> {
  const connection = await ctx.integration.connection.active(GOOGLE_ID);
  const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
  return isOurCredential(credential) ? credential : undefined;
}

interface ActiveSession {
  auth: OAuthAuthDetails;
  /** Refresh token of the credential OpenCode stores; keys the plugin-side fallback. */
  key: string;
}

/** The subscription login when it is Google's active connection, refreshed if needed. */
async function activeSession(ctx: V2Context): Promise<ActiveSession | undefined> {
  const credential = await activeCredential(ctx);
  if (!credential) return undefined;
  const auth: OAuthAuthDetails = {
    type: "oauth",
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires,
  };
  const key = parseRefreshParts(auth.refresh).refreshToken;

  // A token the plugin refreshed (401 replay, or an expired hand-over) wins until
  // OpenCode stores a newer credential of its own.
  const memo = fallbackAuth.get(key);
  if (memo && !accessTokenExpired(memo) && (memo.expires ?? 0) > (auth.expires ?? 0)) return { auth: memo, key };
  if (memo) fallbackAuth.delete(key);
  if (!accessTokenExpired(auth)) return { auth, key };

  // OpenCode refreshes and stores the credential through the method's `refresh`;
  // this only covers a credential handed over already expired.
  logGeminiDebugMessage("Google OAuth: OpenCode handed over an expired credential, refreshing in the plugin");
  const next = await refreshAuth(auth, async (refreshed) => {
    fallbackAuth.set(key, refreshed);
  });
  return { auth: next, key };
}

async function activeAuth(ctx: V2Context): Promise<OAuthAuthDetails | undefined> {
  return (await activeSession(ctx))?.auth;
}

/** Project of a stored credential, without any network call. */
function credentialProject(credential: Credential.OAuth): string | undefined {
  const fromMetadata = credential.metadata?.projectId;
  return parseRefreshParts(credential.refresh).projectId ?? (typeof fromMetadata === "string" ? fromMetadata : undefined);
}

async function projectFor(auth: OAuthAuthDetails): Promise<string> {
  const parts = parseRefreshParts(auth.refresh);
  if (parts.projectId) return parts.projectId;
  let project = projectByToken.get(parts.refreshToken);
  if (!project) {
    project = await resolveProject(auth.access!);
    projectByToken.set(parts.refreshToken, project);
  }
  return project;
}

async function quotaReport(ctx: V2Context): Promise<{ ok: boolean; text: string }> {
  try {
    const auth = await activeAuth(ctx);
    if (!auth?.access) {
      return { ok: false, text: "Google quota: connect Google with \"OAuth with Google (AI Pro/Ultra)\" first." };
    }
    const summary = await fetchQuotaSummary(auth.access, await projectFor(auth));
    return summary
      ? { ok: true, text: formatQuotaSummary(summary) }
      : { ok: false, text: "Google quota lookup returned no data." };
  } catch (error) {
    return { ok: false, text: `Google quota lookup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function setup(ctx: V2Context): Promise<Plugin.Cleanup> {
  if (ctx.storage) useCacheStorage(ctx.storage);
  void checkUpstreamUpdate((message) => console.warn(`[Google OAuth] ${message}`));

  const requests = new WeakMap<Request, Snapshot>();
  const recentFailures = new Map<string, RecentFailure>();
  const eventAbort = new AbortController();
  let oauthActive = false;
  let activeProject: string | undefined;
  let disposed = false;

  const syncActive = async () => {
    const credential = await activeCredential(ctx).catch(() => undefined);
    oauthActive = !!credential;
    activeProject = credential ? credentialProject(credential) : undefined;
  };

  await syncActive();
  const cache = await readCache();
  for (const [project, ids] of Object.entries(cache.modelsByProject ?? {})) {
    if (!catalogs.has(project) && ids.length) catalogs.set(project, ids);
  }
  // Caches written before 2.1 hold one unkeyed list: it can only be the account in use.
  if (activeProject && !catalogs.has(activeProject) && cache.models?.length) catalogs.set(activeProject, cache.models);

  await ctx.integration.transform((draft) => {
    draft.method.update({
      integrationID: GOOGLE_ID,
      method: { id: METHOD_ID, type: "oauth", label: "OAuth with Google (AI Pro/Ultra)" },
      authorize: async () => {
        const authorization = await authorizeAntigravity();
        return authorization.method === "auto"
          ? {
              url: authorization.url,
              instructions: authorization.instructions,
              mode: "auto",
              callback: authorization.callback().then(toCredential),
            }
          : {
              url: authorization.url,
              instructions: authorization.instructions,
              mode: "code",
              callback: (code: string) => authorization.callback(code).then(toCredential),
            };
      },
      // OpenCode calls this when the stored credential expires and persists the result.
      refresh: async (credential) => {
        const next = await refreshAuth(
          { type: "oauth", refresh: credential.refresh, access: credential.access, expires: credential.expires },
          async () => {},
        );
        return { ...credential, refresh: next.refresh, access: next.access!, expires: next.expires! };
      },
      label: (credential) =>
        typeof credential.metadata?.email === "string" ? credential.metadata.email : undefined,
    });
  });

  // While the subscription login is active: hide what the subscription does not serve
  // and zero the per-token prices (usage is covered by the subscription quota).
  await ctx.provider.transform((draft) => {
    const record = draft.get(GOOGLE_ID);
    if (!record || !oauthActive) return;
    const catalog = activeProject ? catalogs.get(activeProject) : undefined;
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

  /** Refreshes the account catalog and, when it changed, rebuilds the model list. */
  const syncModels = async (auth: OAuthAuthDetails) => {
    const project = await projectFor(auth);
    const ids = await refreshModels(auth.access!, project);
    if (!ids) return;
    const changed = JSON.stringify(ids) !== JSON.stringify(catalogs.get(project));
    catalogs.set(project, ids);
    if (changed && project === activeProject && !disposed) await ctx.provider.reload();
  };
  const syncedProjects = new Set<string>();

  if (typeof ctx.event?.subscribe === "function") {
    const stream = ctx.event.subscribe({ signal: eventAbort.signal });
    void (async () => {
      try {
        for await (const event of stream) {
          if (event.type !== "credential.updated" && event.type !== "credential.switched") continue;
          const integrationID = (event as { data?: { integrationID?: string } }).data?.integrationID;
          if (integrationID && integrationID !== GOOGLE_ID) continue;
          const wasActive: boolean = oauthActive;
          await syncActive();
          const auth = oauthActive ? await activeAuth(ctx).catch(() => undefined) : undefined;
          if (auth?.access) await syncModels(auth).catch(() => {});
          if (wasActive !== oauthActive) await ctx.provider.reload();
        }
      } catch {
        // Subscription exit on abort/dispose is expected.
      }
    })();
  }

  await ctx.session.hook(
    "http.request",
    async (event) => {
      if (disposed || !isGenerativeLanguageRequest(event.request)) return;
      const session = await activeSession(ctx);
      const auth = session?.auth;
      if (!session || !auth?.access) return; // API key connection: leave the request alone
      const projectId = await projectFor(auth);
      if (!catalogs.has(projectId)) await syncModels(auth).catch(() => {});
      else if (!syncedProjects.has(projectId)) void syncModels(auth).catch(() => {});
      syncedProjects.add(projectId);
      const catalog = catalogs.get(projectId);

      const original = event.request;
      const body =
        original.method === "GET" || original.method === "HEAD"
          ? undefined
          : await readBoundedText(original.clone().body, MAX_REQUEST_BODY_BYTES, "Google request body");
      const modelID = original.url.match(/\/models\/([^:]+):/)?.[1];
      const upstream = modelID && catalog ? upstreamModelFor(modelID, catalog, requestedThinkingLevel(body)) : modelID;
      if (!upstream) {
        throw new Error(
          `${modelID} is not available with your Google subscription. Pick another Google model, or connect an API key.`,
        );
      }
      const url = original.url.replace(`/models/${modelID}:`, `/models/${upstream}:`);
      const prepared = prepareGeminiRequest(
        url,
        { method: original.method, headers: original.headers, body, signal: original.signal },
        auth.access,
        projectId,
      );
      const target = toAntigravityRequest(String(prepared.request), prepared.init, projectId, await currentVersion());

      // Wait out a cooldown recorded by an earlier 429 on the same project/model.
      const throttleKey = buildRetryThrottleKey(target.url, target.init);
      await waitForRetryCooldown(throttleKey, original.signal);

      const debugContext = startGeminiDebugRequest({
        originalUrl: original.url,
        resolvedUrl: target.url,
        method: target.init.method,
        headers: target.init.headers,
        body: target.init.body,
        streaming: prepared.streaming,
        projectId,
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
        authKey: session.key,
        throttleKey,
        signal: original.signal,
        replayed: false,
        debugContext,
      });
      event.request = request;
    },
    { providerID: GOOGLE_ID },
  );

  await ctx.session.hook(
    "http.response",
    async (event) => {
      const snapshot = requests.get(event.request);
      if (!snapshot || disposed) return;
      requests.delete(event.request);

      if (event.response.status === 401 && !snapshot.replayed) {
        // Access token revoked early: refresh once and replay.
        snapshot.replayed = true;
        await event.response.body?.cancel().catch(() => {});
        const next = await refreshAuth(snapshot.auth, async (refreshed) => {
          fallbackAuth.set(snapshot.authKey, refreshed);
        });
        const headers = new Headers(snapshot.init.headers);
        headers.set("Authorization", `Bearer ${next.access}`);
        event.response = await geminiFetch(snapshot.url, { ...snapshot.init, headers, signal: snapshot.signal });
      }

      if (isRetryableStatus(event.response.status)) {
        const quotaContext = event.response.status === 429 ? await classifyQuotaResponse(event.response) : null;
        const decision = await computeGeminiRetryDecision(event.response, 1, quotaContext, { signal: snapshot.signal });
        if (decision.cooldownMs !== undefined && decision.cooldownMs > 0) {
          recordRetryCooldown(
            snapshot.throttleKey,
            Math.min(decision.cooldownMs, Math.max(getMaxRetryDelayMs(), MODEL_CAPACITY_COOLDOWN_MS)),
          );
        }
        const now = Date.now();
        for (const [key, stale] of recentFailures) {
          if (now - stale.recordedAt > RECENT_FAILURE_TTL_MS) recentFailures.delete(key);
        }
        recentFailures.set(failureKey(event), { status: event.response.status, quotaContext, decision, recordedAt: now });
      }

      if (snapshot.debugContext) {
        // Debug only: tee the raw upstream stream into the log (thought parts included).
        void readPrefix(event.response.clone().body, DEBUG_EXCERPT_BYTES)
          .then((raw) => logGeminiDebugMessage(`Google raw response: ${raw}`))
          .catch(() => {});
      }
      event.response = await transformGeminiResponse(
        event.response,
        snapshot.streaming,
        snapshot.debugContext,
        snapshot.requestedModel,
      );
    },
    { providerID: GOOGLE_ID },
  );

  // Honour RetryInfo, give up on terminal quota or delays above the retry budget.
  await ctx.session.hook(
    "retry",
    async (event) => {
      if (disposed || !oauthActive) return;
      if (event.attempt >= DEFAULT_MAX_ATTEMPTS) {
        event.decision = { retry: false };
        return;
      }
      const failure = recentFailures.get(failureKey(event));
      recentFailures.delete(failureKey(event));
      const recent = failure && Date.now() - failure.recordedAt <= RECENT_FAILURE_TTL_MS ? failure : undefined;
      if (recent?.quotaContext?.terminal) {
        event.decision = { retry: false };
        return;
      }
      const status = event.error.status ?? recent?.status;
      if (status !== undefined && !isRetryableStatus(status)) {
        event.decision = { retry: false };
        return;
      }
      const maxRetryDelayMs = getMaxRetryDelayMs();
      const delayMs =
        recent?.quotaContext?.retryDelayMs ??
        (recent?.decision.shouldRetry ? recent.decision.delayMs : undefined) ??
        parseRetryDelayFromMessage(event.error.message) ??
        undefined;
      if (delayMs !== undefined && delayMs > maxRetryDelayMs) {
        event.decision = { retry: false };
        return;
      }
      const decision = await computeGeminiRetryDecision(
        new Response(null, { status: status ?? 503 }),
        event.attempt,
        recent?.quotaContext ?? (delayMs !== undefined ? { terminal: false, retryDelayMs: delayMs } : null),
        { maxAttempts: DEFAULT_MAX_ATTEMPTS, maxRetryDelayMs },
      );
      event.decision = decision.shouldRetry ? { retry: true, delay: decision.delayMs } : { retry: false };
    },
    { providerID: GOOGLE_ID },
  );

  if (typeof ctx.tool?.transform === "function") {
    await ctx.tool.transform((draft) => {
      draft.add({
        name: QUOTA_TOOL_NAME,
        description: "Show the Google AI subscription quota (weekly and 5-hour pools) for the active Google login.",
        input: { type: "object", properties: {}, additionalProperties: false } as const,
        execute: async () => {
          const report = await quotaReport(ctx);
          return { content: report.text, metadata: { ok: report.ok } };
        },
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
              resume: false,
            });
          }
        },
      });
    });
  }

  return () => {
    disposed = true;
    eventAbort.abort();
    recentFailures.clear();
  };
}

export default Plugin.define({
  // Kept from the original plugin so its V2 storage (cache) carries over.
  id: "Gemini OAuth Plugin",
  setup,
});
