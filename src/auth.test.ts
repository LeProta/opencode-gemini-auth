import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "bun:test";

import { antigravityAuthorization, authorizeAntigravity, exchangeCode, parseTokenResponse, refreshAuth } from "./auth";
import { resetVersionForTests } from "./config";

const hosted = "https://antigravity.google/oauth-callback";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Token endpoint answers with `body`; everything else (version manifest) is offline. */
function tokenEndpoint(status: number, body: string) {
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("oauth2.googleapis.com/token")) {
      calls.push(init ?? {});
      return new Response(body, { status, headers: { "content-type": "application/json" } });
    }
    return new Response("offline", { status: 503 });
  }) as typeof fetch;
  return calls;
}

describe("parseTokenResponse", () => {
  it("accepts a complete response", () => {
    expect(parseTokenResponse('{"access_token":"a","expires_in":10,"refresh_token":"r"}', 1000)).toEqual({
      access: "a",
      expires: 11_000,
      refresh: "r",
    });
  });

  it("rejects a missing or empty access token, bad expiry and non-JSON", () => {
    expect(parseTokenResponse('{"expires_in":3600}')).toBeUndefined();
    expect(parseTokenResponse('{"access_token":"","expires_in":3600}')).toBeUndefined();
    expect(parseTokenResponse('{"access_token":"a","expires_in":-1}')).toBeUndefined();
    expect(parseTokenResponse('{"access_token":"a","expires_in":"3600"}')).toBeUndefined();
    expect(parseTokenResponse('{"access_token":"a","refresh_token":42}')).toBeUndefined();
    expect(parseTokenResponse("<html>")).toBeUndefined();
  });

  it("rejects values that are not tokens or would corrupt the stored credential", () => {
    const token = (fields: object) => parseTokenResponse(JSON.stringify({ access_token: "a", expires_in: 3600, ...fields }), 1000);
    expect(token({})?.expires).toBe(3_601_000);
    // RFC 6749 Appendix A: VSCHAR only. U+FFFD is what a mis-decoded byte becomes.
    expect(token({ access_token: "ya29.a\ufffdb" })).toBeUndefined();
    expect(token({ access_token: "ya29.a\r\nX-Injected: 1" })).toBeUndefined();
    expect(token({ refresh_token: "1//r\u00e9" })).toBeUndefined();
    // "|" would be read back as the project separator: the token would be stored truncated.
    expect(token({ refresh_token: "1//abc|other-project" })).toBeUndefined();
    // An expiry the clock can never reach would leave the access token unrefreshed.
    expect(token({ expires_in: Number.MAX_SAFE_INTEGER })).toBeUndefined();
  });
});

describe("Google sign-in PKCE (RFC 7636)", () => {
  it("binds the authorization code to a per-sign-in S256 challenge", async () => {
    const first = await antigravityAuthorization();
    const second = await antigravityAuthorization();
    const url = new URL(first.url);
    expect(first.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(first.verifier).digest("base64url"));
    expect(second.verifier).not.toBe(first.verifier);
    // What the Antigravity client registered is untouched.
    expect(url.searchParams.get("state")).toBe(first.state);
    expect(url.searchParams.getAll("redirect_uri")).toEqual([hosted]);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  });

  it("sends the verifier and the same redirect URI with the code exchange", async () => {
    const calls = tokenEndpoint(200, '{"access_token":"a","expires_in":3600,"refresh_token":"r"}');
    const result = await exchangeCode("auth-code", "verifier-123");
    expect(result.type).toBe("success");
    const form = new URLSearchParams(String(calls[0]?.body));
    expect(form.get("code_verifier")).toBe("verifier-123");
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.getAll("redirect_uri")).toEqual([hosted]);
  });

  it("signs in on a desktop with Google's code page, without a local listener", async () => {
    const headlessKeys = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "OPENCODE_HEADLESS"] as const;
    const saved = headlessKeys.map((key) => process.env[key]);
    for (const key of headlessKeys) delete process.env[key];
    try {
      const method = await authorizeAntigravity();
      const url = new URL(method.url);
      expect(method.instructions).toBe("Paste the authorization code here:");
      expect(url.searchParams.getAll("redirect_uri")).toEqual([hosted]);
      // Nothing answers on the port the Antigravity client registered for its loopback redirect.
      await expect(realFetch("http://127.0.0.1:51121/oauth-callback")).rejects.toThrow();

      // The bare code goes to Google with this sign-in's verifier and the same redirect URI.
      const calls = tokenEndpoint(400, '{"error":"invalid_grant"}');
      expect(await method.callback("4/0Ab-code")).toEqual({
        type: "failed",
        error: "Google rejected the authorization code (400 invalid_grant)",
      });
      const form = new URLSearchParams(String(calls[0]?.body));
      expect(form.get("code")).toBe("4/0Ab-code");
      expect(form.getAll("redirect_uri")).toEqual([hosted]);
      expect(createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url")).toBe(
        url.searchParams.get("code_challenge") ?? "",
      );
    } finally {
      headlessKeys.forEach((key, index) => {
        if (saved[index] !== undefined) process.env[key] = saved[index];
      });
    }
  });
});

