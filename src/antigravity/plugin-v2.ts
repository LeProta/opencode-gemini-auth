import { Integration, type Credential, type Plugin } from "@opencode/plugin";

import type { GeminiTokenExchangeResult } from "../gemini/oauth";
import { logGeminiDebugMessage, startGeminiDebugRequest, type GeminiDebugContext } from "../plugin/debug";
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "../plugin/auth";
import { isGenerativeLanguageRequest, prepareGeminiRequest, transformGeminiResponse } from "../plugin/request";
import { geminiFetch } from "../fetch";
import type { OAuthAuthDetails } from "../plugin/types";
import {
  ANTIGRAVITY_PROVIDER_ID,
  DEFAULT_MODELS,
  checkUpstreamUpdate,
  currentVersion,
  readCache,
  refreshAuth,
  refreshModels,
  resolveProject,
  toAntigravityRequest,
} from "./client";
import { authorizeAntigravity } from "./plugin";
import { groupModelsByEffort, resolveUpstreamModelId } from "./vendor/protocol.js";

const METHOD_ID = Integration.MethodID.make("antigravity");
const MARKER = "opencode.provider.google-antigravity";
const DISPLAY_NAME = "Google";
/** Set by a model variant; the request hook maps (model, effort) back to the upstream id. */
const EFFORT_HEADER = "x-antigravity-effort";

type V2Context = Pick<Plugin.Context, "provider" | "integration" | "session">;

interface Snapshot {
  streaming: boolean;
  requestedModel?: string;
  url: string;
  init: RequestInit;
  auth: OAuthAuthDetails;
  replayed: boolean;
  debugContext: GeminiDebugContext | null;
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

/** Registers the `google-antigravity` integration, provider and HTTP hooks on OpenCode V2. */
export async function setupAntigravityV2(ctx: V2Context): Promise<Plugin.Cleanup> {
  void checkUpstreamUpdate((message) => console.warn(`[Antigravity] ${message}`));

  // Access tokens refreshed inside the hooks, keyed by refresh token.
  const refreshed = new Map<string, OAuthAuthDetails>();
  const requests = new WeakMap<Request, Snapshot>();
  const remember = async (auth: OAuthAuthDetails) => {
    refreshed.set(parseRefreshParts(auth.refresh).refreshToken, auth);
  };
  let modelsRefreshed = false;

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
      refresh: async (credential) => {
        const next = await refreshAuth(
          { type: "oauth", refresh: credential.refresh, access: credential.access, expires: credential.expires },
          remember,
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

  const cache = await readCache();
  const ids = cache.models?.length ? cache.models : DEFAULT_MODELS;
  await ctx.provider.transform((draft) => {
    // Clone the built-in Google provider (same @ai-sdk/google package and model shape).
    const template = draft.get("google");
    if (!template || draft.get(ANTIGRAVITY_PROVIDER_ID)) return;
    const models = [...template.models.values()];
    const base = models.find((m) => m.id.includes("gemini-3")) ?? models[0];
    if (!base) return;
    draft.add({
      info: {
        ...template.provider,
        id: ANTIGRAVITY_PROVIDER_ID,
        canonical: undefined,
        integrationID: ANTIGRAVITY_PROVIDER_ID,
        name: DISPLAY_NAME,
      } as unknown as typeof template.provider,
      // `gemini-3.8-flash-{low,medium,high}` becomes one model with low/medium/high variants.
      models: groupModelsByEffort(ids, (cache.modelCaps ?? null) as any).map((group: any) => {
        const efforts = Object.keys(group.reasoningEfforts ?? {});
        return {
          ...base,
          id: group.id,
          modelID: group.id,
          providerID: ANTIGRAVITY_PROVIDER_ID,
          canonical: undefined,
          family: undefined,
          name: group.id,
          variants: efforts.map((effort) => ({ id: effort, headers: { [EFFORT_HEADER]: effort } })),
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

  const activeAuth = async (): Promise<OAuthAuthDetails | undefined> => {
    const connection = await ctx.integration.connection.active(ANTIGRAVITY_PROVIDER_ID);
    const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined;
    if (!isAntigravityCredential(credential)) return undefined;
    const stored: OAuthAuthDetails = {
      type: "oauth",
      refresh: credential.refresh,
      access: credential.access,
      expires: credential.expires,
    };
    const memo = refreshed.get(parseRefreshParts(stored.refresh).refreshToken);
    return memo && (memo.expires ?? 0) > (stored.expires ?? 0) ? memo : stored;
  };

  await ctx.session.hook(
    "http.request",
    async (event) => {
      if (!isGenerativeLanguageRequest(event.request)) return;
      let auth = await activeAuth();
      if (!auth) return;
      if (accessTokenExpired(auth)) auth = await refreshAuth(auth, remember);

      const parts = parseRefreshParts(auth.refresh);
      let projectId = parts.projectId;
      if (!projectId) {
        projectId = await resolveProject(auth.access!);
        auth = { ...auth, refresh: formatRefreshParts({ ...parts, projectId }) };
        await remember(auth);
      }
      if (!modelsRefreshed) {
        modelsRefreshed = true;
        void refreshModels(auth.access!, projectId);
      }

      const original = event.request;
      const body = original.method === "GET" || original.method === "HEAD" ? undefined : await original.clone().text();
      const headers = new Headers(original.headers);
      const effort = headers.get(EFFORT_HEADER) ?? undefined;
      headers.delete(EFFORT_HEADER);
      const url = original.url.replace(
        /\/models\/([^:]+):/,
        (_match, model: string) => `/models/${resolveUpstreamModelId(model, effort, ids)}:`,
      );
      const prepared = prepareGeminiRequest(
        url,
        { method: original.method, headers, body, signal: original.signal },
        auth.access!,
        projectId,
      );
      const target = toAntigravityRequest(String(prepared.request), prepared.init, projectId, await currentVersion());
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
        logGeminiDebugMessage(`Original generationConfig: ${JSON.stringify(body ? JSON.parse(body).generationConfig ?? null : null)}`);
      }
      const request = new Request(target.url, target.init);
      requests.set(request, {
        streaming: prepared.streaming,
        requestedModel: prepared.requestedModel,
        url: target.url,
        init: target.init,
        auth,
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
        const next = await refreshAuth(snapshot.auth, remember);
        const headers = new Headers(snapshot.init.headers);
        headers.set("Authorization", `Bearer ${next.access}`);
        event.response = await geminiFetch(snapshot.url, { ...snapshot.init, headers });
      }
      if (snapshot.debugContext) {
        // Debug only: tee the raw upstream stream into the log (thought parts included).
        void event.response
          .clone()
          .text()
          .then((raw) => logGeminiDebugMessage(`Antigravity raw response: ${raw.slice(0, 4000)}`))
          .catch(() => {});
      }
      event.response = await transformGeminiResponse(event.response, snapshot.streaming, snapshot.debugContext, snapshot.requestedModel);
    },
    { providerID: ANTIGRAVITY_PROVIDER_ID },
  );

  return () => {};
}
