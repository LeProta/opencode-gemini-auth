import { describe, expect, it, mock } from "bun:test";
import type { GeminiAuthorization, GeminiTokenExchangeResult } from "../gemini/oauth";
import { createOAuthAuthorizeMethod } from "./oauth-authorize";
import {
  createOAuthCallbackRequestHandler,
  startOAuthListener,
  type OAuthListener,
  type OAuthListenerOptions,
} from "./server";

interface RecordedHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function createInProcessListenerHarness() {
  let capturedOptions: OAuthListenerOptions | undefined;
  let deliverCallbackFn!: (url: URL) => void;
  let waiterResolve: ((url: URL) => void) | undefined;
  let waiterReject: ((error: Error) => void) | undefined;
  let deliveredQueue: URL[] = [];
  let closed = false;

  const harness = {
    startListenerFn: async (opts: OAuthListenerOptions = {}): Promise<OAuthListener> => {
      capturedOptions = opts;
      deliverCallbackFn = (url: URL) => {
        if (waiterResolve) {
          const resolve = waiterResolve;
          waiterResolve = undefined;
          waiterReject = undefined;
          resolve(url);
          return;
        }
        deliveredQueue.push(url);
      };

      return {
        port: 8085,
        redirectUri: "http://127.0.0.1:8085/oauth2callback",
        waitForCallback: () => {
          if (deliveredQueue.length > 0) {
            return Promise.resolve(deliveredQueue.shift() as URL);
          }
          return new Promise<URL>((resolve, reject) => {
            waiterResolve = resolve;
            waiterReject = reject;
          });
        },
        close: async () => {
          closed = true;
          waiterReject?.(new Error("closed"));
        },
      };
    },
    async dispatchRequest(requestUrl: string): Promise<RecordedHttpResponse> {
      const handler = createOAuthCallbackRequestHandler({
        getOrigin: () => "http://127.0.0.1:8085",
        callbackPath: "/oauth2callback",
        onCallback: capturedOptions?.onCallback,
        deliverCallback: deliverCallbackFn,
        failPendingWaiters: (err) => waiterReject?.(err),
      });

      return await new Promise<RecordedHttpResponse>((resolve) => {
        let statusCode = 0;
        let headers: Record<string, string> = {};
        handler(
          { url: requestUrl },
          {
            writeHead(code: number, hdrs?: Record<string, string>) {
              statusCode = code;
              headers = (hdrs ?? {}) as Record<string, string>;
              return this as never;
            },
            end(chunk?: unknown, cb?: () => void) {
              const body = typeof chunk === "string" ? chunk : String(chunk ?? "");
              cb?.();
              resolve({ statusCode, headers, body });
              return this as never;
            },
          } as never,
        );
      });
    },
    isClosed: () => closed,
  };

  return harness;
}

