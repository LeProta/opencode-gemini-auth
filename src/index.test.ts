import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { setup } from ".";

process.env.OPENCODE_ANTIGRAVITY_UPDATE_CHECK = "0";

const realFetch = globalThis.fetch;
beforeAll(() => {
  // No network in tests: catalog/version refreshes fail and fall back to the cache.
  globalThis.fetch = (async () => new Response("offline", { status: 503 })) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const subscription = {
  type: "oauth",
  methodID: "antigravity",
  refresh: "refresh-token|proj-1",
  access: "access-token",
  expires: Date.now() + 3600_000,
};

function fakeContext(credential: unknown) {
  const transforms: { provider?: (draft: any) => void; integration?: (draft: any) => void } = {};
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const store = new Map<string, unknown>([
    [
      "antigravity-cache",
      {
        version: "2.31.2",
        versionFetchedAt: Date.now(),
        models: ["gemini-2.5-pro", "gemini-3-flash", "gemini-3.8-flash-low", "gemini-3.8-flash-high"],
        // Two accounts on different plans (the cache module keeps the first storage it is given).
        modelsByProject: { "proj-ultra": ["gemini-2.5-pro", "gemini-3-flash"], "proj-pro": ["gemini-3-flash"] },
      },
    ],
  ]);
  const ctx = {
    storage: { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => void store.set(key, value) },
    integration: {
      transform: async (cb: any) => {
        transforms.integration = cb;
      },
      connection: { active: async () => (credential ? { id: "c1" } : undefined), resolve: async () => credential },
    },
    provider: {
      transform: async (cb: any) => {
        transforms.provider = cb;
      },
      reload: async () => {},
    },
    session: { hook: async (name: string, cb: any) => void hooks.set(name, cb) },
  };
  return { ctx: ctx as any, transforms, hooks };
}

function googleDraft(ids: string[]) {
  const models = new Map(ids.map((id) => [id, { id, cost: [{ input: 1, output: 2 }] }]));
  return {
    models,
    draft: {
      get: (id: string) => (id === "google" ? { provider: { id: "google" }, models } : undefined),
      models: {
        remove: (_provider: string, id: string) => void models.delete(id),
        update: (_provider: string, id: string, fn: (model: any) => void) => fn(models.get(id)),
      },
    },
  };
}

describe("Google OAuth on the built-in provider", () => {
  it("registers its OAuth method on the google integration", async () => {
    const { ctx, transforms } = fakeContext(subscription);
    await setup(ctx);
    const registered: any[] = [];
    transforms.integration!({ method: { update: (input: any) => registered.push(input) } });
    expect(registered[0].integrationID).toBe("google");
    expect(registered[0].method).toMatchObject({ id: "antigravity", type: "oauth" });
  });

  it("hides models the subscription does not serve and zeroes prices", async () => {
    const { ctx, transforms } = fakeContext(subscription);
    await setup(ctx);
    const { draft, models } = googleDraft(["gemini-2.5-pro", "gemini-3.8-flash", "gemini-3-flash-preview", "gemini-4-argon"]);
    transforms.provider!(draft);
    expect([...models.keys()]).toEqual(["gemini-2.5-pro", "gemini-3.8-flash", "gemini-3-flash-preview"]);
    expect(models.get("gemini-2.5-pro")!.cost).toEqual([]);
  });

  it("leaves the provider alone with an API key", async () => {
    const { ctx, transforms, hooks } = fakeContext({ type: "api", key: "k" });
    await setup(ctx);
    const { draft, models } = googleDraft(["gemini-4-argon"]);
    transforms.provider!(draft);
    expect(models.get("gemini-4-argon")!.cost).toEqual([{ input: 1, output: 2 }]);

    const request = new Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent", {
      method: "POST",
      body: "{}",
    });
    const event = { request, model: { id: "gemini-4-argon" } };
    await hooks.get("http.request")!(event);
    expect(event.request).toBe(request);
  });

  it("sends a variant request to the matching Antigravity id", async () => {
    const { ctx, hooks } = fakeContext(subscription);
    await setup(ctx);
    const event = {
      model: { id: "gemini-3.8-flash" },
      request: new Request(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": "" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
            generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
          }),
        },
      ),
    };
    await hooks.get("http.request")!(event);
    expect(event.request.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    expect(event.request.headers.get("authorization")).toBe("Bearer access-token");
    const envelope = await event.request.json();
    expect(envelope).toMatchObject({ model: "gemini-3.8-flash-low", project: "proj-1", requestType: "agent" });
    expect(envelope.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "low" });
  });

  it("keeps using the token refreshed after a 401 on the next request", async () => {
    const credential = { ...subscription, refresh: "rt-401|proj-1", access: "revoked-token" };
    const { ctx, hooks } = fakeContext(credential);
    await setup(ctx);
    const offline = globalThis.fetch;
    const sentTokens: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response('{"access_token":"fresh-token","expires_in":3600}', { status: 200 });
      }
      if (url.includes("cloudcode-pa.googleapis.com")) {
        // Only the replayed generate call; the background catalog refresh also lands here.
        if (url.includes(":generateContent")) sentTokens.push(new Headers(init?.headers).get("authorization") ?? "");
        return new Response('{"response":{"candidates":[]}}', { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("offline", { status: 503 });
    }) as typeof fetch;
    try {
      const request = () => ({
        model: { id: "gemini-3-flash" },
        request: new Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent", {
          method: "POST",
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
        }),
      });
      const first = request();
      await hooks.get("http.request")!(first);
      expect(first.request.headers.get("authorization")).toBe("Bearer revoked-token");
      const response = { request: first.request, response: new Response("unauthorized", { status: 401 }), model: first.model };
      await hooks.get("http.response")!(response);
      expect(response.response.status).toBe(200);
      expect(sentTokens).toEqual(["Bearer fresh-token"]);

      const second = request();
      await hooks.get("http.request")!(second);
      expect(second.request.headers.get("authorization")).toBe("Bearer fresh-token");
    } finally {
      globalThis.fetch = offline;
    }
  });

  it("filters models with the catalog of the account in use", async () => {
    const visible = async (project: string) => {
      const { ctx, transforms } = fakeContext({ ...subscription, refresh: `rt-${project}|${project}` });
      await setup(ctx);
      const { draft, models } = googleDraft(["gemini-2.5-pro", "gemini-3-flash"]);
      transforms.provider!(draft);
      return [...models.keys()];
    };
    expect(await visible("proj-ultra")).toEqual(["gemini-2.5-pro", "gemini-3-flash"]);
    expect(await visible("proj-pro")).toEqual(["gemini-3-flash"]);
  });

  it("keeps each session's retry decision to itself", async () => {
    const { ctx, hooks } = fakeContext(subscription);
    await setup(ctx);
    const exhausted = () =>
      new Response(
        JSON.stringify({
          error: {
            message: "quota",
            details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED", domain: "cloudcode-pa.googleapis.com" }],
          },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );
    const turn = async (sessionID: string, response: Response) => {
      const event = {
        sessionID,
        agent: "build",
        model: { id: "gemini-3-flash" },
        request: new Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent", {
          method: "POST",
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
        }),
      };
      await hooks.get("http.request")!(event);
      await hooks.get("http.response")!({ ...event, request: event.request, response });
    };
    await turn("session-a", exhausted());
    await turn("session-b", new Response("busy", { status: 503 }));

    const retryA = { sessionID: "session-a", agent: "build", model: { id: "gemini-3-flash" }, attempt: 1, error: { status: 429, message: "quota" } } as any;
    await hooks.get("retry")!(retryA);
    expect(retryA.decision).toEqual({ retry: false });
  });

  it("explains instead of sending a model the subscription lacks", async () => {
    const { ctx, hooks } = fakeContext(subscription);
    await setup(ctx);
    const event = {
      model: { id: "gemini-4-argon" },
      request: new Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent", {
        method: "POST",
        body: "{}",
      }),
    };
    expect(hooks.get("http.request")!(event)).rejects.toThrow("not available with your Google subscription");
  });

  it("asks for the reasoning the request wants, with or without a level", async () => {
    const { ctx, hooks } = fakeContext(subscription);
    await setup(ctx);
    const sent = async (model: string, thinkingConfig: unknown) => {
      const event = {
        model: { id: model },
        request: new Request(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
          method: "POST",
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { thinkingConfig } }),
        }),
      };
      await hooks.get("http.request")!(event);
      return (await event.request.json()).request.generationConfig.thinkingConfig;
    };
    // OpenCode's default for Gemini 2.5: thoughts on, no budget.
    expect(await sent("gemini-2.5-pro", { includeThoughts: true })).toEqual({ includeThoughts: true, thinkingBudget: -1 });
    // A variant that only names its level still gets its reasoning shown.
    expect(await sent("gemini-3.8-flash", { thinkingLevel: "low" })).toEqual({ thinkingLevel: "low", includeThoughts: true });
    // An explicit opt-out stays off.
    expect(await sent("gemini-3.8-flash", { thinkingLevel: "low", includeThoughts: false })).toEqual({
      thinkingLevel: "low",
      includeThoughts: false,
    });
  });

  it("unwraps a response that arrives after the plugin was set up again", async () => {
    const first = fakeContext(subscription);
    const dispose = await setup(first.ctx);
    const event = {
      model: { id: "gemini-3-flash" },
      request: new Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent", {
        method: "POST",
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }),
    };
    await first.hooks.get("http.request")!(event);
    await dispose?.();
    const second = fakeContext(subscription);
    await setup(second.ctx);

    const envelope = () =>
      new Response('{"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]},"traceId":"t"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const viaNewSetup = { ...event, response: envelope() };
    await second.hooks.get("http.response")!(viaNewSetup);
    expect((await viaNewSetup.response.json()).candidates[0].content.parts[0].text).toBe("ok");
  });
});
