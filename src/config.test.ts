import { afterEach, describe, expect, it } from "bun:test";

import { writeCache } from "./cache";
import { VERSION_OVERRIDE_ENV, currentVersion } from "./config";
import { DEFAULT_VERSION, userAgents } from "./wire";

const realFetch = globalThis.fetch;
const realOverride = process.env[VERSION_OVERRIDE_ENV];
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realOverride === undefined) delete process.env[VERSION_OVERRIDE_ENV];
  else process.env[VERSION_OVERRIDE_ENV] = realOverride;
});

describe("currentVersion", () => {
  it("is the version set in the code: nothing is read from the network or from an old cache", async () => {
    delete process.env[VERSION_OVERRIDE_ENV];
    // What a cache written by an earlier release holds, old enough to have triggered its manifest lookup.
    await writeCache({ version: "2.99.0", versionFetchedAt: Date.now() - 48 * 60 * 60 * 1000 } as never);
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response("version: 2.98.0\n", { status: 200 });
    }) as unknown as typeof fetch;

    expect(currentVersion()).toBe(DEFAULT_VERSION);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toBe(0);
    // The default is a release whose changelist is recorded: its User-Agent is complete.
    expect(userAgents(DEFAULT_VERSION).short).toMatch(
      /^antigravity\/hub\/\d+\.\d+\.\d+ \(aidev_client; os_type=darwin; arch=arm64; cl=\d+\)$/,
    );
  });

  it("follows a valid manual setting and ignores a malformed one", async () => {
    process.env[VERSION_OVERRIDE_ENV] = "2.40.1";
    expect(currentVersion()).toBe("2.40.1");
    for (const malformed of ["2.40.1 (aidev_client; os_type=linux", "2.40.1\r\nX-Injected: 1", "02.40.1", "latest"]) {
      process.env[VERSION_OVERRIDE_ENV] = malformed;
      expect(currentVersion()).toBe(DEFAULT_VERSION);
    }
  });
});
