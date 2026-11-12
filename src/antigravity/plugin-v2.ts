import { Integration, type Credential, type Plugin } from "@opencode/plugin";

import type { GeminiTokenExchangeResult } from "../gemini/oauth";
import { logGeminiDebugMessage, startGeminiDebugRequest, type GeminiDebugContext } from "../plugin/debug";
import { accessTokenExpired, parseRefreshParts } from "../plugin/auth";
import { isGenerativeLanguageRequest, prepareGeminiRequest, transformGeminiResponse } from "../plugin/request";
import { parseRetryDelayFromMessage } from "../plugin/request-helpers";
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
} from "../plugin/retry";
import { geminiFetch } from "../fetch";
import type { OAuthAuthDetails } from "../plugin/types";
import {
  ANTIGRAVITY_PROVIDER_ID,
  DEFAULT_MODELS,
  checkUpstreamUpdate,
  currentVersion,
  fetchQuotaSummary,
  formatQuotaSummary,
  readCache,
  refreshAuth,
  refreshModels,
  resolveProject,
  toAntigravityRequest,
  useCacheStorage,
  type ModelCaps,
} from "./client";
import { authorizeAntigravity } from "./plugin";
import { groupModelsByEffort, resolveUpstreamModelId } from "./vendor/protocol.js";

const METHOD_ID = Integration.MethodID.make("antigravity");
const MARKER = "opencode.provider.google-antigravity";
const DISPLAY_NAME = "Google";
/** Set by a model variant; the request hook maps (model, effort) back to the upstream id. */
const EFFORT_HEADER = "x-antigravity-effort";
/** Claude `*-thinking` has one upstream id; the effort only picks the thinking budget. */
const CLAUDE_EFFORTS = ["low", "medium", "high"];
const RECENT_FAILURE_TTL_MS = 30_000;

type V2Context = Pick<Plugin.Context, "provider" | "integration" | "session"> &
  Partial<Pick<Plugin.Context, "event" | "storage">>;

