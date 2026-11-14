import { describe, expect, it } from "bun:test";

import { readCache, writeCache } from "./cache";

describe("plugin cache", () => {
  it("keeps both patches of two writes made at the same time", async () => {
    await readCache();
    await Promise.all([writeCache({ models: ["gemini-3-flash"] }), writeCache({ modelCaps: { "gemini-3-flash": {} } })]);
    expect(await readCache()).toMatchObject({ models: ["gemini-3-flash"], modelCaps: { "gemini-3-flash": {} } });
  });
});