describe("refreshAuth", () => {
  const auth = { type: "oauth" as const, refresh: "rt-1|proj-1", access: "old", expires: 0 };

  it("refuses a 200 response without an access token", async () => {
    tokenEndpoint(200, '{"expires_in":3600}');
    await expect(refreshAuth(auth, async () => {})).rejects.toThrow("invalid token response");
  });

  it("sends one token request for concurrent callers and lets each one persist its own copy", async () => {
    const calls = tokenEndpoint(200, '{"access_token":"fresh","expires_in":3600}');
    const saved: string[] = [];
    const [a, b] = await Promise.all([
      refreshAuth({ ...auth, refresh: "rt-c|proj-a" }, async (next) => void saved.push(`a:${next.access}:${next.refresh}`)),
      refreshAuth({ ...auth, refresh: "rt-c|proj-b" }, async (next) => void saved.push(`b:${next.access}:${next.refresh}`)),
    ]);
    expect(calls.length).toBe(1);
    expect(saved.sort()).toEqual(["a:fresh:rt-c|proj-a|", "b:fresh:rt-c|proj-b|"]);
    expect([a.refresh, b.refresh]).toEqual(["rt-c|proj-a|", "rt-c|proj-b|"]);
  });

  it("keeps the project id, refuses redirects and never echoes the raw error body", async () => {
    const calls = tokenEndpoint(200, '{"access_token":"new","expires_in":3600}');
    const next = await refreshAuth(auth, async () => {});
    expect(next.access).toBe("new");
    expect(next.refresh).toBe("rt-1|proj-1|");
    expect(calls[0]!.redirect).toBe("error");

    tokenEndpoint(400, '{"error":"invalid_grant","error_description":"secret-ish details"}');
    const failure = refreshAuth({ ...auth, refresh: "rt-2" }, async () => {}).catch((error: Error) => error.message);
    const message = await failure;
    expect(message).toContain("invalid_grant");
    expect(message).toContain("opencode auth login google --method antigravity");
    expect(message).not.toContain("secret-ish");
  });

  it("never sends again a refresh token Google refused as invalid_grant", async () => {
    const refused = { ...auth, refresh: "rt-revoked|proj-1" };
    const calls = tokenEndpoint(400, '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}');
    await expect(refreshAuth(refused, async () => {})).rejects.toThrow("invalid_grant");
    await expect(refreshAuth(refused, async () => {})).rejects.toThrow("will not be sent again");
    // Same token under another project id, and a working endpoint: still not sent.
    const later = tokenEndpoint(200, '{"access_token":"fresh","expires_in":3600}');
    await expect(refreshAuth({ ...auth, refresh: "rt-revoked" }, async () => {})).rejects.toThrow("opencode auth login google");
    expect(calls.length + later.length).toBe(1);
    // A new sign-in has another token.
    expect((await refreshAuth({ ...auth, refresh: "rt-after-sign-in" }, async () => {})).access).toBe("fresh");
  });

  it("does not wait for the version manifest: the token request is the same for every version", async () => {
    resetVersionForTests();
    const tokenUserAgents: (string | null)[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        tokenUserAgents.push(new Headers(init?.headers).get("user-agent"));
        return new Response('{"access_token":"quick","expires_in":3600}');
      }
      return new Promise<Response>(() => {}); // the manifest never answers
    }) as typeof fetch;
    const next = await refreshAuth({ ...auth, refresh: "rt-no-manifest" }, async () => {});
    expect(next.access).toBe("quick");
    expect(tokenUserAgents).toEqual(["Go-http-client/2.0"]);
  });

  it("keeps retrying after failures that are not a definitive refusal", async () => {
    const flaky = { ...auth, refresh: "rt-flaky" };
    for (const [status, body] of [
      [500, '{"error":"internal_failure"}'],
      [400, '{"error":"invalid_request"}'],
      [401, '{"error":"invalid_client"}'],
      [401, '{"error":"invalid_grant"}'],
      [400, "not json"],
    ] as const) {
      tokenEndpoint(status, body);
      await expect(refreshAuth(flaky, async () => {})).rejects.toThrow("Google");
    }
    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    await expect(refreshAuth(flaky, async () => {})).rejects.toThrow("network down");

    const calls = tokenEndpoint(200, '{"access_token":"recovered","expires_in":3600}');
    expect((await refreshAuth(flaky, async () => {})).access).toBe("recovered");
    expect(calls.length).toBe(1);
  });
});

describe("versionOverride", () => {
  it("uses a well-formed version and ignores anything else", async () => {
    const { versionOverride } = await import("./config");
    expect(versionOverride("2.40.1")).toBe("2.40.1");
    expect(versionOverride(" 2.40.1 ")).toBe("2.40.1");
    expect(versionOverride(undefined)).toBeUndefined();
    expect(versionOverride("")).toBeUndefined();
    expect(versionOverride("2.40")).toBeUndefined();
    expect(versionOverride("02.40.1")).toBeUndefined();
    expect(versionOverride("2.40.1; rm -rf")).toBeUndefined();
  });
});
