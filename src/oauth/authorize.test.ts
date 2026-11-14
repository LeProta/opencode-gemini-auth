import { describe, expect, it } from "bun:test";
import { createOAuthAuthorizeMethod, type OAuthAuthorization } from "./authorize";
import type { TokenExchangeResult } from "../types";

const hosted = "https://antigravity.google/oauth-callback";
const sampleAuth: OAuthAuthorization = {
  url: "https://accounts.google.com/o/oauth2/v2/auth?state=expected-state",
  verifier: "pkce-verifier",
  state: "expected-state",
};
const tokens = (refresh = "r"): TokenExchangeResult => ({
  type: "success",
  refresh,
  access: "a",
  expires: Date.now() + 3600_000,
});

/** A sign-in whose exchanges are recorded as [code, verifier]. */
function signIn(authorization: OAuthAuthorization = sampleAuth) {
  const exchanges: [string, string][] = [];
  const authorize = createOAuthAuthorizeMethod({
    authorizeFn: async () => authorization,
    exchangeFn: async (code, verifier) => {
      exchanges.push([code, verifier]);
      return tokens();
    },
  });
  return { authorize, exchanges };
}

describe("pasted-code sign-in", () => {
  const headlessKeys = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "OPENCODE_HEADLESS"] as const;

  it("is the same on a desktop and over SSH: the provider's URL, then the code to paste", async () => {
    const saved = headlessKeys.map((key) => process.env[key]);
    try {
      for (const headless of [false, true]) {
        for (const key of headlessKeys) delete process.env[key];
        if (headless) process.env.OPENCODE_HEADLESS = "1";
        const { authorize, exchanges } = signIn();
        const method = await authorize();
        expect(method.url).toBe(sampleAuth.url);
        expect(method.instructions).toBe("Paste the authorization code here:");
        // Google's page shows the bare code: PKCE ties it to this sign-in.
        expect((await method.callback("  4/0Ab-code  ")).type).toBe("success");
        expect(exchanges).toEqual([["4/0Ab-code", "pkce-verifier"]]);
      }
    } finally {
      headlessKeys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      });
    }
  });

  it("checks the state whenever the pasted text carries one", async () => {
    const { authorize, exchanges } = signIn();
    const method = await authorize();
    expect(await method.callback(`${hosted}?code=c1&state=bad`)).toEqual({
      type: "failed",
      error: "State mismatch in callback input (possible CSRF attempt)",
    });
    expect((await method.callback("code=c1&state=bad")).type).toBe("failed");
    expect(exchanges).toEqual([]);

    expect((await method.callback(`${hosted}?code=c1&state=expected-state`)).type).toBe("success");
    expect(exchanges).toEqual([["c1", "pkce-verifier"]]);
  });

  it("refuses a pasted error, an empty paste and text that is not a code, without calling Google", async () => {
    const { authorize, exchanges } = signIn();
    const method = await authorize();
    expect(await method.callback(`${hosted}?error=access_denied&error_description=User+cancelled`)).toEqual({
      type: "failed",
      error: "User cancelled",
    });
    expect((await method.callback("   ")).type).toBe("failed");
    expect((await method.callback(`${hosted}?state=expected-state`)).type).toBe("failed");
    // RFC 6749 Appendix A: a code is 1*VSCHAR.
    expect((await method.callback("4/0Aéb")).type).toBe("failed");
    expect((await method.callback("4/0A\r\nb")).type).toBe("failed");
    expect((await method.callback("x".repeat(4097))).type).toBe("failed");
    expect(exchanges).toEqual([]);
  });

  it("refuses a bare code when the sign-in has no PKCE verifier to tie it to", async () => {
    const { authorize, exchanges } = signIn({ ...sampleAuth, verifier: "" });
    const method = await authorize();
    expect((await method.callback("4/0Ab-code")).type).toBe("failed");
    expect(exchanges).toEqual([]);
    // The state still ties a full URL to the sign-in.
    expect((await method.callback(`${hosted}?code=c1&state=expected-state`)).type).toBe("success");
  });

  it("keeps the verifier of each sign-in with its own callback", async () => {
    let attempt = 0;
    const exchanges: [string, string][] = [];
    const authorize = createOAuthAuthorizeMethod({
      authorizeFn: async () => {
        attempt += 1;
        return { url: `https://example.test/${attempt}`, verifier: `verifier-${attempt}`, state: `state-${attempt}` };
      },
      exchangeFn: async (code, verifier) => {
        exchanges.push([code, verifier]);
        return tokens();
      },
    });
    const first = await authorize();
    const second = await authorize();
    await second.callback("code-b");
    await first.callback("code-a");
    // The state of another sign-in is refused.
    expect((await first.callback("code=code-b&state=state-2")).type).toBe("failed");
    expect(exchanges).toEqual([
      ["code-b", "verifier-2"],
      ["code-a", "verifier-1"],
    ]);
  });

  it("reports a refused or failed exchange and adds the project to a successful one", async () => {
    const outcomes: (TokenExchangeResult | Error)[] = [
      { type: "failed", error: "Google rejected the authorization code (400 invalid_grant)" },
      new Error("network down"),
      tokens("refresh-1"),
    ];
    const authorize = createOAuthAuthorizeMethod({
      authorizeFn: async () => sampleAuth,
      exchangeFn: async () => {
        const outcome = outcomes.shift();
        if (!outcome || outcome instanceof Error) throw outcome ?? new Error("no outcome left");
        return outcome;
      },
      resolveProjectContextFn: async (auth) => ({ auth: { ...auth, refresh: `${auth.refresh}|resolved-proj` } }),
    });
    const method = await authorize();
    expect(await method.callback("c1")).toEqual({
      type: "failed",
      error: "Google rejected the authorization code (400 invalid_grant)",
    });
    expect(await method.callback("c1")).toEqual({ type: "failed", error: "network down" });
    expect(await method.callback("c1")).toEqual({
      type: "success",
      refresh: "refresh-1|resolved-proj",
      access: "a",
      expires: expect.any(Number),
    });
  });
});
