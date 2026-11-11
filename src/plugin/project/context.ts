import { GEMINI_PROVIDER_ID } from "../../constants";
import { formatRefreshParts, parseRefreshParts } from "../auth";
import type { OAuthAuthDetails, PluginClient, ProjectContextResult } from "../types";
import { loadManagedProject, onboardManagedProject } from "./api";
import { FREE_TIER_ID, LEGACY_TIER_ID, ProjectIdRequiredError } from "./types";
import {
  buildIneligibleTierMessage,
  getCacheKey,
  normalizeProjectId,
  pickOnboardTier,
  throwIfValidationRequired,
} from "./utils";

export interface ProjectContextCache {
  result: Map<string, ProjectContextResult>;
  pending: Map<string, Promise<ProjectContextResult>>;
}

export interface EnsureProjectContextOptions {
  accountKey?: string;
  persistAuth?: (auth: OAuthAuthDetails) => Promise<void>;
  cache?: ProjectContextCache;
}

export function createProjectContextCache(): ProjectContextCache {
  return {
    result: new Map<string, ProjectContextResult>(),
    pending: new Map<string, Promise<ProjectContextResult>>(),
  };
}

const defaultProjectContextCache = createProjectContextCache();

/**
 * Clears cached project context results and pending promises.
 */
export function invalidateProjectContextCache(
  refresh?: string,
  cache: ProjectContextCache = defaultProjectContextCache,
): void {
  if (!refresh) {
    cache.pending.clear();
    cache.result.clear();
    return;
  }

  const raw = refresh.trim();
  if (!raw) {
    return;
  }
  const token = parseRefreshParts(raw).refreshToken || raw;
  const matches = (key: string): boolean =>
    key === raw ||
    key.startsWith(`${raw}|`) ||
    key === token ||
    key.startsWith(`${token}|`);

  for (const key of cache.pending.keys()) {
    if (matches(key)) {
      cache.pending.delete(key);
    }
  }
  for (const key of cache.result.keys()) {
    if (matches(key)) {
      cache.result.delete(key);
    }
  }
}

/**
 * Clears cached project context entries scoped to a specific account/connection key.
 */
export function invalidateProjectContextByAccount(
  accountKey: string,
  cache: ProjectContextCache = defaultProjectContextCache,
): void {
  const normalized = accountKey.trim();
  if (!normalized) {
    return;
  }
  const marker = `|acct:${normalized}`;
  const matches = (key: string): boolean =>
    key.endsWith(marker) || key.includes(`${marker}|`);

  for (const key of cache.pending.keys()) {
    if (matches(key)) {
      cache.pending.delete(key);
    }
  }
  for (const key of cache.result.keys()) {
    if (matches(key)) {
      cache.result.delete(key);
    }
  }
}

/**
 * Removes any persisted projectId / managedProjectId segments from an OAuth refresh string.
 */
export function clearPersistedProjectFromAuth(auth: OAuthAuthDetails): OAuthAuthDetails {
  const parts = parseRefreshParts(auth.refresh);
  const nextRefresh = parts.refreshToken;
  if (nextRefresh === auth.refresh) {
    return auth;
  }
  return {
    ...auth,
    refresh: nextRefresh,
  };
}

/**
 * Resolves a project context for an access token, optionally persisting updated auth.
 */
