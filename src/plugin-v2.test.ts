import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";

import { resetRefreshBackoffState } from "./plugin/refresh-backoff";
import plugin, { setupV2 } from "./plugin-v2";

const projectEnvKeys = ["OPENCODE_GEMINI_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID"];
const savedEnv = new Map(projectEnvKeys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of projectEnvKeys) delete process.env[key];
});

afterEach(() => {
  mock.restore();
  resetRefreshBackoffState();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const providerResult = (projectId?: string): Awaited<ReturnType<Plugin.Context["provider"]["get"]>> => ({
  location: { directory: process.cwd() },
  data: {
    id: "google",
    name: "Google",
    activation: "auto",
    package: "@opencode/ai/providers/google",
    settings: projectId ? { projectId } : {},
  },
});

async function setup(getProvider: Plugin.Context["provider"]["get"] = async () => providerResult()) {
  let method: any;
  const hooks: Record<string, (event: any) => Promise<void>> = {};
  const credential = {
    type: "oauth",
    methodID: "gemini-cli",
    refresh: "refresh-token||managed-project",
    access: "access-token",
    expires: Date.now() + 60_000,
  };

  const context = {
    provider: { get: getProvider },
    integration: {
      async transform(callback: (draft: any) => void) {
        callback({ method: { update(input: any) { method = input; } } });
      },
      connection: {
        async active() { return { type: "credential" }; },
        async resolve() { return credential; },
      },
    },
    session: {
      async hook(name: string, callback: (event: any) => Promise<void>) { hooks[name] = callback; },
    },
  };
  await setupV2(context as unknown as Parameters<typeof setupV2>[0]);
  return { method, hooks, credential };
}

function requestEvent() {
  return {
    model: { providerID: "google", id: "gemini-2.5-pro" },
    request: new Request(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      { method: "POST", body: JSON.stringify({ contents: [] }) },
    ),
  };
}

test("V2 plugin registers OAuth and rewrites Gemini requests and responses", async () => {
  const { method, hooks } = await setup();

  expect(plugin.id).toBe("Gemini OAuth Plugin");
  expect(typeof plugin.setup).toBe("function");
  expect(method.integrationID).toBe("google");
  expect(method.method.id).toBe("gemini-cli");

  const event = requestEvent();
  await hooks["http.request"]!(event);

  expect(event.request.url).toContain("cloudcode-pa.googleapis.com/v1internal:streamGenerateContent");
  expect(event.request.headers.get("authorization")).toBe("Bearer access-token");
  expect(await event.request.clone().json()).toMatchObject({
    project: "managed-project",
    model: "gemini-2.5-pro",
  });

  const responseEvent = {
    ...event,
    response: Response.json({ response: { candidates: [] } }),
  };
  await hooks["http.response"]!(responseEvent);
  expect(await responseEvent.response.json()).toEqual({ candidates: [] });
});

test("V2 requests use the configured project from the stable provider API", async () => {
  const getProvider = mock(async () => providerResult("configured-project"));
  const { hooks } = await setup(getProvider);
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ currentTier: { id: "standard-tier" } }),
  );
  const event = requestEvent();
  await hooks["http.request"]!(event);

  expect(getProvider).toHaveBeenCalledWith({ providerID: "google" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toContain(":loadCodeAssist");
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
    cloudaicompanionProject: "configured-project",
  });
  expect(await event.request.json()).toMatchObject({ project: "configured-project" });
});

test("V2 provider lookup failures do not fall back to a persisted project", async () => {
  process.env.GOOGLE_CLOUD_PROJECT = "ambient-project";
  const { hooks } = await setup(async () => { throw new Error("Provider unavailable"); });
  const event = requestEvent();
  const original = event.request;
  const fetchMock = spyOn(globalThis, "fetch");

  await expect(hooks["http.request"]!(event)).rejects.toThrow("Provider unavailable");
  expect(event.request).toBe(original);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("V2 explicit project environment works without a provider lookup", async () => {
  process.env.OPENCODE_GEMINI_PROJECT_ID = "environment-project";
  const getProvider = mock(async () => { throw new Error("Should not be called"); });
  const { hooks } = await setup(getProvider);
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ currentTier: { id: "standard-tier" } }));
  const event = requestEvent();
  await hooks["http.request"]!(event);

  expect(getProvider).not.toHaveBeenCalled();
  expect(await event.request.json()).toMatchObject({ project: "environment-project" });
});

