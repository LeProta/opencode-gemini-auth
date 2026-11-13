import { describe, expect, it } from "bun:test";

import { readCache, writeCache } from "./cache";

describe("plugin cache", () => {
  it("keeps both patches of two writes made at the same time", async () => {
    await readCache();
    await Promise.all([writeCache({ version: "9.9.9" }), writeCache({ updateCheckedAt: 123 })]);
    expect(await readCache()).toMatchObject({ version: "9.9.9", updateCheckedAt: 123 });
  });
});