export async function resolveProjectContextFromAccessToken(
  auth: OAuthAuthDetails,
  accessToken: string,
  configuredProjectId?: string,
  persistAuth?: (auth: OAuthAuthDetails) => Promise<void>,
  userAgentModel?: string,
): Promise<ProjectContextResult> {
  const parts = parseRefreshParts(auth.refresh);
  const configuredProject = configuredProjectId?.trim() || undefined;
  const projectId = configuredProject || parts.projectId;

  if (!configuredProject && (projectId || parts.managedProjectId)) {
    return {
      auth,
      effectiveProjectId: projectId || parts.managedProjectId || "",
    };
  }

  const loadPayload = await loadManagedProject(accessToken, projectId, userAgentModel);
  if (!loadPayload) {
    throw new ProjectIdRequiredError();
  }

  const managedProjectId = normalizeProjectId(loadPayload.cloudaicompanionProject);
  if (managedProjectId) {
    const effectiveProjectId = configuredProject || managedProjectId;
    const managedToPersist =
      configuredProject && managedProjectId !== configuredProject
        ? undefined
        : managedProjectId;
    const updatedAuth = withProjectAuth(auth, parts.refreshToken, projectId, managedToPersist);
    if (updatedAuth.refresh !== auth.refresh && persistAuth) {
      await persistAuth(updatedAuth);
    }
    return { auth: updatedAuth, effectiveProjectId };
  }

  const currentTierId = loadPayload.currentTier?.id;
  if (!currentTierId) {
    throwIfValidationRequired(loadPayload.ineligibleTiers);
  }

  if (currentTierId) {
    if (projectId) {
      const updatedAuth =
        configuredProject &&
        (parts.projectId !== configuredProject || parts.managedProjectId !== undefined)
          ? withProjectAuth(auth, parts.refreshToken, configuredProject, undefined)
          : auth;
      if (updatedAuth.refresh !== auth.refresh && persistAuth) {
        await persistAuth(updatedAuth);
      }
      return { auth: updatedAuth, effectiveProjectId: projectId };
    }
    const ineligibleMessage = buildIneligibleTierMessage(loadPayload.ineligibleTiers);
    if (ineligibleMessage) {
      throw new Error(ineligibleMessage);
    }
    throw new ProjectIdRequiredError();
  }

  const tier = pickOnboardTier(loadPayload.allowedTiers);
  const tierId = tier.id ?? LEGACY_TIER_ID;
  if (tierId !== FREE_TIER_ID && !projectId) {
    throw new ProjectIdRequiredError();
  }

  const onboardedProjectId = await onboardManagedProject(
    accessToken,
    tierId,
    projectId,
    userAgentModel,
  );
  if (onboardedProjectId) {
    const effectiveProjectId = configuredProject || onboardedProjectId;
    const managedToPersist =
      configuredProject && onboardedProjectId !== configuredProject
        ? undefined
        : onboardedProjectId;
    const updatedAuth = withProjectAuth(auth, parts.refreshToken, projectId, managedToPersist);
    if (updatedAuth.refresh !== auth.refresh && persistAuth) {
      await persistAuth(updatedAuth);
    }
    return { auth: updatedAuth, effectiveProjectId };
  }

  if (projectId) {
    const updatedAuth =
      configuredProject &&
      (parts.projectId !== configuredProject || parts.managedProjectId !== undefined)
        ? withProjectAuth(auth, parts.refreshToken, configuredProject, undefined)
        : auth;
    if (updatedAuth.refresh !== auth.refresh && persistAuth) {
      await persistAuth(updatedAuth);
    }
    return { auth: updatedAuth, effectiveProjectId: projectId };
  }
  throw new ProjectIdRequiredError();
}

/**
 * Resolves an effective project ID for the current auth state, caching results per refresh token
 * and optional configured project / account scope.
 */
export async function ensureProjectContext(
  auth: OAuthAuthDetails,
  client: PluginClient,
  configuredProjectId?: string,
  userAgentModel?: string,
  options?: EnsureProjectContextOptions,
): Promise<ProjectContextResult> {
  const accessToken = auth.access;
  if (!accessToken) {
    return { auth, effectiveProjectId: "" };
  }

  const cache = options?.cache ?? defaultProjectContextCache;
  const accountKey = options?.accountKey?.trim() || undefined;
  const cacheKey = buildProjectCacheKey(auth, configuredProjectId, accountKey);
  if (cacheKey) {
    const cached = cache.result.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = cache.pending.get(cacheKey);
    if (pending) {
      return pending;
    }
  }

  const persistAuth =
    options?.persistAuth ??
    (async (updatedAuth: OAuthAuthDetails) => {
      await client.auth.set({
        path: { id: GEMINI_PROVIDER_ID },
        body: updatedAuth,
      });
    });

  const resolveContext = async (): Promise<ProjectContextResult> =>
    resolveProjectContextFromAccessToken(
      auth,
      accessToken,
      configuredProjectId,
      persistAuth,
      userAgentModel,
    );

  if (!cacheKey) {
    return resolveContext();
  }

  const promise = resolveContext()
    .then((result) => {
      const nextKey =
        buildProjectCacheKey(result.auth, configuredProjectId, accountKey) ?? cacheKey;
      cache.pending.delete(cacheKey);
      cache.result.set(nextKey, result);
      if (nextKey !== cacheKey) {
        // Keep the pre-hydration cache key warm in case callers still hold the older auth snapshot.
        cache.result.set(cacheKey, result);
      }
      return result;
    })
    .catch((error) => {
      cache.pending.delete(cacheKey);
      throw error;
    });

  cache.pending.set(cacheKey, promise);
  return promise;
}

function withProjectAuth(
  auth: OAuthAuthDetails,
  refreshToken: string,
  projectId: string | undefined,
  managedProjectId: string | undefined,
): OAuthAuthDetails {
  return {
    ...auth,
    refresh: formatRefreshParts({
      refreshToken,
      projectId,
      managedProjectId,
    }),
  };
}

function buildProjectCacheKey(
  auth: OAuthAuthDetails,
  configuredProjectId?: string,
  accountKey?: string,
): string | undefined {
  const base = getCacheKey(auth);
  if (!base) {
    return undefined;
  }
  const project = configuredProjectId?.trim() ?? "";
  const account = accountKey?.trim() ?? "";
  let key = base;
  if (project) {
    key = `${key}|cfg:${project}`;
  }
  if (account) {
    key = `${key}|acct:${account}`;
  }
  return key;
}
