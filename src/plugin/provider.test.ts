import { describe, expect, it } from "bun:test";

import {
  resolveConfiguredProjectId,
  resolveConfiguredProjectIdFromClient,
  resolveConfiguredProjectIdFromConfig,
  resolveConfiguredProjectIdFromProvider,
  resolveThinkingConfigDefaults,
} from "./provider";
import type { PluginClient, PluginConfig, Provider } from "./types";

describe("resolveConfiguredProjectId", () => {
  it("reads project id from provider options", () => {
    const provider = {
      options: {
        projectId: "  provider-project  ",
      },
      models: {},
    } satisfies Provider;

    expect(
      resolveConfiguredProjectId({
        provider,
        env: {},
      }),
    ).toBe("provider-project");
  });

  it("falls back to the top-level config project id when provider options are unavailable", () => {
    const config = {
      provider: {
        google: {
          options: {
            projectId: "config-project",
          },
        },
      },
    } satisfies PluginConfig;

    expect(resolveConfiguredProjectIdFromConfig(config)).toBe("config-project");
    expect(
      resolveConfiguredProjectId({
        config,
        env: {},
      }),
    ).toBe("config-project");
  });

  it("prefers OPENCODE_GEMINI_PROJECT_ID over config and google cloud env vars", () => {
    expect(
      resolveConfiguredProjectId({
        configProjectId: "config-project",
        env: {
          OPENCODE_GEMINI_PROJECT_ID: "opencode-project",
          GOOGLE_CLOUD_PROJECT: "google-project",
        },
      }),
    ).toBe("opencode-project");
  });

  it("reads the current project id from the Opencode config API when available", async () => {
    const client = {
      auth: {
        set: async () => {},
      },
      config: {
        get: async () => ({
          data: {
            provider: {
              google: {
                options: {
                  projectId: "live-config-project",
                },
              },
            },
          } satisfies PluginConfig,
        }),
      },
    } satisfies PluginClient;

    await expect(resolveConfiguredProjectIdFromClient(client)).resolves.toBe("live-config-project");
  });

  it("supports V2 provider settings and providers.google.settings", () => {
    const v2Provider = {
      settings: {
        projectId: "  v2-provider-project  ",
      },
      models: {},
    } satisfies Provider;

    expect(resolveConfiguredProjectIdFromProvider(v2Provider)).toBe("v2-provider-project");
    expect(
      resolveConfiguredProjectId({
        provider: v2Provider,
        env: {},
      }),
    ).toBe("v2-provider-project");

    const v2Config = {
      providers: {
        google: {
          settings: {
            projectId: "v2-config-project",
          },
        },
      },
    } satisfies PluginConfig;

    expect(resolveConfiguredProjectIdFromConfig(v2Config)).toBe("v2-config-project");
  });
});

describe("resolveThinkingConfigDefaults", () => {
  it("extracts V1 options and V2 settings thinkingConfig defaults for provider and models", () => {
    const v1Provider = {
      options: {
        thinkingConfig: { thinkingBudget: 1024 },
      },
      models: {
        "gemini-2.5-pro": {
          options: {
            thinkingConfig: { thinkingBudget: 4096 },
          },
        },
      },
    } satisfies Provider;

    expect(resolveThinkingConfigDefaults(v1Provider)).toEqual({
      provider: { thinkingBudget: 1024 },
      models: {
        "gemini-2.5-pro": { thinkingBudget: 4096 },
      },
    });

    const v2Provider = {
      settings: {
        thinkingConfig: { thinkingLevel: "high" },
      },
      models: {
        "gemini-3-flash-preview": {
          settings: {
            thinkingConfig: { includeThoughts: true },
          },
        },
      },
    } satisfies Provider;

    expect(resolveThinkingConfigDefaults(v2Provider)).toEqual({
      provider: { thinkingLevel: "high" },
      models: {
        "gemini-3-flash-preview": { includeThoughts: true },
      },
    });

    expect(resolveThinkingConfigDefaults({ models: {} })).toBeUndefined();
  });
});
