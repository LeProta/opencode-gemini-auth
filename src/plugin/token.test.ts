import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GEMINI_PROVIDER_ID } from "../constants";
import { clearCachedAuth } from "./cache";
import { resetRefreshBackoffState } from "./refresh-backoff";
import { acquireRefreshLock } from "./refresh-lock";
import { getLastRefreshFailureKind, refreshAccessToken } from "./token";
import type { OAuthAuthDetails, PluginClient } from "./types";

const originalSetTimeout = globalThis.setTimeout;
const originalFetch = globalThis.fetch;

const baseAuth: OAuthAuthDetails = {
  type: "oauth",
  refresh: "refresh-token|project-123",
  access: "old-access",
  expires: Date.now() - 1000,
};

function createClient() {
  return {
    auth: {
      set: mock(async () => {}),
    },
  } as PluginClient & {
    auth: { set: ReturnType<typeof mock<(input: any) => Promise<void>>> };
  };
}

describe("refreshAccessToken", () => {
  beforeEach(() => {
    mock.restore();
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: (...args: any[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
  });

  afterEach(() => {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
  });

  it("updates the caller but skips persisting when refresh token is unchanged", async () => {
    const client = createClient();
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client);

    expect(result?.access).toBe("new-access");
    expect(client.auth.set.mock.calls.length).toBe(0);
  });

  it("persists when Google rotates the refresh token", async () => {
    const client = createClient();
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: "next-access",
          expires_in: 3600,
          refresh_token: "rotated-token",
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client);

    expect(result?.access).toBe("next-access");
    expect(client.auth.set.mock.calls.length).toBe(1);
    expect(client.auth.set.mock.calls[0]?.[0]).toEqual({
      path: { id: GEMINI_PROVIDER_ID },
      body: expect.objectContaining({
        type: "oauth",
        refresh: expect.stringContaining("rotated-token"),
      }),
    });
  });

  it("deduplicates concurrent refresh calls for the same refresh token", async () => {
    const client = createClient();
    let releaseFetch!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });

    const fetchMock = mock(async () => {
      await gate;
      return new Response(
        JSON.stringify({
          access_token: "deduped-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const first = refreshAccessToken(baseAuth, client);
    const second = refreshAccessToken(baseAuth, client);
    await Promise.resolve();

    expect(fetchMock.mock.calls.length).toBe(1);
    releaseFetch();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult?.access).toBe("deduped-access");
    expect(secondResult?.access).toBe("deduped-access");
  });

  it("retries transient network errors during token refresh", async () => {
    const client = createClient();
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        const err = new Error("socket reset") as Error & { code?: string };
        err.code = "ECONNRESET";
        throw err;
      }
      return new Response(
        JSON.stringify({
          access_token: "recovered-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client);

    expect(result?.access).toBe("recovered-access");
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("retries retryable HTTP errors from token endpoint", async () => {
    const client = createClient();
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response("temporarily unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          access_token: "recovered-after-503",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client);

    expect(result?.access).toBe("recovered-after-503");
    expect(fetchMock.mock.calls.length).toBe(2);
  });
});

describe("refreshAccessToken reliability & persistence", () => {
  const lockDirs: string[] = [];

  const createTempLockDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "gemini-token-lock-"));
    lockDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    resetRefreshBackoffState();
    clearCachedAuth();
    while (lockDirs.length > 0) {
      const dir = lockDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("invokes options.persist on non-rotated token refresh while preserving V1 client.auth.set behavior", async () => {
    const client = createClient();
    const lockDir = createTempLockDir();
    const persisted: OAuthAuthDetails[] = [];
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: "fresh-access-no-rotate",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "tok-persist|proj-1",
      access: "stale",
      expires: Date.now() - 1000,
    };

    const updated = await refreshAccessToken(auth, client, {
      lockDir,
      persist: async (next) => {
        persisted.push(next);
      },
    });

    expect(updated?.access).toBe("fresh-access-no-rotate");
    expect(persisted.length).toBe(1);
    expect(persisted[0]?.access).toBe("fresh-access-no-rotate");
    expect(client.auth.set.mock.calls.length).toBe(0);
  });

  it("waits on cross-process lock and adopts updated credentials written by lock holder", async () => {
    const lockDir = createTempLockDir();
    const holderLock = acquireRefreshLock("tok-adopt", { dir: lockDir });
    expect(holderLock).not.toBeNull();

    let adoptedState: OAuthAuthDetails = {
      type: "oauth",
      refresh: "tok-adopt|proj-1",
      access: "stale",
      expires: Date.now() - 1000,
    };

    const fetchMock = mock(async () => {
      throw new Error("fetch should not run when adopting peer refresh");
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    setTimeout(() => {
      adoptedState = {
        type: "oauth",
        refresh: "tok-adopt-rotated|proj-1",
        access: "peer-fresh-access",
        expires: Date.now() + 3600_000,
      };
      holderLock!.release();
    }, 25);

    const result = await refreshAccessToken(
      {
        type: "oauth",
        refresh: "tok-adopt|proj-1",
        access: "stale",
        expires: Date.now() - 1000,
      },
      undefined,
      {
        lockDir,
        pollIntervalMs: 10,
        maxLockWaitMs: 1000,
        readLatest: () => adoptedState,
      },
    );

    expect(result?.access).toBe("peer-fresh-access");
    expect(result?.refresh).toBe("tok-adopt-rotated|proj-1");
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  it("handles terminal errors by clearing persisted credentials and blocking further hits", async () => {
    const client = createClient();
    const lockDir = createTempLockDir();
    const persisted: OAuthAuthDetails[] = [];
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const revokedAuth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "tok-revoked|proj-9",
      access: "stale",
      expires: Date.now() - 1000,
    };

    const first = await refreshAccessToken(revokedAuth, client, {
      lockDir,
      persist: async (next) => {
        persisted.push(next);
      },
    });
    expect(first).toBeUndefined();
    expect(getLastRefreshFailureKind(revokedAuth)).toBe("terminal");
    expect(persisted.length).toBe(1);
    expect(persisted[0]?.refresh).toBe("");
    expect(client.auth.set.mock.calls.length).toBe(1);

    const second = await refreshAccessToken(revokedAuth, client, { lockDir });
    expect(second).toBeUndefined();
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("enforces exponential cooldown on transient failures and recovers after cooldown expires", async () => {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: (...args: any[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const lockDir = createTempLockDir();
    let clock = 500_000;
    const now = () => clock;
    let shouldFail = true;

    const fetchMock = mock(async () => {
      if (shouldFail) {
        return new Response("down", { status: 503 });
      }
      return new Response(JSON.stringify({ access_token: "after-cooldown", expires_in: 3600 }), {
        status: 200,
      });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "tok-transient|proj-2",
      access: "stale",
      expires: clock - 1000,
    };

    const failed = await refreshAccessToken(auth, undefined, {
      lockDir,
      baseCooldownMs: 15_000,
      now,
    });
    expect(failed).toBeUndefined();
    expect(getLastRefreshFailureKind(auth)).toBe("transient");
    const callsAfterFirstFail = fetchMock.mock.calls.length;
    expect(callsAfterFirstFail).toBeGreaterThanOrEqual(1);

    const cooledDown = await refreshAccessToken(auth, undefined, {
      lockDir,
      baseCooldownMs: 15_000,
      now,
    });
    expect(cooledDown).toBeUndefined();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstFail);

    clock += 16_000;
    shouldFail = false;
    const recovered = await refreshAccessToken(auth, undefined, {
      lockDir,
      baseCooldownMs: 15_000,
      now,
    });
    expect(recovered?.access).toBe("after-cooldown");
    expect(getLastRefreshFailureKind(auth)).toBeUndefined();
  });

  it("aborts immediately on AbortSignal without marking transient failure", async () => {
    const lockDir = createTempLockDir();
    const controller = new AbortController();
    const fetchMock = mock(async () => {
      controller.abort();
      return new Response("retry me", { status: 503 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const auth: OAuthAuthDetails = {
      type: "oauth",
      refresh: "tok-abort|proj-3",
      access: "stale",
      expires: Date.now() - 1000,
    };

    const result = await refreshAccessToken(auth, undefined, {
      lockDir,
      signal: controller.signal,
    });

    expect(result).toBeUndefined();
    expect(getLastRefreshFailureKind(auth)).toBeUndefined();
  });
});
