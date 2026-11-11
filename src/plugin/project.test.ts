import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { formatRefreshParts, parseRefreshParts } from "./auth";
import {
  clearPersistedProjectFromAuth,
  createProjectContextCache,
  ensureProjectContext,
  invalidateProjectContextByAccount,
  invalidateProjectContextCache,
  resolveProjectContextFromAccessToken,
} from "./project";
import type { OAuthAuthDetails, PluginClient } from "./types";

const baseAuth: OAuthAuthDetails = {
  type: "oauth",
  refresh: "refresh-token",
  access: "access-token",
  expires: Date.now() + 60_000,
};

function toUrlString(input: RequestInfo): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return (input as Request).url ?? input.toString();
}

describe("resolveProjectContextFromAccessToken", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("stores managed project id from loadCodeAssist without onboarding", async () => {
    let loadHeaders: Headers | undefined;
    const fetchMock = mock(async (input: RequestInfo, init?: RequestInit) => {
      const url = toUrlString(input);
      if (url.includes(":loadCodeAssist")) {
        loadHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            currentTier: { id: "free-tier" },
            cloudaicompanionProject: "projects/server-project",
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await resolveProjectContextFromAccessToken(
      baseAuth,
      baseAuth.access ?? "",
      undefined,
      undefined,
      "gemini-3-flash-preview",
    );

    expect(result.effectiveProjectId).toBe("projects/server-project");
    expect(result.auth.refresh).toContain("projects/server-project");
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(loadHeaders?.get("User-Agent")).toContain("GeminiCLI/");
    expect(loadHeaders?.get("User-Agent")).toContain("/gemini-3-flash-preview ");
    expect(loadHeaders?.get("x-activity-request-id")).toBeTruthy();
    expect(loadHeaders?.get("Client-Metadata")).toBeNull();
    expect(loadHeaders?.get("X-Goog-Api-Client")).toBeNull();
  });

  it("onboards free-tier users without sending a project id", async () => {
    let onboardBody: Record<string, unknown> | undefined;
    let onboardHeaders: Headers | undefined;
    const fetchMock = mock(async (input: RequestInfo, init?: RequestInit) => {
      const url = toUrlString(input);
      if (url.includes(":loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            allowedTiers: [{ id: "free-tier", isDefault: true }],
          }),
          { status: 200 },
        );
      }
      if (url.includes(":onboardUser")) {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        onboardBody = JSON.parse(rawBody) as Record<string, unknown>;
        onboardHeaders = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            done: true,
            response: { cloudaicompanionProject: { id: "managed-project" } },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await resolveProjectContextFromAccessToken(
      baseAuth,
      baseAuth.access ?? "",
      undefined,
      undefined,
      "gemini-3-flash-preview",
    );

    expect(result.effectiveProjectId).toBe("managed-project");
    expect(result.auth.refresh).toContain("managed-project");
    expect(onboardBody?.cloudaicompanionProject).toBeUndefined();
    const metadata = onboardBody?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.duetProject).toBeUndefined();
    expect(onboardHeaders?.get("User-Agent")).toContain("/gemini-3-flash-preview ");
    expect(onboardHeaders?.get("x-activity-request-id")).toBeTruthy();
  });

  it("throws when a non-free tier requires a project id", async () => {
    const fetchMock = mock(async (input: RequestInfo) => {
      const url = toUrlString(input);
      if (url.includes(":loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            allowedTiers: [{ id: "standard-tier", isDefault: true }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await expect(
      resolveProjectContextFromAccessToken(baseAuth, baseAuth.access ?? ""),
    ).rejects.toThrow("Google Gemini requires a Google Cloud project");
  });

  it("continues with an allowed paid tier even when free tier is ineligible", async () => {
    let onboardBody: Record<string, unknown> | undefined;
    const fetchMock = mock(async (input: RequestInfo, init?: RequestInit) => {
      const url = toUrlString(input);
      if (url.includes(":loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            allowedTiers: [{ id: "standard-tier", isDefault: true }],
            ineligibleTiers: [
              {
                reasonCode: "INELIGIBLE_ACCOUNT",
                reasonMessage: "Not eligible for free tier",
                tierId: "free-tier",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes(":onboardUser")) {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        onboardBody = JSON.parse(rawBody) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            done: true,
            response: { cloudaicompanionProject: { id: "configured-project" } },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await resolveProjectContextFromAccessToken(
      baseAuth,
      baseAuth.access ?? "",
      "configured-project",
    );

    expect(result.effectiveProjectId).toBe("configured-project");
    expect(onboardBody?.cloudaicompanionProject).toBe("configured-project");
  });

  it("throws validation-required errors before tier onboarding even when allowed tiers exist", async () => {
    const fetchMock = mock(async (input: RequestInfo) => {
      const url = toUrlString(input);
      if (url.includes(":loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            allowedTiers: [{ id: "standard-tier", isDefault: true }],
            ineligibleTiers: [
              {
                reasonCode: "VALIDATION_REQUIRED",
                reasonMessage: "Verify your account to continue.",
                validationUrl: "https://example.com/verify",
                validationLearnMoreUrl: "https://example.com/help",
              },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await expect(
      resolveProjectContextFromAccessToken(baseAuth, baseAuth.access ?? "", "configured-project"),
    ).rejects.toThrow("Complete validation: https://example.com/verify");
  });

  it("prefers a configured project id over a persisted managed project id", async () => {
    const authWithManagedProject: OAuthAuthDetails = {
      ...baseAuth,
      refresh: formatRefreshParts({
        refreshToken: "refresh-token",
        managedProjectId: "managed-project",
      }),
    };

    let loadBody: Record<string, unknown> | undefined;
    const fetchMock = mock(async (input: RequestInfo, init?: RequestInit) => {
      const url = toUrlString(input);
      if (url.includes(":loadCodeAssist")) {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        loadBody = JSON.parse(rawBody) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            currentTier: { id: "standard-tier" },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await resolveProjectContextFromAccessToken(
      authWithManagedProject,
      authWithManagedProject.access ?? "",
      "configured-project",
    );

    expect(result.effectiveProjectId).toBe("configured-project");
    expect(loadBody?.cloudaicompanionProject).toBe("configured-project");
  });

  it("clears stale managedProjectId when configured project overrides loadCodeAssist response", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const authWithManagedProject: OAuthAuthDetails = {
        ...baseAuth,
        refresh: formatRefreshParts({
          refreshToken: "refresh-token",
          managedProjectId: "stale-managed-project",
        }),
      };
      const persisted: OAuthAuthDetails[] = [];
      (globalThis as { fetch: typeof fetch }).fetch = mock(async (input: RequestInfo) => {
        const url = toUrlString(input);
        if (url.includes(":loadCodeAssist")) {
          return new Response(
            JSON.stringify({
              currentTier: { id: "standard-tier" },
              cloudaicompanionProject: "projects/server-managed-project",
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch to ${url}`);
      }) as unknown as typeof fetch;

      const result = await resolveProjectContextFromAccessToken(
        authWithManagedProject,
        authWithManagedProject.access ?? "",
        "configured-project",
        async (updated) => {
          persisted.push(updated);
        },
      );

      expect(result.effectiveProjectId).toBe("configured-project");
      expect(result.auth.refresh).toBe(
        formatRefreshParts({
          refreshToken: "refresh-token",
          projectId: "configured-project",
        }),
      );
      expect(parseRefreshParts(result.auth.refresh).managedProjectId).toBeUndefined();
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.refresh).toBe(result.auth.refresh);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});

describe("ensureProjectContext caching and invalidation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it("caches resolved context per configured project and account scope", async () => {
    let loadCalls = 0;
    const fetchMock = mock(async (input: RequestInfo) => {
      const url = toUrlString(input);
      if (url.includes(":loadCodeAssist")) {
        loadCalls += 1;
        return new Response(
          JSON.stringify({
            currentTier: { id: "standard-tier" },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const client = { auth: { set: async () => {} } } satisfies PluginClient;
    const cache = createProjectContextCache();
    const persisted: OAuthAuthDetails[] = [];

    const first = await ensureProjectContext(baseAuth, client, "proj-a", undefined, {
      accountKey: "conn-1",
      cache,
      persistAuth: async (updated) => {
        persisted.push(updated);
      },
    });
    const secondPreHydration = await ensureProjectContext(baseAuth, client, "proj-a", undefined, {
      accountKey: "conn-1",
      cache,
      persistAuth: async () => {},
    });
    const thirdPostHydration = await ensureProjectContext(
      first.auth,
      client,
      "proj-a",
      undefined,
      {
        accountKey: "conn-1",
        cache,
        persistAuth: async () => {},
      },
    );

    expect(first.effectiveProjectId).toBe("proj-a");
    expect(secondPreHydration.effectiveProjectId).toBe("proj-a");
    expect(thirdPostHydration.effectiveProjectId).toBe("proj-a");
    expect(loadCalls).toBe(1);
    expect(persisted).toHaveLength(1);

    const otherProject = await ensureProjectContext(baseAuth, client, "proj-b", undefined, {
      accountKey: "conn-1",
      cache,
      persistAuth: async () => {},
    });
    expect(otherProject.effectiveProjectId).toBe("proj-b");
    expect(loadCalls).toBe(2);

    const otherAccount = await ensureProjectContext(baseAuth, client, "proj-a", undefined, {
      accountKey: "conn-2",
      cache,
      persistAuth: async () => {},
    });
    expect(otherAccount.effectiveProjectId).toBe("proj-a");
    expect(loadCalls).toBe(3);

    invalidateProjectContextByAccount("conn-1", cache);
    await ensureProjectContext(baseAuth, client, "proj-a", undefined, {
      accountKey: "conn-2",
      cache,
      persistAuth: async () => {},
    });
    expect(loadCalls).toBe(3);

    await ensureProjectContext(baseAuth, client, "proj-a", undefined, {
      accountKey: "conn-1",
      cache,
      persistAuth: async () => {},
    });
    expect(loadCalls).toBe(4);

    invalidateProjectContextCache(first.auth.refresh, cache);
    await ensureProjectContext(baseAuth, client, "proj-a", undefined, {
      accountKey: "conn-2",
      cache,
      persistAuth: async () => {},
    });
    expect(loadCalls).toBe(5);
  });

  it("clearPersistedProjectFromAuth strips project segments only when present", () => {
    const clean = clearPersistedProjectFromAuth(baseAuth);
    expect(clean).toBe(baseAuth);

    const dirty: OAuthAuthDetails = {
      ...baseAuth,
      refresh: formatRefreshParts({
        refreshToken: "refresh-token",
        projectId: "proj-1",
        managedProjectId: "managed-1",
      }),
    };
    const stripped = clearPersistedProjectFromAuth(dirty);
    expect(stripped).not.toBe(dirty);
    expect(stripped.refresh).toBe("refresh-token");
  });
});
