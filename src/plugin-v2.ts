import { Integration, Plugin, type Credential } from "@opencode/plugin";

import { GEMINI_PROVIDER_ID } from "./constants";
import { geminiFetch } from "./fetch";
import type { GeminiTokenExchangeResult } from "./gemini/oauth";
import { parseRefreshParts } from "./plugin/auth";
import { clearCachedAuth } from "./plugin/cache";
import { startGeminiDebugRequest, type GeminiDebugContext } from "./plugin/debug";
import { createOAuthAuthorizeMethod } from "./plugin/oauth-authorize";
import {
  createProjectContextCache,
  ensureProjectContext,
  invalidateProjectContextByAccount,
  invalidateProjectContextCache,
  type ProjectContextCache,
} from "./plugin/project";
import { resolveConfiguredProjectId, resolveThinkingConfigDefaults } from "./plugin/provider";
import { GEMINI_QUOTA_TOOL_NAME, retrieveGeminiQuotaReport } from "./plugin/quota";
import {
  isGenerativeLanguageRequest,
  parseGenerativeLanguageRequest,
  prepareGeminiRequest,
  type ThinkingConfigDefaults,
  transformGeminiResponse,
} from "./plugin/request";
import { parseRetryDelayFromMessage } from "./plugin/request-helpers";
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
} from "./plugin/retry";
import { getLastRefreshFailureKind, refreshAccessToken } from "./plugin/token";
import type { OAuthAuthDetails, PluginClient, Provider } from "./plugin/types";

const GEMINI_OAUTH_METHOD_ID = Integration.MethodID.make("gemini-cli");
const GEMINI_OAUTH_MARKER = "opencode.provider.google-gemini-cli";
const V2_ACCESS_TOKEN_EXPIRY_BUFFER_MS = 30_000;
const RECENT_FAILURE_TTL_MS = 30_000;

type ConnectionInfo = Awaited<ReturnType<Plugin.Context["integration"]["connection"]["active"]>>;
type V2Context = Pick<Plugin.Context, "provider" | "integration" | "session"> &
  Partial<Pick<Plugin.Context, "event" | "tool" | "command" | "storage">>;

interface RequestSnapshot {
  modelID: string;
  streaming: boolean;
  requestedModel?: string;
  debugContext: GeminiDebugContext | null;
  throttleKey: string;
  accountKey?: string;
  connection: ConnectionInfo;
  authSnapshot: OAuthAuthDetails;
  method: string;
  url: string;
  headers: Headers;
  body?: string;
  signal: AbortSignal;
  replayed401: boolean;
}

interface RecentHttpFailure {
  status: number;
  quotaContext: QuotaContext | null;
  decision: GeminiRetryDecision;
  recordedAt: number;
}

interface StoredOAuthSnapshot {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  sourceRefresh: string;
}

type ConnectionStatusFn = (input: {
  integrationID: string;
  connection: NonNullable<ConnectionInfo>;
  status?: { status: "needs_auth"; message: string; url?: string };
}) => Promise<void>;

const noPersistClient = {
  auth: { set: async () => {} },
} satisfies PluginClient;

const geminiQuotaInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/**
 * Registers the native OpenCode V2 Gemini OAuth integration, provider cost transform,
 * HTTP/retry session hooks, quota tool/command, and credential event synchronization.
 */