test("V2 requests with another OAuth method are left untouched", async () => {
  const getProvider = mock(async () => providerResult());
  const { hooks, credential } = await setup(getProvider);
  credential.methodID = "another-method";
  const event = requestEvent();
  const original = event.request;
  await hooks["http.request"]!(event);

  expect(event.request).toBe(original);
  expect(getProvider).not.toHaveBeenCalled();
});

test.each(["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID"])(
  "V2 explicit provider project takes precedence over %s",
  async (key) => {
    process.env[key] = "ambient-project";
    const getProvider = mock(async () => providerResult("explicit-project"));
    const { hooks } = await setup(getProvider);
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ currentTier: { id: "standard-tier" } }));
    const event = requestEvent();
    await hooks["http.request"]!(event);

    expect(getProvider).toHaveBeenCalledWith({ providerID: "google" });
    expect(await event.request.json()).toMatchObject({ project: "explicit-project" });
  },
);

test.each(["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID"])(
  "V2 falls back to %s when the provider has no configured project",
  async (key) => {
    process.env[key] = "ambient-project";
    const getProvider = mock(async () => providerResult());
    const { hooks } = await setup(getProvider);
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ currentTier: { id: "standard-tier" } }));
    const event = requestEvent();
    await hooks["http.request"]!(event);

    expect(getProvider).toHaveBeenCalledWith({ providerID: "google" });
    expect(await event.request.json()).toMatchObject({ project: "ambient-project" });
  },
);

