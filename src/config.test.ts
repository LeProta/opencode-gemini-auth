import { afterEach, describe, expect, it } from "bun:test";

import { writeCache } from "./cache";
import { currentVersion, resetVersionForTests } from "./config";
import { FALLBACK_VERSION, userAgents } from "./wire";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetVersionForTests();
});

const HOUR = 60 * 60 * 1000;

describe("currentVersion", () => {
  it("answers with a version cached earlier today while the manifest is read behind it", async () => {
    await writeCache({ version: "2.30.0", versionFetchedAt: Date.now() - 8 * HOUR });
    let release!: () => void;
    const manifest = new Promise<void>((resolve) => {
      release = resolve;
    });
    let manifestRequests = 0;
    globalThis.fetch = (async () => {
      manifestRequests++;
      await manifest;
      return new Response("version: 2.31.5\n", { status: 200 });
    }) as unknown as typeof fetch;
    resetVersionForTests();

    // The manifest has not answered yet: the request path is not held.
    expect(await currentVersion()).toBe("2.30.0");
    expect(manifestRequests).toBe(1);

    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await currentVersion()).toBe("2.31.5");
    expect(manifestRequests).toBe(1);
  });

  it("still waits for the manifest when nothing usable is cached", async () => {
    await writeCache({ version: "2.20.0", versionFetchedAt: Date.now() - 48 * HOUR });
    globalThis.fetch = (async () => new Response("version: 2.31.6\n", { status: 200 })) as unknown as typeof fetch;
    resetVersionForTests();
    expect(await currentVersion()).toBe("2.31.6");
  });

  it("only reports a plain x.y.z, wherever the value comes from", async () => {
    const manifest = (text: string) => {
      globalThis.fetch = (async () => new Response(text, { status: 200 })) as unknown as typeof fetch;
      resetVersionForTests();
    };

    // A stored value that would rewrite the User-Agent is not used, however fresh it looks.
    for (const stored of ["2.32.1 (aidev_client; os_type=linux", "2.32.1\r\nX-Injected: 1", "latest", 2.32]) {
      await writeCache({ version: stored as string, versionFetchedAt: Date.now() });
      manifest("version: 2.31.7\n");
      expect(await currentVersion()).toBe("2.31.7");
    }

    // Neither is a published value that is not a release number.
    for (const published of ["02.31.7", "2.31.7000000", "2.31"]) {
      await writeCache({ version: "", versionFetchedAt: 0 });
      manifest(`version: ${published}\n`);
      const version = await currentVersion();
      expect(version).toBe(FALLBACK_VERSION);
      expect(userAgents(version).short).toMatch(
        /^antigravity\/hub\/\d+\.\d+\.\d+ \(aidev_client; os_type=darwin; arch=arm64(; cl=\d+)?\)$/,
      );
    }
  });
});