export async function setupV2(ctx: V2Context): Promise<Plugin.Cleanup> {
  const requests = new WeakMap<Request, RequestSnapshot>();
  const projectCache = createProjectContextCache();
  const inMemoryAuthByAccount = new Map<string, StoredOAuthSnapshot>();
  const recentHttpFailures = new Map<string, RecentHttpFailure>();
  const needsAuthByAccount = new Map<string, string>();
  const eventAbort = new AbortController();

  let isGeminiOAuthActive = false;
  let capturedProviderSettings: Record<string, unknown> | undefined;
  let capturedModelSettings: Record<string, { settings: Record<string, unknown> }> = {};
  let latestUserAgentModel: string | undefined;

  const getConfiguredProjectId = () =>
    resolveV2ConfiguredProjectId(ctx, (settings) => {
      capturedProviderSettings = settings;
    });

  const authorize = createOAuthAuthorizeMethod({
    getConfiguredProjectId,
    getUserAgentModel: () => latestUserAgentModel,
  });

  const syncActiveOAuthState = async () => {
    try {
      const connection = await ctx.integration.connection.active(GEMINI_PROVIDER_ID);
      const credential = connection
        ? await ctx.integration.connection.resolve(connection)
        : undefined;
      isGeminiOAuthActive = isGeminiOAuthCredential(credential);
    } catch {
      isGeminiOAuthActive = false;
    }
  };

  const readStoredSnapshot = async (accountKey: string): Promise<StoredOAuthSnapshot | undefined> => {
    const inMemory = inMemoryAuthByAccount.get(accountKey);
    if (ctx.storage?.get) {
      try {
        const raw = await ctx.storage.get(buildOAuthStorageKey(accountKey));
        const parsed = parseStoredOAuthSnapshot(raw);
        if (parsed && (!inMemory || parsed.expires >= inMemory.expires)) {
          inMemoryAuthByAccount.set(accountKey, parsed);
          return parsed;
        }
      } catch {
        // Storage read errors should not abort active requests.
      }
    }
    return inMemory;
  };

  const persistOAuthSnapshot = async (
    accountKey: string | undefined,
    updated: OAuthAuthDetails,
    sourceRefreshToken: string,
  ): Promise<void> => {
    if (!accountKey || !updated.access || updated.expires === undefined) {
      return;
    }
    const existing = await readStoredSnapshot(accountKey);
    const existingRefreshToken = existing ? parseRefreshParts(existing.refresh).refreshToken : undefined;
    const inheritedSource =
      existing &&
      (existing.sourceRefresh === sourceRefreshToken || existingRefreshToken === sourceRefreshToken)
        ? existing.sourceRefresh
        : sourceRefreshToken;
    const snapshot: StoredOAuthSnapshot = {
      type: "oauth",
      refresh: updated.refresh,
      access: updated.access,
      expires: updated.expires,
      sourceRefresh: inheritedSource,
    };
    inMemoryAuthByAccount.set(accountKey, snapshot);
    if (ctx.storage?.set) {
      try {
        await ctx.storage.set(buildOAuthStorageKey(accountKey), {
          type: snapshot.type,
          refresh: snapshot.refresh,
          access: snapshot.access,
          expires: snapshot.expires,
          sourceRefresh: snapshot.sourceRefresh,
        });
      } catch {
        // Best-effort persistence keeps request flow resilient.
      }
    }
  };

  const clearAccountCache = async (accountKey: string | undefined): Promise<void> => {
    if (!accountKey) {
      clearProjectCacheAll(projectCache);
      inMemoryAuthByAccount.clear();
      return;
    }
    invalidateProjectContextByAccount(accountKey, projectCache);
    inMemoryAuthByAccount.delete(accountKey);
    if (ctx.storage?.remove) {
      try {
        await ctx.storage.remove(buildOAuthStorageKey(accountKey));
      } catch {}
    }
  };

  const resolveEffectiveAuth = async (
    credential: Credential.OAuth,
    accountKey: string | undefined,
  ): Promise<OAuthAuthDetails> => {
    const baseAuth = toOAuthAuthDetails(credential);
    if (!accountKey) {
      return baseAuth;
    }
    const stored = await readStoredSnapshot(accountKey);
    if (!stored) {
      return baseAuth;
    }

    const baseToken = parseRefreshParts(baseAuth.refresh).refreshToken;
    const storedToken = parseRefreshParts(stored.refresh).refreshToken;
    const sameLineage = stored.sourceRefresh === baseToken || storedToken === baseToken;
    if (!sameLineage) {
      return baseAuth;
    }
    if ((stored.expires ?? 0) > (baseAuth.expires ?? 0)) {
      return {
        ...baseAuth,
        refresh: stored.refresh,
        access: stored.access,
        expires: stored.expires,
      };
    }
    return baseAuth;
  };

  const refreshWithStore = async (
    auth: OAuthAuthDetails,
    accountKey: string | undefined,
    connection: ConnectionInfo,
    options?: { force?: boolean; signal?: AbortSignal },
  ): Promise<OAuthAuthDetails | undefined> => {
    const baseToken = parseRefreshParts(auth.refresh).refreshToken;
    const refreshed = await refreshAccessToken(auth, noPersistClient, {
      force: options?.force,
      signal: options?.signal,
      readLatest: accountKey
        ? async () => {
            const stored = await readStoredSnapshot(accountKey);
            return stored ? { type: "oauth", refresh: stored.refresh, access: stored.access, expires: stored.expires } : undefined;
          }
        : undefined,
      persist: async (updated) => {
        if (!updated.access) {
          clearCachedAuth(auth.refresh);
          await clearAccountCache(accountKey);
          return;
        }
        await persistOAuthSnapshot(accountKey, updated, baseToken);
        if (accountKey) {
          invalidateProjectContextByAccount(accountKey, projectCache);
        }
      },
    });

    if (refreshed?.access) {
      if (accountKey && needsAuthByAccount.has(accountKey)) {
        needsAuthByAccount.delete(accountKey);
        await setConnectionNeedsAuthStatus(ctx, connection, undefined);
      }
      return refreshed;
    }

    if (getLastRefreshFailureKind(auth) === "terminal") {
      if (accountKey) {
        needsAuthByAccount.set(accountKey, buildCredentialSignature(auth));
      }
      await setConnectionNeedsAuthStatus(ctx, connection, {
        status: "needs_auth",
        message: "Gemini OAuth session expired or was revoked. Reconnect Google.",
      });
    }
    return undefined;
  };

  const getThinkingDefaults = (): ThinkingConfigDefaults | undefined => {
    const fakeProvider: Provider = {
      settings: capturedProviderSettings,
      models: Object.fromEntries(
        Object.entries(capturedModelSettings).map(([id, value]) => [id, value]),
      ),
    };
    return resolveThinkingConfigDefaults(fakeProvider);
  };

  await syncActiveOAuthState();

  await ctx.integration.transform((draft) => {
    draft.method.update({
      integrationID: GEMINI_PROVIDER_ID,
      method: {
        id: GEMINI_OAUTH_METHOD_ID,
        type: "oauth",
        label: "OAuth with Google (Gemini CLI)",
        form: [
          {
            type: "string",
            key: "projectId",
            title: "Google Cloud Project ID (optional)",
            description:
              "Leave blank for automatic detection, or enter a Project ID for Standard/Enterprise/Workspace accounts.",
            placeholder: "my-gcp-project-id",
            required: false,
          },
        ],
      },
      authorize: async (answer?: Record<string, unknown>) => {
        const projectId =
          answer && typeof answer.projectId === "string" && answer.projectId.trim()
            ? answer.projectId.trim()
            : undefined;
        const authorization = await authorize(projectId ? { projectId } : undefined);
        return authorization.method === "auto"
          ? {
              url: authorization.url,
              instructions: authorization.instructions,
              mode: "auto",
              callback: authorization.callback().then(toV2Credential),
            }
          : {
              url: authorization.url,
              instructions: authorization.instructions,
              mode: "code",
              callback: (code: string) => authorization.callback(code).then(toV2Credential),
            };
      },
      refresh: async (credential) => {
        const auth = toOAuthAuthDetails(credential);
        const refreshed = await refreshAccessToken(auth, noPersistClient);
        if (!refreshed?.access || refreshed.expires === undefined) {
          const kind = getLastRefreshFailureKind(auth);
          throw new Error(
            kind === "terminal"
              ? "Gemini OAuth refresh token was revoked or rejected. Reconnect Google."
              : "Gemini OAuth token refresh failed",
          );
        }
        return toRefreshedV2Credential(credential, refreshed);
      },
      label: (credential) => formatCredentialLabel(credential),
    });
  });

  if (typeof ctx.provider.transform === "function") {
    await ctx.provider.transform((draft) => {
      const record = draft.get(GEMINI_PROVIDER_ID);
      if (!record) {
        return;
      }

      capturedProviderSettings =
        record.provider.settings && typeof record.provider.settings === "object"
          ? (record.provider.settings as Record<string, unknown>)
          : undefined;
      const nextModelSettings: Record<string, { settings: Record<string, unknown> }> = {};
      for (const [modelID, model] of record.models) {
        if (model.settings && typeof model.settings === "object") {
          nextModelSettings[modelID] = {
            settings: model.settings as Record<string, unknown>,
          };
        }
      }
      capturedModelSettings = nextModelSettings;

      if (!isGeminiOAuthActive) {
        return;
      }
      for (const modelID of record.models.keys()) {
        draft.models.update(GEMINI_PROVIDER_ID, modelID, (model) => {
          model.cost = [];
        });
      }
    });
  }

  if (typeof ctx.event?.subscribe === "function") {
    const stream = ctx.event.subscribe({ signal: eventAbort.signal });
    void (async () => {
      try {
        for await (const event of stream) {
          if (event.type !== "credential.updated" && event.type !== "credential.switched") {
            continue;
          }
          if (
            event.type === "credential.switched" &&
            event.data?.integrationID !== GEMINI_PROVIDER_ID
          ) {
            continue;
          }
          clearProjectCacheAll(projectCache);
          inMemoryAuthByAccount.clear();
          recentHttpFailures.clear();
          await syncActiveOAuthState();
          await ctx.provider.reload();
        }
      } catch {
        // Subscription exit on abort/dispose is expected.
      }
    })();
  }

  const runQuotaLookup = async () =>
    retrieveGeminiQuotaReport({
      resolveAuth: async () => {
        const connection = await ctx.integration.connection.active(GEMINI_PROVIDER_ID);
        const credential = connection
          ? await ctx.integration.connection.resolve(connection)
          : undefined;
        if (!connection || !credential) {
          return { status: "uninitialized" };
        }
        if (!isGeminiOAuthCredential(credential)) {
          return { status: "not_oauth" };
        }

        const accountKey = getAccountKey(connection);
        let auth = await resolveEffectiveAuth(credential, accountKey);
        if (isV2TokenExpired(auth)) {
          const refreshed = await refreshWithStore(auth, accountKey, connection);
          if (!refreshed?.access) {
            const kind = getLastRefreshFailureKind(auth);
            return {
              status: "error",
              message:
                kind === "terminal"
                  ? "Gemini quota lookup failed: OAuth session expired or revoked. Reconnect Google via /connect."
                  : "Gemini quota lookup failed while refreshing the access token.",
            };
          }
          auth = refreshed;
        }
        return { status: "ok", auth };
      },
      getConfiguredProjectId,
      getUserAgentModel: () => latestUserAgentModel,
      ensureProjectContext: async (auth, configuredProjectId, userAgentModel) => {
        const connection = await ctx.integration.connection.active(GEMINI_PROVIDER_ID);
        const accountKey = getAccountKey(connection);
        const baseToken = parseRefreshParts(auth.refresh).refreshToken;
        return ensureProjectContext(auth, noPersistClient, configuredProjectId, userAgentModel, {
          accountKey,
          cache: projectCache,
          persistAuth: (updated) => persistOAuthSnapshot(accountKey, updated, baseToken),
        });
      },
    });

  if (typeof ctx.tool?.transform === "function") {
    await ctx.tool.transform((draft) => {
      draft.add({
        name: GEMINI_QUOTA_TOOL_NAME,
        description:
          "Retrieve Gemini Code Assist quota usage and remaining buckets for the active OAuth account.",
        input: geminiQuotaInputSchema,
        execute: async () => {
          const report = await runQuotaLookup();
          return {
            output: report.text,
            content: report.text,
            metadata: {
              ok: report.ok,
              ...(report.projectId ? { projectId: report.projectId } : {}),
            },
          };
        },
      });
    });
  }

  if (typeof ctx.command?.transform === "function") {
    await ctx.command.transform((draft) => {
      draft.add({
        name: "gquota",
        description: "Show Gemini Code Assist quota usage",
        execute: async (input) => {
          const report = await runQuotaLookup();
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

  await ctx.session.hook("http.request", async (event) => {
    if (!isGenerativeLanguageRequest(event.request)) {
      return;
    }

    const connection = await ctx.integration.connection.active(GEMINI_PROVIDER_ID);
    const credential = connection
      ? await ctx.integration.connection.resolve(connection)
      : undefined;
    if (!isGeminiOAuthCredential(credential)) {
      return;
    }

    const accountKey = getAccountKey(connection);
    const configuredProjectId = await getConfiguredProjectId();

    let activeAuth = await resolveEffectiveAuth(credential, accountKey);
    if (isV2TokenExpired(activeAuth)) {
      const refreshed = await refreshWithStore(activeAuth, accountKey, connection, {
        signal: event.request.signal,
      });
      if (!refreshed?.access) {
        const kind = getLastRefreshFailureKind(activeAuth);
        throw new Error(
          kind === "terminal"
            ? "Gemini OAuth session expired or was revoked. Reconnect Google via /connect."
            : "Gemini OAuth token refresh failed",
        );
      }
      activeAuth = refreshed;
    } else if (accountKey) {
      const failedSignature = needsAuthByAccount.get(accountKey);
      if (failedSignature !== undefined && failedSignature !== buildCredentialSignature(activeAuth)) {
        needsAuthByAccount.delete(accountKey);
        await setConnectionNeedsAuthStatus(ctx, connection, undefined);
      }
    }

    const requestUserAgentModel =
      parseGenerativeLanguageRequest(event.request)?.effectiveModel ?? event.model.id;
    if (requestUserAgentModel) {
      latestUserAgentModel = requestUserAgentModel;
    }

    const baseToken = parseRefreshParts(activeAuth.refresh).refreshToken;
    const project = await ensureProjectContext(
      activeAuth,
      noPersistClient,
      configuredProjectId,
      requestUserAgentModel,
      {
        accountKey,
        cache: projectCache,
        persistAuth: (updated) => persistOAuthSnapshot(accountKey, updated, baseToken),
      },
    );

    const original = event.request;
    const body =
      original.method === "GET" || original.method === "HEAD"
        ? undefined
        : await original.clone().text();
    const accessToken = project.auth.access ?? activeAuth.access ?? "";
    const transformed = prepareGeminiRequest(
      original,
      { method: original.method, headers: original.headers, body, signal: original.signal },
      accessToken,
      project.effectiveProjectId,
      getThinkingDefaults(),
    );

    const throttleKey = buildRetryThrottleKey(transformed.request, transformed.init);
    await waitForRetryCooldown(throttleKey, original.signal);

    const debugContext = startGeminiDebugRequest({
      originalUrl: toUrlString(original),
      resolvedUrl: toUrlString(transformed.request),
      method: transformed.init.method,
      headers: transformed.init.headers,
      body: transformed.init.body,
      streaming: transformed.streaming,
      projectId: project.effectiveProjectId,
    });

    const request = new Request(transformed.request, transformed.init);
    requests.set(request, {
      modelID: event.model.id,
      streaming: transformed.streaming,
      requestedModel: transformed.requestedModel,
      debugContext,
      throttleKey,
      accountKey,
      connection,
      authSnapshot: project.auth,
      method: transformed.init.method ?? original.method,
      url: toUrlString(transformed.request),
      headers: new Headers(transformed.init.headers),
      body: typeof transformed.init.body === "string" ? transformed.init.body : undefined,
      signal: original.signal,
      replayed401: false,
    });
    event.request = request;
  }, { providerID: GEMINI_PROVIDER_ID });

  await ctx.session.hook("http.response", async (event) => {
    const snapshot = requests.get(event.request);
    if (!snapshot) {
      return;
    }
    requests.delete(event.request);

    if (event.response.status === 401 && !snapshot.replayed401) {
      snapshot.replayed401 = true;
      invalidateProjectContextCache(snapshot.authSnapshot.refresh, projectCache);
      const refreshed = await refreshWithStore(
        snapshot.authSnapshot,
        snapshot.accountKey,
        snapshot.connection,
        { force: true, signal: snapshot.signal },
      );
      if (refreshed?.access) {
        await cancelBodyBestEffort(event.response);
        snapshot.authSnapshot = refreshed;
        const replayHeaders = new Headers(snapshot.headers);
        replayHeaders.set("Authorization", `Bearer ${refreshed.access}`);
        event.response = await geminiFetch(snapshot.url, {
          method: snapshot.method,
          headers: replayHeaders,
          body: snapshot.body,
          signal: snapshot.signal,
        });
      }
    }

    if (isRetryableStatus(event.response.status)) {
      const quotaContext =
        event.response.status === 429 ? await classifyQuotaResponse(event.response) : null;
      const decision = await computeGeminiRetryDecision(event.response, 1, quotaContext, {
        signal: snapshot.signal,
      });
      if (decision.cooldownMs !== undefined && decision.cooldownMs > 0) {
        const boundedCooldownMs = Math.min(
          decision.cooldownMs,
          Math.max(getMaxRetryDelayMs(), MODEL_CAPACITY_COOLDOWN_MS),
        );
        recordRetryCooldown(snapshot.throttleKey, boundedCooldownMs);
      }
      const failureKey = snapshot.modelID || snapshot.requestedModel;
      if (failureKey) {
        recentHttpFailures.set(failureKey, {
          status: event.response.status,
          quotaContext,
          decision,
          recordedAt: Date.now(),
        });
      }
    }

    event.response = await transformGeminiResponse(
      event.response,
      snapshot.streaming,
      snapshot.debugContext,
      snapshot.requestedModel,
    );
  }, { providerID: GEMINI_PROVIDER_ID });

  await ctx.session.hook("retry", async (event) => {
    const connection = await ctx.integration.connection.active(GEMINI_PROVIDER_ID);
    const credential = connection
      ? await ctx.integration.connection.resolve(connection)
      : undefined;
    if (!isGeminiOAuthCredential(credential)) {
      return;
    }

    const maxAttempts = DEFAULT_MAX_ATTEMPTS;
    if (event.attempt >= maxAttempts) {
      event.decision = { retry: false };
      return;
    }

    const recent = takeRecentFailure(recentHttpFailures, event.model.id);
    if (recent?.quotaContext?.terminal) {
      event.decision = { retry: false };
      return;
    }

    const status = event.error.status ?? recent?.status;
    if (status !== undefined && !isRetryableStatus(status)) {
      event.decision = { retry: false };
      return;
    }

    const messageLower = event.error.message.toLowerCase();
    if (
      (messageLower.includes("quota_exhausted") ||
        messageLower.includes("quota exhausted") ||
        messageLower.includes("quota exceeded")) &&
      recent?.quotaContext?.reason !== "RATE_LIMIT_EXCEEDED"
    ) {
      event.decision = { retry: false };
      return;
    }

    const maxRetryDelayMs = getMaxRetryDelayMs();
    const parsedDelayMs =
      recent?.quotaContext?.retryDelayMs ??
      (recent?.decision.shouldRetry ? recent.decision.delayMs : undefined) ??
      parseRetryDelayFromMessage(event.error.message) ??
      undefined;

    if (parsedDelayMs !== undefined && parsedDelayMs > maxRetryDelayMs) {
      event.decision = { retry: false };
      return;
    }

    const syntheticResponse = new Response(null, { status: status ?? 503 });
    const decision = await computeGeminiRetryDecision(
      syntheticResponse,
      event.attempt,
      recent?.quotaContext ??
        (parsedDelayMs !== undefined ? { terminal: false, retryDelayMs: parsedDelayMs } : null),
      { maxAttempts, maxRetryDelayMs },
    );
    event.decision = decision.shouldRetry
      ? { retry: true, delay: decision.delayMs }
      : { retry: false };
  }, { providerID: GEMINI_PROVIDER_ID });

  return () => {
    eventAbort.abort();
  };
}

async function resolveV2ConfiguredProjectId(
  ctx: V2Context,
  onSettings?: (settings: Record<string, unknown> | undefined) => void,
): Promise<string | undefined> {
  const override = process.env.OPENCODE_GEMINI_PROJECT_ID?.trim();
  if (override) {
    return override;
  }
  const provider = await ctx.provider.get({ providerID: GEMINI_PROVIDER_ID });
  const settings =
    provider.data.settings && typeof provider.data.settings === "object"
      ? (provider.data.settings as Record<string, unknown>)
      : undefined;
  onSettings?.(settings);
  return resolveConfiguredProjectId({
    provider: { settings },
  });
}

function toV2Credential(result: GeminiTokenExchangeResult): Credential.OAuth {
  if (result.type !== "success") {
    throw new Error(result.error);
  }
  const parts = parseRefreshParts(result.refresh);
  const metadata: Record<string, unknown> = {
    plugin: GEMINI_OAUTH_MARKER,
  };
  if (result.email) {
    metadata.email = result.email;
  }
  if (parts.projectId) {
    metadata.projectId = parts.projectId;
  }
  if (parts.managedProjectId) {
    metadata.managedProjectId = parts.managedProjectId;
  }
  return {
    type: "oauth",
    methodID: GEMINI_OAUTH_METHOD_ID,
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    metadata,
  };
}

function toRefreshedV2Credential(
  previous: Credential.OAuth,
  refreshed: OAuthAuthDetails,
): Credential.OAuth {
  const parts = parseRefreshParts(refreshed.refresh);
  const metadata: Record<string, unknown> = {
    ...previous.metadata,
    plugin: GEMINI_OAUTH_MARKER,
  };
  if (parts.projectId) {
    metadata.projectId = parts.projectId;
  }
  if (parts.managedProjectId) {
    metadata.managedProjectId = parts.managedProjectId;
  }
  return {
    ...previous,
    ...refreshed,
    access: refreshed.access ?? previous.access,
    expires: refreshed.expires ?? previous.expires,
    metadata,
  };
}

function formatCredentialLabel(credential: Credential.OAuth): string | undefined {
  const email =
    typeof credential.metadata?.email === "string" && credential.metadata.email.trim()
      ? credential.metadata.email.trim()
      : undefined;
  const parts = parseRefreshParts(credential.refresh);
  const project =
    (typeof credential.metadata?.projectId === "string" && credential.metadata.projectId.trim()) ||
    (typeof credential.metadata?.managedProjectId === "string" &&
      credential.metadata.managedProjectId.trim()) ||
    parts.projectId ||
    parts.managedProjectId ||
    undefined;

  if (email && project) {
    return `${email} (${project})`;
  }
  return email ?? project;
}

function isV2Credential(value: unknown): value is Credential.OAuth {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "oauth" &&
    typeof (value as { methodID?: unknown }).methodID === "string"
  );
}

function isGeminiOAuthCredential(value: unknown): value is Credential.OAuth {
  if (!isV2Credential(value) || value.methodID !== GEMINI_OAUTH_METHOD_ID) {
    return false;
  }
  const marker = value.metadata?.plugin;
  return marker === undefined || marker === GEMINI_OAUTH_MARKER;
}

function toOAuthAuthDetails(credential: Credential.OAuth): OAuthAuthDetails {
  return {
    type: "oauth",
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires,
    metadata: credential.metadata,
  };
}

function isV2TokenExpired(auth: Pick<OAuthAuthDetails, "access" | "expires">): boolean {
  if (!auth.access || typeof auth.expires !== "number" || !Number.isFinite(auth.expires)) {
    return true;
  }
  return auth.expires <= Date.now() + V2_ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}

function getAccountKey(connection: ConnectionInfo): string | undefined {
  if (!connection || connection.type !== "credential") {
    return undefined;
  }
  return typeof connection.id === "string" && connection.id.trim() ? connection.id.trim() : undefined;
}

function buildOAuthStorageKey(accountKey: string): string {
  return `gemini-oauth:${accountKey}`;
}

function parseStoredOAuthSnapshot(raw: unknown): StoredOAuthSnapshot | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (
    record.type !== "oauth" ||
    typeof record.refresh !== "string" ||
    typeof record.access !== "string" ||
    typeof record.expires !== "number" ||
    !Number.isFinite(record.expires) ||
    typeof record.sourceRefresh !== "string"
  ) {
    return undefined;
  }
  return {
    type: "oauth",
    refresh: record.refresh,
    access: record.access,
    expires: record.expires,
    sourceRefresh: record.sourceRefresh,
  };
}

function buildCredentialSignature(
  auth: Pick<OAuthAuthDetails, "refresh" | "access" | "expires">,
): string {
  const token = parseRefreshParts(auth.refresh).refreshToken;
  return `${token}|${auth.access ?? ""}|${auth.expires ?? ""}`;
}

function clearProjectCacheAll(cache: ProjectContextCache): void {
  cache.pending.clear();
  cache.result.clear();
}

function takeRecentFailure(
  map: Map<string, RecentHttpFailure>,
  modelId: string,
): RecentHttpFailure | undefined {
  const now = Date.now();
  for (const [key, entry] of map.entries()) {
    if (now - entry.recordedAt > RECENT_FAILURE_TTL_MS) {
      map.delete(key);
    }
  }
  const entry = map.get(modelId);
  if (!entry) {
    return undefined;
  }
  map.delete(modelId);
  return entry;
}

async function cancelBodyBestEffort(response: Response): Promise<void> {
  if (!response.body) {
    return;
  }
  try {
    await response.body.cancel();
  } catch {}
}

async function setConnectionNeedsAuthStatus(
  ctx: V2Context,
  connection: ConnectionInfo,
  status: { status: "needs_auth"; message: string; url?: string } | undefined,
): Promise<void> {
  if (!connection) {
    return;
  }
  const statusFn = (
    ctx.integration.connection as unknown as {
      status?: ConnectionStatusFn;
    }
  ).status;
  if (typeof statusFn !== "function") {
    return;
  }
  try {
    await statusFn({
      integrationID: GEMINI_PROVIDER_ID,
      connection,
      status,
    });
  } catch {
    // Structural guard supports older/newer host versions gracefully.
  }
}

function toUrlString(input: RequestInfo): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url || input.toString();
}

export default Plugin.define({
  id: "Gemini OAuth Plugin",
  setup: setupV2,
});
