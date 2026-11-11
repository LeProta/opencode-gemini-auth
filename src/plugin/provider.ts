import { GEMINI_PROVIDER_ID } from "../constants";
import type { ThinkingConfigDefaults } from "./request/prepare";
import type { PluginClient, PluginConfig, Provider } from "./types";

interface ResolveConfiguredProjectIdInput {
  provider?: Provider | null;
  config?: PluginConfig | null;
  configProjectId?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveConfiguredProjectId(
  input: ResolveConfiguredProjectIdInput = {},
): string | undefined {
  const env = input.env ?? process.env;

  return (
    normalizeProjectId(env.OPENCODE_GEMINI_PROJECT_ID) ??
    resolveConfiguredProjectIdFromProvider(input.provider) ??
    normalizeProjectId(input.configProjectId) ??
    resolveConfiguredProjectIdFromConfig(input.config) ??
    normalizeProjectId(env.GOOGLE_CLOUD_PROJECT) ??
    normalizeProjectId(env.GOOGLE_CLOUD_PROJECT_ID)
  );
}

export function resolveConfiguredProjectIdFromProvider(
  provider: Provider | null | undefined,
): string | undefined {
  if (!provider || typeof provider !== "object") {
    return undefined;
  }
  return (
    normalizeProjectId(provider.options?.projectId) ??
    normalizeProjectId(provider.settings?.projectId)
  );
}

export function resolveConfiguredProjectIdFromConfig(
  config: PluginConfig | null | undefined,
): string | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const v1Provider =
    config.provider && typeof config.provider === "object"
      ? config.provider[GEMINI_PROVIDER_ID]
      : undefined;
  const v2Provider =
    config.providers && typeof config.providers === "object"
      ? config.providers[GEMINI_PROVIDER_ID]
      : undefined;

  return (
    normalizeProjectId(v1Provider?.options?.projectId) ??
    normalizeProjectId(v1Provider?.settings?.projectId) ??
    normalizeProjectId(v2Provider?.settings?.projectId) ??
    normalizeProjectId(v2Provider?.options?.projectId)
  );
}

export async function resolveConfiguredProjectIdFromClient(
  client: PluginClient | null | undefined,
): Promise<string | undefined> {
  if (!client?.config?.get) {
    return undefined;
  }

  try {
    const result = await client.config.get();
    return resolveConfiguredProjectIdFromConfig(result?.data);
  } catch {
    return undefined;
  }
}

/**
 * Extracts `thinkingConfig` defaults from V1 (`options`) or V2 (`settings`) provider configs.
 */
export function resolveThinkingConfigDefaults(
  provider: Provider | null | undefined,
): ThinkingConfigDefaults | undefined {
  if (!provider || typeof provider !== "object") {
    return undefined;
  }
  const providerConfig = provider.options ?? provider.settings;
  const providerThinkingConfig =
    providerConfig && typeof providerConfig === "object"
      ? providerConfig.thinkingConfig
      : undefined;

  const modelThinkingConfigByModel: Record<string, unknown> = {};
  for (const [modelId, model] of Object.entries(provider.models ?? {})) {
    if (!model || typeof model !== "object") {
      continue;
    }
    const modelRecord = model as {
      options?: Record<string, unknown>;
      settings?: Record<string, unknown>;
    };
    const modelConfig = modelRecord.options ?? modelRecord.settings;
    if (modelConfig && typeof modelConfig === "object" && "thinkingConfig" in modelConfig) {
      modelThinkingConfigByModel[modelId] = modelConfig.thinkingConfig;
    }
  }

  if (providerThinkingConfig === undefined && Object.keys(modelThinkingConfigByModel).length === 0) {
    return undefined;
  }

  return {
    provider: providerThinkingConfig,
    models: modelThinkingConfigByModel,
  };
}

function normalizeProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}
