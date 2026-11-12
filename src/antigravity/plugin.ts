import { randomBytes } from "node:crypto";

import { geminiFetch } from "../fetch";
import { accessTokenExpired, formatRefreshParts, isOAuthAuth, parseRefreshParts } from "../plugin/auth";
import { createOAuthAuthorizeMethod } from "../plugin/oauth-authorize";
import { resolveThinkingConfigDefaults } from "../plugin/provider";
import { isGenerativeLanguageRequest, prepareGeminiRequest, transformGeminiResponse } from "../plugin/request";
import { fetchWithRetry } from "../plugin/retry";
import type { GetAuth, OAuthAuthDetails, PluginContext, PluginResult, Provider } from "../plugin/types";
import {
  ANTIGRAVITY_PROVIDER_ID,
  DEFAULT_MODELS,
  checkUpstreamUpdate,
  currentVersion,
  exchangeCode,
  readCache,
  refreshAuth,
  refreshModels,
  resolveProject,
  toAntigravityRequest,
  type ModelCaps,
} from "./client";
import { buildAuthUrl, callbackUrl } from "./vendor/protocol.js";

function buildModels(ids: string[], caps: Record<string, ModelCaps> = {}) {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      {
        name: id,
        // Subscription quota, not per-token billing.
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: {
          context: caps[id]?.contextLength ?? 1_048_576,
          output: caps[id]?.maxCompletionTokens ?? 65_536,
        },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        reasoning: true,
        tool_call: true,
        attachment: true,
      },
    ]),
  );
}

/** Shared by the V1 and V2 entry points. */
export const authorizeAntigravity = createOAuthAuthorizeMethod({
  redirectUri: callbackUrl(),
  authorizeFn: async () => {
    const state = randomBytes(32).toString("hex");
    return { url: buildAuthUrl(state), verifier: "", state };
  },
  exchangeFn: (code) => exchangeCode(code),
  resolveProjectContextFn: async (auth, accessToken) => {
    const projectId = await resolveProject(accessToken);
    void refreshModels(accessToken, projectId);
    const { refreshToken } = parseRefreshParts(auth.refresh);
    return {
      auth: { ...auth, refresh: formatRefreshParts({ refreshToken, projectId }) },
      effectiveProjectId: projectId,
    };
  },
});

/**
 * OpenCode provider `google-antigravity`: Google AI Pro / Ultra subscription via the
 * Antigravity OAuth surface (wire format from CLIProxyAPI).
 */
export const GeminiAntigravityPlugin = async ({ client }: PluginContext): Promise<PluginResult> => {
  void checkUpstreamUpdate((message) => {
    console.warn(`[Antigravity] ${message}`);
    client.tui
      ?.showToast({ body: { title: "Antigravity protocol update", message, variant: "info", duration: 10_000 } })
      .catch(() => {});
  });

  let modelsRefreshed = false;
  const persist = (auth: OAuthAuthDetails) => client.auth.set({ path: { id: ANTIGRAVITY_PROVIDER_ID }, body: auth });

  return {
    config: async (config) => {
      const cache = await readCache();
      const ids = cache.models?.length ? cache.models : DEFAULT_MODELS;
      config.provider = config.provider || {};
      const existing = (config.provider[ANTIGRAVITY_PROVIDER_ID] ?? {}) as Record<string, any>;
      (config.provider as Record<string, unknown>)[ANTIGRAVITY_PROVIDER_ID] = {
        npm: "@ai-sdk/google",
        name: "Google (Antigravity)",
        ...existing,
        // User-defined model entries win over discovered ones.
        models: { ...buildModels(ids, cache.modelCaps), ...(existing.models ?? {}) },
      };
    },
    auth: {
      provider: ANTIGRAVITY_PROVIDER_ID,
      loader: async (getAuth: GetAuth, provider: Provider) => {
        const initial = await getAuth();
        if (!isOAuthAuth(initial)) return null;
        const thinkingConfigDefaults = resolveThinkingConfigDefaults(provider);

        return {
          apiKey: "",
          async fetch(input, init) {
            if (!isGenerativeLanguageRequest(input)) return geminiFetch(input, init);
            const stored = await getAuth();
            if (!isOAuthAuth(stored)) return geminiFetch(input, init);
            let auth: OAuthAuthDetails = stored;

            if (accessTokenExpired(auth)) auth = await refreshAuth(auth, persist);
            const parts = parseRefreshParts(auth.refresh);
            let projectId = parts.projectId;
            if (!projectId) {
              projectId = await resolveProject(auth.access!);
              auth = { ...auth, refresh: formatRefreshParts({ ...parts, projectId }) };
              await persist(auth);
            }
            if (!modelsRefreshed) {
              modelsRefreshed = true;
              void refreshModels(auth.access!, projectId);
            }

            const send = async (accessToken: string) => {
              const prepared = prepareGeminiRequest(input, init, accessToken, projectId!, thinkingConfigDefaults);
              const target = toAntigravityRequest(String(prepared.request), prepared.init, projectId!, await currentVersion());
              return { prepared, response: await fetchWithRetry(target.url, target.init) };
            };

            let { prepared, response } = await send(auth.access!);
            if (response.status === 401) {
              // Access token revoked early: refresh once and replay, as the bridge does.
              await response.body?.cancel().catch(() => {});
              auth = await refreshAuth(auth, persist);
              ({ prepared, response } = await send(auth.access!));
            }
            return transformGeminiResponse(response, prepared.streaming, null, prepared.requestedModel);
          },
        };
      },
      methods: [
        {
          label: "OAuth with Google (Antigravity – AI Pro/Ultra)",
          type: "oauth",
          authorize: authorizeAntigravity,
        },
      ],
    },
  };
};
