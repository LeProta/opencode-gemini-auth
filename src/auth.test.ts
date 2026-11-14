import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "bun:test";

import { antigravityAuthorization, exchangeCode, parseTokenResponse, refreshAuth } from "./auth";

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
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:51121/oauth-callback");
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  });

  it("sends the verifier with the code exchange", async () => {
    const calls = tokenEndpoint(200, '{"access_token":"a","expires_in":3600,"refresh_token":"r"}');
    const result = await exchangeCode("auth-code", "verifier-123");
    expect(result.type).toBe("success");
    const form = new URLSearchParams(String(calls[0]?.body));
    expect(form.get("code_verifier")).toBe("verifier-123");
    expect(form.get("code")).toBe("auth-code");
    expect(form.get("grant_type")).toBe("authorization_code");
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
