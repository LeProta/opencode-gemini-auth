import { Integration, type Credential, type Plugin } from "@opencode/plugin";

import type { GeminiTokenExchangeResult } from "../gemini/oauth";
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

const METHOD_ID = Integration.MethodID.make("antigravity");
const MARKER = "opencode.provider.google-antigravity";

type V2Context = Pick<Plugin.Context, "provider" | "integration" | "session">;

interface Snapshot {
  streaming: boolean;
  requestedModel?: string;
  url: string;
  init: RequestInit;
  auth: OAuthAuthDetails;
  replayed: boolean;
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
      method: { id: METHOD_ID, type: "oauth", label: "OAuth with Google (Antigravity – AI Pro/Ultra)" },
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
        name: "Google (Antigravity)",
      } as unknown as typeof template.provider,
      models: ids.map((id) => {
        const caps = cache.modelCaps?.[id];
        return {
          ...base,
          id,
          modelID: id,
          providerID: ANTIGRAVITY_PROVIDER_ID,
          canonical: undefined,
          family: undefined,
          name: id,
          variants: [],
          cost: [], // subscription quota, not per-token billing
          status: "active",
          enabled: true,
          limit: {
            context: caps?.contextLength ?? base.limit.context,
            output: caps?.maxCompletionTokens ?? base.limit.output,
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
      const prepared = prepareGeminiRequest(
        original,
        { method: original.method, headers: original.headers, body, signal: original.signal },
        auth.access!,
        projectId,
      );
      const target = toAntigravityRequest(String(prepared.request), prepared.init, projectId, await currentVersion());
      const request = new Request(target.url, target.init);
      requests.set(request, {
        streaming: prepared.streaming,
        requestedModel: prepared.requestedModel,
        url: target.url,
        init: target.init,
        auth,
        replayed: false,
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
      event.response = await transformGeminiResponse(event.response, snapshot.streaming, null, snapshot.requestedModel);
    },
    { providerID: ANTIGRAVITY_PROVIDER_ID },
  );

  return () => {};
}