async function setupFull(options?: {
  credential?: Record<string, unknown>;
  connection?: Record<string, unknown>;
  providerSettings?: Record<string, unknown>;
  models?: Array<{ id: string; cost: Array<Record<string, unknown>>; settings?: Record<string, unknown> }>;
  withStatusFn?: boolean;
}) {
  let method: any;
  let providerTransform: ((draft: any) => void) | undefined;
  let subscribeAbortSignal: AbortSignal | undefined;
  let pushEvent: ((event: any) => void) | undefined;
  let closeStream: (() => void) | undefined;

  const hooks: Record<string, (event: any) => Promise<void>> = {};
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const storageMap = new Map<string, unknown>();
  const syntheticCalls: any[] = [];
  const statusCalls: any[] = [];
  let reloadCount = 0;

  let activeConnection: any = options?.connection ?? {
    type: "credential",
    id: "conn-default",
    label: "Google",
    method: "oauth",
  };
  let activeCredential: any = options?.credential ?? {
    type: "oauth",
    methodID: "gemini-cli",
    refresh: "refresh-token||managed-project",
    access: "access-token",
    expires: Date.now() + 120_000,
    metadata: { email: "dev@example.com", projectId: "managed-project" },
  };
  let models = (options?.models ?? [
    {
      id: "gemini-2.5-pro",
      cost: [{ input: 1.25 }],
      settings: { thinkingConfig: { thinkingBudget: 2048 } },
    },
  ]).map((m) => ({ ...m, cost: [...m.cost] }));

  const applyProviderTransform = () => {
    if (!providerTransform) return;
    const modelMap = new Map(models.map((m) => [m.id, m]));
    providerTransform({
      get: (id: string) =>
        id === "google"
          ? {
              provider: { id: "google", settings: options?.providerSettings ?? {} },
              models: modelMap,
            }
          : undefined,
      models: {
        update: (_providerID: string, modelID: string, updater: (m: any) => void) => {
          const target = modelMap.get(modelID);
          if (target) updater(target);
        },
      },
    });
  };

  const connectionObj: Record<string, unknown> = {
    async active() {
      return activeConnection;
    },
    async resolve() {
      return activeCredential;
    },
  };
  if (options?.withStatusFn) {
    connectionObj.status = async (input: unknown) => {
      statusCalls.push(input);
    };
  }

  const context = {
    provider: {
      get: async () => ({
        location: { directory: process.cwd() },
        data: {
          id: "google",
          name: "Google",
          activation: "auto",
          package: "@opencode/ai/providers/google",
          settings: options?.providerSettings ?? {},
        },
      }),
      async transform(cb: (draft: any) => void) {
        providerTransform = cb;
        applyProviderTransform();
      },
      async reload() {
        reloadCount += 1;
        models = models.map((m) => ({ ...m, cost: [{ input: 1.25 }] }));
        applyProviderTransform();
      },
    },
    integration: {
      async transform(cb: (draft: any) => void) {
        cb({ method: { update(input: any) { method = input; } } });
      },
      connection: connectionObj,
    },
    event: {
      subscribe({ signal }: { signal?: AbortSignal } = {}) {
        subscribeAbortSignal = signal;
        const queue: any[] = [];
        let waiting: ((result: IteratorResult<any>) => void) | undefined;
        let closed = false;
        pushEvent = (ev) => {
          if (closed) return;
          if (waiting) {
            const resolve = waiting;
            waiting = undefined;
            resolve({ value: ev, done: false });
          } else {
            queue.push(ev);
          }
        };
        closeStream = () => {
          closed = true;
          if (waiting) {
            const resolve = waiting;
            waiting = undefined;
            resolve({ value: undefined, done: true });
          }
        };
        signal?.addEventListener("abort", () => closeStream?.(), { once: true });
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (queue.length > 0) {
                  return Promise.resolve({ value: queue.shift(), done: false });
                }
                if (closed || signal?.aborted) {
                  return Promise.resolve({ value: undefined, done: true });
                }
                return new Promise<IteratorResult<any>>((resolve) => {
                  waiting = resolve;
                });
              },
            };
          },
        };
      },
    },
    tool: {
      async transform(cb: (draft: any) => void) {
        cb({ add(def: any) { tools.set(def.name, def); } });
      },
    },
    command: {
      async transform(cb: (draft: any) => void) {
        cb({ add(def: any) { commands.set(def.name, def); } });
      },
    },
    storage: {
      async get(key: string) {
        return storageMap.get(key);
      },
      async set(key: string, value: unknown) {
        storageMap.set(key, value);
      },
      async remove(key: string) {
        storageMap.delete(key);
      },
      async scan() {
        return { keys: [...storageMap.keys()] };
      },
    },
    session: {
      async hook(name: string, cb: (event: any) => Promise<void>) {
        hooks[name] = cb;
      },
      async synthetic(input: unknown) {
        syntheticCalls.push(input);
      },
    },
  };

  const cleanup = await setupV2(context as unknown as Parameters<typeof setupV2>[0]);
  return {
    cleanup,
    method,
    hooks,
    tools,
    commands,
    storageMap,
    syntheticCalls,
    statusCalls,
    getModels: () => models,
    getReloadCount: () => reloadCount,
    getSubscribeSignal: () => subscribeAbortSignal,
    setActiveCredential: (nextCred: any, nextConn?: any) => {
      activeCredential = nextCred;
      if (nextConn !== undefined) activeConnection = nextConn;
    },
    emitEvent: (ev: any) => pushEvent?.(ev),
  };
}

test("V2 registers form field, label formatter, and enforces credential marker", async () => {
  const ctx = await setupFull({
    credential: {
      type: "oauth",
      methodID: "gemini-cli",
      refresh: "refresh-token|proj-x|",
      access: "access-token",
      expires: Date.now() + 120_000,
      metadata: {
        plugin: "other-plugin",
        email: "dev@example.com",
      },
    },
  });

  expect(ctx.method.method.form).toEqual([
    expect.objectContaining({ type: "string", key: "projectId", required: false }),
  ]);
  expect(
    ctx.method.label({
      type: "oauth",
      methodID: "gemini-cli",
      refresh: "rt|proj-1|",
      access: "at",
      expires: Date.now() + 120_000,
      metadata: { email: "alice@example.com", projectId: "proj-1" },
    }),
  ).toBe("alice@example.com (proj-1)");
  expect(
    ctx.method.label({
      type: "oauth",
      methodID: "gemini-cli",
      refresh: "rt||managed-1",
      access: "at",
      expires: Date.now() + 120_000,
    }),
  ).toBe("managed-1");

  // Mismatched metadata.plugin marker leaves request untouched
  const ev = requestEvent();
  const original = ev.request;
  await ctx.hooks["http.request"]!(ev);
  expect(ev.request).toBe(original);

  await ctx.cleanup();
  expect(ctx.getSubscribeSignal()?.aborted).toBe(true);
});