interface Snapshot {
  modelID: string;
  streaming: boolean;
  requestedModel?: string;
  url: string;
  init: RequestInit;
  auth: OAuthAuthDetails;
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
let catalog: { ids: string[]; caps: Record<string, ModelCaps> } | undefined;
let modelsSynced = false;
const projectByToken = new Map<string, string>();
/** Only used when OpenCode hands over an already expired credential. */
const fallbackAuth = new Map<string, OAuthAuthDetails>();

async function loadCatalog() {
  if (!catalog) {
    const cache = await readCache();
    catalog = { ids: cache.models?.length ? cache.models : DEFAULT_MODELS, caps: cache.modelCaps ?? {} };
  }
  return catalog;
}

function toCredential(result: GeminiTokenExchangeResult): Credential.OAuth {
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

function isAntigravityCredential(value: unknown): value is Credential.OAuth {
  const v = value as Credential.OAuth | undefined;
  return v?.type === "oauth" && v.methodID === METHOD_ID;
}

/** `claude-opus-4-6-thinking` -> `Claude Opus 4.6 Thinking`, for ids the built-in catalog lacks. */
export function prettyModelName(id: string): string {
  return id
    .replace(/(\d)-(?=\d)/g, "$1.")
    .split("-")
    .map((word) => (/^gpt$/i.test(word) ? "GPT" : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

async function activeAuth(ctx: V2Context): Promise<OAuthAuthDetails | undefined> {
  const connection = await ctx.integration.connection.active(ANTIGRAVITY_PROVIDER_ID);
  const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
  if (!isAntigravityCredential(credential)) return undefined;
  const auth: OAuthAuthDetails = {
    type: "oauth",
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires,
  };
  if (!accessTokenExpired(auth)) return auth;

  // OpenCode refreshes and stores the credential through the integration's `refresh`;
  // this only covers a credential handed over already expired.
  const key = parseRefreshParts(auth.refresh).refreshToken;
  const memo = fallbackAuth.get(key);
  if (memo && !accessTokenExpired(memo)) return memo;
  logGeminiDebugMessage("Antigravity: OpenCode handed over an expired credential, refreshing in the plugin");
  return refreshAuth(auth, async (next) => {
    fallbackAuth.set(key, next);
  });
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

/** Quota of the active Antigravity connection, or undefined when there is none (used by /gquota). */
export async function antigravityQuotaReport(ctx: V2Context): Promise<{ ok: boolean; text: string } | undefined> {
  let auth: OAuthAuthDetails | undefined;
  try {
    auth = await activeAuth(ctx);
  } catch (error) {
    return { ok: false, text: `Google quota lookup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!auth?.access) return undefined;
  try {
    const summary = await fetchQuotaSummary(auth.access, await projectFor(auth));
    return summary
      ? { ok: true, text: formatQuotaSummary(summary) }
      : { ok: false, text: "Google quota lookup returned no data." };
  } catch (error) {
    return { ok: false, text: `Google quota lookup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Registers the `google-antigravity` integration, provider and HTTP hooks on OpenCode V2. */
export async function setupAntigravityV2(ctx: V2Context): Promise<Plugin.Cleanup> {
  if (ctx.storage) useCacheStorage(ctx.storage);
  void checkUpstreamUpdate((message) => console.warn(`[Antigravity] ${message}`));

  const requests = new WeakMap<Request, Snapshot>();
  const recentFailures = new Map<string, RecentFailure>();
  const eventAbort = new AbortController();

  await ctx.integration.transform((draft) => {
    draft.method.update({
      integrationID: ANTIGRAVITY_PROVIDER_ID,
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
    // Without this the connection list shows the raw id `google-antigravity`.
    draft.update(ANTIGRAVITY_PROVIDER_ID, (integration) => {
      integration.name = DISPLAY_NAME;
    });
  });

  await loadCatalog();
  await ctx.provider.transform((draft) => {
    // Clone the built-in Google provider (same @ai-sdk/google package and model shape).
    const template = draft.get("google");
    if (!template || draft.get(ANTIGRAVITY_PROVIDER_ID) || !catalog) return;
    const generic = [...template.models.values()].find((m) => m.id.includes("gemini-3"));
    if (!generic) return;
    draft.add({
      info: {
        ...template.provider,
        id: ANTIGRAVITY_PROVIDER_ID,
        canonical: undefined,
        integrationID: ANTIGRAVITY_PROVIDER_ID,
        name: DISPLAY_NAME,
      } as unknown as typeof template.provider,
      // `gemini-3.8-flash-{low,medium,high}` becomes one model with low/medium/high variants.
      models: groupModelsByEffort(catalog.ids, catalog.caps as any).map((group: any) => {
        const id: string = group.id;
        // Reuse the built-in Google entry when it exists: real name, limits, modalities, variants.
        const native = template.models.get(id);
        const base = native ?? generic;
        const efforts: string[] = Object.keys(group.reasoningEfforts ?? {});
        const effortIds = efforts.length ? efforts : /claude.*thinking/.test(id) ? CLAUDE_EFFORTS : [];
        const nativeVariants = (native?.variants ?? []) as unknown as ReadonlyArray<{
          id: string;
          headers?: Record<string, string>;
        }>;
        const withHeader = (variant: { id: string; headers?: Record<string, string> }) => ({
          ...variant,
          headers: { ...variant.headers, [EFFORT_HEADER]: variant.id },
        });
        const variants = effortIds.length
          ? effortIds.map((effort) => withHeader(nativeVariants.find((v) => v.id === effort) ?? { id: effort }))
          : nativeVariants.map(withHeader);
        return {
          ...base,
          id,
          modelID: id,
          providerID: ANTIGRAVITY_PROVIDER_ID,
          canonical: undefined,
          family: native?.family,
          name: native?.name ?? prettyModelName(id),
          variants,
          cost: [], // subscription quota, not per-token billing
          status: "active",
          enabled: true,
          limit: {
            context: group.contextWindow ?? base.limit.context,
            output: group.maxTokens ?? base.limit.output,
          },
        } as unknown as typeof base;
      }),
    });
  });

  /** Refreshes the catalog and, when it changed, rebuilds the provider without a restart. */
  const syncModels = async (auth: OAuthAuthDetails) => {
    const ids = await refreshModels(auth.access!, await projectFor(auth));
    if (!ids) return;
    const cache = await readCache();
    const changed = JSON.stringify(ids) !== JSON.stringify(catalog?.ids);
    catalog = { ids, caps: cache.modelCaps ?? {} };
    if (changed) await ctx.provider.reload();
  };

  if (typeof ctx.event?.subscribe === "function") {
    const stream = ctx.event.subscribe({ signal: eventAbort.signal });
    void (async () => {
      try {
        for await (const event of stream) {
          const integrationID = (event as { data?: { integrationID?: string } }).data?.integrationID;
          if (event.type !== "credential.updated" && event.type !== "credential.switched") continue;
          if (integrationID && integrationID !== ANTIGRAVITY_PROVIDER_ID) continue;
          const auth = await activeAuth(ctx).catch(() => undefined);
          if (auth?.access) await syncModels(auth).catch(() => {});
        }
      } catch {
        // Subscription exit on abort/dispose is expected.
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
      if (!modelsSynced) {
        modelsSynced = true;
        void syncModels(auth).catch(() => {});
      }

      const original = event.request;
      const body = original.method === "GET" || original.method === "HEAD" ? undefined : await original.clone().text();
      const headers = new Headers(original.headers);
      const effort = headers.get(EFFORT_HEADER) ?? undefined;
      headers.delete(EFFORT_HEADER);
      const ids = (await loadCatalog()).ids;
      const url = original.url.replace(
        /\/models\/([^:]+):/,
        (_match, model: string) => `/models/${resolveUpstreamModelId(model, effort, ids)}:`,
      );
      const prepared = prepareGeminiRequest(
        url,
        { method: original.method, headers, body, signal: original.signal },
        auth.access,
        projectId,
      );
      const target = toAntigravityRequest(String(prepared.request), prepared.init, projectId, await currentVersion(), effort);

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
        logGeminiDebugMessage(`Antigravity ${sent.model} generationConfig: ${JSON.stringify(sent.request?.generationConfig ?? null)}`);
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
        debugContext,
      });
      event.request = request;
    },
    { providerID: ANTIGRAVITY_PROVIDER_ID },
  );

  await ctx.session.hook(
    "http.response",
    async (event) => {
      const snapshot = requests.get(event.request);
      if (!snapshot) return;
      requests.delete(event.request);

      if (event.response.status === 401 && !snapshot.replayed) {
        // Access token revoked early: refresh once and replay.
        snapshot.replayed = true;
        await event.response.body?.cancel().catch(() => {});
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
        if (decision.cooldownMs !== undefined && decision.cooldownMs > 0) {
          recordRetryCooldown(
            snapshot.throttleKey,
            Math.min(decision.cooldownMs, Math.max(getMaxRetryDelayMs(), MODEL_CAPACITY_COOLDOWN_MS)),
          );
        }
        recentFailures.set(snapshot.modelID, {
          status: event.response.status,
          quotaContext,
          decision,
          recordedAt: Date.now(),
        });
      }

      if (snapshot.debugContext) {
        // Debug only: tee the raw upstream stream into the log (thought parts included).
        void event.response
          .clone()
          .text()
          .then((raw) => logGeminiDebugMessage(`Antigravity raw response: ${raw.slice(0, 4000)}`))
          .catch(() => {});
      }
      event.response = await transformGeminiResponse(
        event.response,
        snapshot.streaming,
        snapshot.debugContext,
        snapshot.requestedModel,
      );
    },
    { providerID: ANTIGRAVITY_PROVIDER_ID },
  );

  // Same retry policy as the Gemini CLI path: honour RetryInfo, give up on terminal quota.
  await ctx.session.hook(
    "retry",
    async (event) => {
      if (event.attempt >= DEFAULT_MAX_ATTEMPTS) {
        event.decision = { retry: false };
        return;
      }
      const failure = recentFailures.get(event.model.id);
      recentFailures.delete(event.model.id);
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
    { providerID: ANTIGRAVITY_PROVIDER_ID },
  );

  return () => {
    eventAbort.abort();
  };
}