describe("oauth-authorize and localhost callback server", () => {
  const sampleAuth: GeminiAuthorization = {
    url: "https://accounts.google.com/o/oauth2/v2/auth?state=expected-state",
    verifier: "pkce-verifier",
    state: "expected-state",
  };

  it("binds an ephemeral localhost listener and enforces timeout cleanly", async () => {
    const listener = await startOAuthListener({
      redirectUri: "http://127.0.0.1:0/oauth2callback",
      timeoutMs: 25,
    });
    try {
      expect(listener.port).toBeGreaterThan(0);
      expect(listener.redirectUri).toBe(`http://127.0.0.1:${listener.port}/oauth2callback`);
      await expect(listener.waitForCallback()).rejects.toThrow("Timed out waiting for OAuth callback");
    } finally {
      await listener.close();
    }
  });

  it("sends 400 on state mismatch, rejects malformed code, and returns 200 only after exchange succeeds", async () => {
    const harness = createInProcessListenerHarness();
    const openBrowser = mock(() => {});
    const exchangeCalls: string[] = [];

    const authorize = createOAuthAuthorizeMethod({
      isHeadless: () => false,
      openBrowser,
      authorizeFn: async () => sampleAuth,
      exchangeFn: async (code): Promise<GeminiTokenExchangeResult> => {
        exchangeCalls.push(code);
        if (code === "bad-code") {
          return { type: "failed", error: "invalid_grant: malformed auth code" };
        }
        return {
          type: "success",
          refresh: "refresh-1",
          access: "access-1",
          expires: Date.now() + 3600_000,
        };
      },
      resolveProjectContextFn: async (auth, _access, configuredProjectId) => ({
        auth: {
          ...auth,
          refresh: `refresh-1|${configuredProjectId ?? "default-proj"}`,
        },
        effectiveProjectId: configuredProjectId ?? "default-proj",
      }),
      startListenerFn: harness.startListenerFn,
    });

    const method = await authorize({ projectId: "user-selected-proj" });
    expect(method.method).toBe("auto");
    expect(openBrowser.mock.calls.length).toBe(1);
    if (method.method !== "auto") {
      throw new Error("Expected auto OAuth method");
    }

    const resultPromise = method.callback();

    const incompleteResp = await harness.dispatchRequest("/oauth2callback?code=only-code");
    expect(incompleteResp.statusCode).toBe(400);

    const mismatchResp = await harness.dispatchRequest(
      "/oauth2callback?code=any-code&state=wrong-state",
    );
    expect(mismatchResp.statusCode).toBe(400);
    expect(mismatchResp.body).not.toContain("You're connected to Opencode");

    const malformedResp = await harness.dispatchRequest(
      "/oauth2callback?code=bad-code&state=expected-state",
    );
    expect(malformedResp.statusCode).toBe(400);
    expect(malformedResp.body).not.toContain("You're connected to Opencode");

    const okResp = await harness.dispatchRequest(
      "/oauth2callback?code=good-code&state=expected-state",
    );
    expect(okResp.statusCode).toBe(200);
    expect(okResp.body).toContain("You're connected to Opencode");

    const outcome = await resultPromise;
    expect(outcome).toEqual({
      type: "success",
      refresh: "refresh-1|user-selected-proj",
      access: "access-1",
      expires: expect.any(Number),
    });
    expect(exchangeCalls).toEqual(["bad-code", "good-code"]);
    expect(harness.isClosed()).toBe(true);
  });

  it("responds with HTTP 502 error page and fails when token exchange fails", async () => {
    const harness = createInProcessListenerHarness();

    const authorize = createOAuthAuthorizeMethod({
      isHeadless: () => false,
      openBrowser: () => {},
      authorizeFn: async () => sampleAuth,
      exchangeFn: async () => ({
        type: "failed",
        error: "invalid_client: bad <client> configuration",
      }),
      startListenerFn: harness.startListenerFn,
    });

    const method = await authorize();
    if (method.method !== "auto") {
      throw new Error("Expected auto OAuth method");
    }

    const resultPromise = method.callback();
    const failResp = await harness.dispatchRequest(
      "/oauth2callback?code=good-code&state=expected-state",
    );
    expect(failResp.statusCode).toBe(502);
    expect(failResp.body).toContain("Authentication failed");
    expect(failResp.body).toContain("bad &lt;client&gt; configuration");
    expect(failResp.body).not.toContain("You're connected to Opencode");

    const outcome = await resultPromise;
    expect(outcome).toEqual({
      type: "failed",
      error: "invalid_client: bad <client> configuration",
    });
  });

  it("supports headless manual code flow including pasted error redirect and state check", async () => {
    const authorize = createOAuthAuthorizeMethod({
      isHeadless: () => true,
      authorizeFn: async () => sampleAuth,
      exchangeFn: async (code) => ({
        type: "success",
        refresh: `refresh-${code}`,
        access: "manual-access",
        expires: Date.now() + 3600_000,
      }),
      resolveProjectContextFn: async (auth) => ({
        auth,
        effectiveProjectId: "",
      }),
    });

    const method = await authorize();
    expect(method.method).toBe("code");
    if (method.method !== "code") {
      throw new Error("Expected code OAuth method");
    }

    const denied = await method.callback(
      "http://localhost:8085/oauth2callback?error=access_denied&error_description=User+cancelled",
    );
    expect(denied).toEqual({ type: "failed", error: "User cancelled" });

    const badState = await method.callback(
      "http://localhost:8085/oauth2callback?code=c1&state=bad",
    );
    expect(badState.type).toBe("failed");

    const success = await method.callback(
      "http://localhost:8085/oauth2callback?code=c1&state=expected-state",
    );
    expect(success).toEqual({
      type: "success",
      refresh: "refresh-c1",
      access: "manual-access",
      expires: expect.any(Number),
    });
  });
});