test("V2 provider.transform zeroes costs only for active gemini-cli OAuth and reloads on credential events", async () => {
  const ctx = await setupFull();

  expect(ctx.getModels()[0]?.cost).toEqual([]);

  // Apply thinkingConfig from model settings into V2 request
  const ev = requestEvent();
  await ctx.hooks["http.request"]!(ev);
  const body = await ev.request.clone().json();
  expect(body.request.generationConfig.thinkingConfig).toMatchObject({ thinkingBudget: 2048 });

  // Switch active credential to a non-gemini-cli method and emit credential.switched
  ctx.setActiveCredential({ type: "key", key: "AIza-manual-key" });
  ctx.emitEvent({ type: "credential.switched", data: { integrationID: "google" } });
  await new Promise((resolve) => setTimeout(resolve, 25));

  expect(ctx.getReloadCount()).toBe(1);
  expect(ctx.getModels()[0]?.cost).toEqual([{ input: 1.25 }]);

  await ctx.cleanup();
});

test("V2 caches project context per account, refreshes expired tokens with storage, and flags needs_auth on terminal errors", async () => {
  const ctx = await setupFull({
    providerSettings: { projectId: "configured-project" },
    credential: {
      type: "oauth",
      methodID: "gemini-cli",
      refresh: "refresh-expiring",
      access: "stale-access",
      expires: Date.now() - 5000,
      metadata: { plugin: "opencode.provider.google-gemini-cli" },
    },
    withStatusFn: true,
  });

  let loadCalls = 0;
  let tokenCalls = 0;
  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      tokenCalls += 1;
      return Response.json({
        access_token: "fresh-access-1",
        expires_in: 3600,
        refresh_token: "refresh-rotated",
      });
    }
    if (url.includes(":loadCodeAssist")) {
      loadCalls += 1;
      return Response.json({ currentTier: { id: "standard-tier" } });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as unknown as typeof fetch);

  const ev1 = requestEvent();
  await ctx.hooks["http.request"]!(ev1);
  expect(tokenCalls).toBe(1);
  expect(loadCalls).toBe(1);
  expect(ev1.request.headers.get("authorization")).toBe("Bearer fresh-access-1");
  expect(ctx.storageMap.get("gemini-oauth:conn-default")).toMatchObject({
    access: "fresh-access-1",
    refresh: "refresh-rotated|configured-project|",
    sourceRefresh: "refresh-expiring",
  });

  // Second request on same account adopts refreshed storage token and hits project cache
  const ev2 = requestEvent();
  await ctx.hooks["http.request"]!(ev2);
  expect(tokenCalls).toBe(1);
  expect(loadCalls).toBe(1);
  expect(ev2.request.headers.get("authorization")).toBe("Bearer fresh-access-1");

  // Different connection id isolates project cache and triggers terminal invalid_grant needs_auth status
  ctx.setActiveCredential(
    {
      type: "oauth",
      methodID: "gemini-cli",
      refresh: "refresh-revoked",
      access: "stale",
      expires: Date.now() - 1000,
      metadata: { plugin: "opencode.provider.google-gemini-cli" },
    },
    { type: "credential", id: "conn-second", label: "Work", method: "oauth" },
  );

  (globalThis.fetch as any).mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({ error: "invalid_grant", error_description: "Token revoked" }, { status: 400 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });

  await expect(ctx.hooks["http.request"]!(requestEvent())).rejects.toThrow("Reconnect Google");
  expect(ctx.statusCalls).toHaveLength(1);
  expect(ctx.statusCalls[0]).toMatchObject({
    integrationID: "google",
    status: { status: "needs_auth" },
  });

  await ctx.cleanup();
});

test("V2 http.response replays 401 once using WeakMap snapshot when request bodyUsed is true", async () => {
  const ctx = await setupFull({
    credential: {
      type: "oauth",
      methodID: "gemini-cli",
      refresh: "refresh-401-test||managed-project",
      access: "access-token-initial",
      expires: Date.now() + 120_000,
      metadata: { plugin: "opencode.provider.google-gemini-cli" },
    },
  });

  const replayCalls: Array<{ url: string; auth: string | null; body: string | null }> = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "replayed-access-token", expires_in: 3600 });
    }
    const headers = new Headers(init?.headers);
    replayCalls.push({
      url,
      auth: headers.get("authorization"),
      body: typeof init?.body === "string" ? init.body : null,
    });
    return Response.json({ response: { candidates: [{ index: 0 }] } });
  }) as unknown as typeof fetch);

  const ev = requestEvent();
  await ctx.hooks["http.request"]!(ev);

  // Consume outbound Request body to simulate real fetch() before http.response runs
  await ev.request.text();
  expect(ev.request.bodyUsed).toBe(true);

  const resEv = {
    ...ev,
    response: new Response("Unauthorized", { status: 401 }),
  };
  await ctx.hooks["http.response"]!(resEv);

  expect(replayCalls).toHaveLength(1);
  expect(replayCalls[0]?.auth).toBe("Bearer replayed-access-token");
  expect(JSON.parse(replayCalls[0]?.body ?? "{}")).toMatchObject({
    project: "managed-project",
    model: "gemini-2.5-pro",
  });
  expect(await resEv.response.json()).toEqual({ candidates: [{ index: 0 }] });

  await ctx.cleanup();
});

test("V2 session retry hook respects terminal QUOTA_EXHAUSTED, RetryInfo delay, and max attempts", async () => {
  const ctx = await setupFull({
    credential: {
      type: "oauth",
      methodID: "gemini-cli",
      refresh: "refresh-retry-test||managed-project",
      access: "access-token",
      expires: Date.now() + 120_000,
    },
  });

  // 1. Terminal QUOTA_EXHAUSTED disables retries immediately
  const ev1 = requestEvent();
  await ctx.hooks["http.request"]!(ev1);
  const terminalResEv = {
    ...ev1,
    response: new Response(
      JSON.stringify({
        error: {
          code: 429,
          message: "Quota exhausted",
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "QUOTA_EXHAUSTED",
              domain: "cloudcode-pa.googleapis.com",
            },
          ],
        },
      }),
      { status: 429 },
    ),
  };
  await ctx.hooks["http.response"]!(terminalResEv);

  const retryTerminal = {
    sessionID: "sess-1",
    agent: "build",
    model: { providerID: "google", id: "gemini-2.5-pro" },
    error: { type: "api", message: "Quota exhausted", status: 429 },
    attempt: 1,
    decision: { retry: true, delay: 1000 } as { retry: boolean; delay?: number },
  };
  await ctx.hooks["retry"]!(retryTerminal);
  expect(retryTerminal.decision).toEqual({ retry: false });

  // 2. Transient RATE_LIMIT_EXCEEDED with RetryInfo 3s schedules 3000ms retry up to attempt < 3
  const ev2 = {
    model: { providerID: "google", id: "gemini-2.5-flash" },
    request: new Request(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      { method: "POST", body: JSON.stringify({ contents: [] }) },
    ),
  };
  await ctx.hooks["http.request"]!(ev2);
  await ctx.hooks["http.response"]!({
    ...ev2,
    response: new Response(
      JSON.stringify({
        error: {
          code: 429,
          message: "Rate limit exceeded",
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "RATE_LIMIT_EXCEEDED",
              domain: "cloudcode-pa.googleapis.com",
            },
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "3s",
            },
          ],
        },
      }),
      { status: 429 },
    ),
  });

  const retryScheduled = {
    sessionID: "sess-1",
    agent: "build",
    model: { providerID: "google", id: "gemini-2.5-flash" },
    error: { type: "api", message: "Rate limit exceeded", status: 429 },
    attempt: 1,
    decision: { retry: false } as { retry: boolean; delay?: number },
  };
  await ctx.hooks["retry"]!(retryScheduled);
  expect(retryScheduled.decision).toEqual({ retry: true, delay: 3000 });

  const retryMaxed = {
    sessionID: "sess-1",
    agent: "build",
    model: { providerID: "google", id: "gemini-2.5-flash" },
    error: { type: "api", message: "Rate limit exceeded", status: 429 },
    attempt: 3,
    decision: { retry: true, delay: 3000 } as { retry: boolean; delay?: number },
  };
  await ctx.hooks["retry"]!(retryMaxed);
  expect(retryMaxed.decision).toEqual({ retry: false });

  const retryBadRequest = {
    sessionID: "sess-1",
    agent: "build",
    model: { providerID: "google", id: "gemini-2.5-flash" },
    error: { type: "api", message: "Invalid argument", status: 400 },
    attempt: 1,
    decision: { retry: true, delay: 1000 } as { retry: boolean; delay?: number },
  };
  await ctx.hooks["retry"]!(retryBadRequest);
  expect(retryBadRequest.decision).toEqual({ retry: false });

  await ctx.cleanup();
});

test("V2 registers gemini_quota tool and /gquota command via session.synthetic", async () => {
  const ctx = await setupFull();

  spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json({
      buckets: [
        {
          modelId: "gemini-2.5-pro",
          tokenType: "REQUESTS",
          remainingFraction: 0.8,
          remainingAmount: "160",
        },
      ],
    })) as unknown as typeof fetch);

  const tool = ctx.tools.get("gemini_quota");
  expect(tool).toBeDefined();
  const toolResult = await tool.execute({}, { signal: new AbortController().signal });
  expect(toolResult.metadata).toMatchObject({ ok: true, projectId: "managed-project" });
  expect(toolResult.content).toContain("Gemini quota usage for project `managed-project`");
  expect(toolResult.content).toContain("80.0% (160 left)");

  const command = ctx.commands.get("gquota");
  expect(command).toBeDefined();
  await command.execute({
    sessionID: "sess-42",
    prompt: { text: "/gquota" },
    delivery: "queue",
  });
  expect(ctx.syntheticCalls).toHaveLength(1);
  expect(ctx.syntheticCalls[0]).toMatchObject({
    sessionID: "sess-42",
    delivery: "queue",
    resume: false,
  });
  expect(ctx.syntheticCalls[0].text).toContain("Gemini quota usage for project `managed-project`");

  await ctx.cleanup();
});

test("V2 http.response keeps 401 response body readable when forced refresh fails", async () => {
  const ctx = await setupFull({
    credential: {
      type: "oauth",
      methodID: "gemini-cli",
      refresh: "refresh-401-fail||managed-project",
      access: "access-token-initial",
      expires: Date.now() + 120_000,
      metadata: { plugin: "opencode.provider.google-gemini-cli" },
    },
    withStatusFn: true,
  });

  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({ error: "invalid_grant", error_description: "Token expired" }, { status: 400 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as unknown as typeof fetch);

  const ev = requestEvent();
  await ctx.hooks["http.request"]!(ev);

  const resEv = {
    ...ev,
    response: new Response(
      JSON.stringify({ error: { code: 401, message: "Invalid credentials" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ),
  };
  await ctx.hooks["http.response"]!(resEv);

  expect(resEv.response.status).toBe(401);
  expect(resEv.response.bodyUsed).toBe(false);
  expect(await resEv.response.json()).toEqual({
    error: { code: 401, message: "Invalid credentials" },
  });
  expect(ctx.statusCalls).toHaveLength(1);
  expect(ctx.statusCalls[0]).toMatchObject({ status: { status: "needs_auth" } });

  await ctx.cleanup();
});

test("V2 session retry hook leaves non-OAuth google connection decisions untouched", async () => {
  const ctx = await setupFull({
    connection: { type: "key", id: "key-default", label: "API Key", method: "key" },
    credential: { type: "key", key: "AIza-manual-key" },
  });

  const decisionBefore = { retry: true, delay: 1234 };
  const retryEvent = {
    sessionID: "sess-key",
    agent: "build",
    model: { providerID: "google", id: "gemini-2.5-pro" },
    error: { type: "api", message: "Quota exhausted", status: 400 },
    attempt: 2,
    decision: { ...decisionBefore },
  };
  await ctx.hooks["retry"]!(retryEvent);
  expect(retryEvent.decision).toEqual(decisionBefore);

  await ctx.cleanup();
});

test("V2 needs_auth status does not flap on unchanged revoked non-expired credential", async () => {
  const revokedCred = {
    type: "oauth",
    methodID: "gemini-cli",
    refresh: "refresh-revoked-non-expired||managed-project",
    access: "revoked-still-valid-ts",
    expires: Date.now() + 120_000,
    metadata: { plugin: "opencode.provider.google-gemini-cli" },
  };
  const ctx = await setupFull({
    credential: revokedCred,
    withStatusFn: true,
  });

  spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      return Response.json({ error: "invalid_grant", error_description: "Revoked" }, { status: 400 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as unknown as typeof fetch);

  const ev1 = requestEvent();
  await ctx.hooks["http.request"]!(ev1);
  await ctx.hooks["http.response"]!({
    ...ev1,
    response: Response.json({ error: { code: 401, message: "Unauthorized" } }, { status: 401 }),
  });

  expect(ctx.statusCalls).toHaveLength(1);
  expect(ctx.statusCalls[0]).toMatchObject({ status: { status: "needs_auth" } });

  // Subsequent http.request before user reconnects must NOT clear needs_auth
  await ctx.hooks["http.request"]!(requestEvent());
  expect(ctx.statusCalls).toHaveLength(1);

  // Reconnecting with a different credential clears needs_auth back to undefined
  ctx.setActiveCredential({
    type: "oauth",
    methodID: "gemini-cli",
    refresh: "refresh-reconnected||managed-project",
    access: "fresh-reconnected-access",
    expires: Date.now() + 120_000,
    metadata: { plugin: "opencode.provider.google-gemini-cli" },
  });
  await ctx.hooks["http.request"]!(requestEvent());
  expect(ctx.statusCalls).toHaveLength(2);
  expect(ctx.statusCalls[1]).toMatchObject({ status: undefined });

  await ctx.cleanup();
});

test("V2 provider.transform reload clears stale provider thinkingConfig defaults when removed", async () => {
  let activeSettings: Record<string, unknown> | undefined = {
    thinkingConfig: { thinkingBudget: 4096 },
  };
  let providerTransform: ((draft: any) => void) | undefined;
  const hooks: Record<string, (event: any) => Promise<void>> = {};
  const modelMap = new Map<string, any>([["gemini-2.5-pro", { id: "gemini-2.5-pro", cost: [] }]]);

  const runTransform = () => {
    providerTransform?.({
      get: () => ({
        provider: { id: "google", settings: activeSettings },
        models: modelMap,
      }),
      models: { update: () => {} },
    });
  };

  const ctx = {
    provider: {
      get: async () => ({
        location: { directory: process.cwd() },
        data: {
          id: "google",
          name: "Google",
          activation: "auto",
          package: "@opencode/ai/providers/google",
          settings: activeSettings ?? {},
        },
      }),
      async transform(cb: (draft: any) => void) {
        providerTransform = cb;
        runTransform();
      },
      async reload() {
        runTransform();
      },
    },
    integration: {
      async transform() {},
      connection: {
        async active() {
          return { type: "credential", id: "conn-settings", label: "Google", method: "oauth" };
        },
        async resolve() {
          return {
            type: "oauth",
            methodID: "gemini-cli",
            refresh: "rt||managed-project",
            access: "at",
            expires: Date.now() + 120_000,
          };
        },
      },
    },
    session: {
      async hook(name: string, cb: (event: any) => Promise<void>) {
        hooks[name] = cb;
      },
    },
  };

  const cleanup = await setupV2(ctx as unknown as Parameters<typeof setupV2>[0]);

  const ev1 = requestEvent();
  await hooks["http.request"]!(ev1);
  const body1 = await ev1.request.clone().json();
  expect(body1.request.generationConfig.thinkingConfig).toMatchObject({ thinkingBudget: 4096 });

  activeSettings = undefined;
  await ctx.provider.reload();

  const ev2 = requestEvent();
  await hooks["http.request"]!(ev2);
  const body2 = await ev2.request.clone().json();
  expect(body2.request.generationConfig).toBeUndefined();

  await cleanup();
});
