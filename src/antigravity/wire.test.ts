import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";

import { antigravityEnvelope, defaultTierId, onboardBody, stableSessionId, userAgents } from "./wire";

describe("userAgents", () => {
  it("adds cl= only for known Hub releases", () => {
    expect(userAgents("2.24.0").short).toBe("antigravity/hub/2.24.0 (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)");
    expect(userAgents("2.31.2").short).toBe("antigravity/hub/2.31.2 (aidev_client; os_type=darwin; arch=arm64)");
    expect(userAgents("2.31.2").long).toEndWith(") google-api-nodejs-client/10.3.0");
  });
});

describe("antigravityEnvelope", () => {
  it("forces VALIDATED tool calling and keeps maxOutputTokens for Claude", () => {
    const env: any = antigravityEnvelope("claude-sonnet-4-5", "p", {
      contents: [{ role: "user", parts: [{ text: "x" }] }],
      generationConfig: { maxOutputTokens: 100 },
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    });
    expect(env.request.toolConfig.functionCallingConfig.mode).toBe("VALIDATED");
    expect(env.request.generationConfig.maxOutputTokens).toBe(100);
  });

  it("uses image_gen ids and no session for image models", () => {
    const env: any = antigravityEnvelope("gemini-3-pro-image", "", { contents: [] });
    expect(env.requestType).toBe("image_gen");
    expect(env.requestId).toMatch(/^image_gen\/\d+\/[0-9a-f-]{36}\/12$/);
    expect(env.request.sessionId).toBeUndefined();
    expect(env.project).toBeUndefined();
  });
});

describe("stableSessionId", () => {
  it("hashes the first user text like CLIProxyAPI", () => {
    const expected = createHash("sha256").update("hello").digest().readBigUInt64BE(0) & 0x7fffffffffffffffn;
    expect(stableSessionId([{ role: "model", parts: [{ text: "a" }] }, { role: "user", parts: [{ text: "hello" }] }])).toBe(
      `-${expected}`,
    );
  });
});

describe("registration", () => {
  it("picks the default allowed tier, then currentTier, then free-tier", () => {
    expect(defaultTierId({ allowedTiers: [{ id: "a" }, { id: "b", isDefault: true }], currentTier: { id: "c" } })).toBe("b");
    expect(defaultTierId({ currentTier: { id: "c" } })).toBe("c");
    expect(defaultTierId({})).toBe("free-tier");
    expect(onboardBody("b", "2.29.0").metadata).toEqual({ ide_type: "ANTIGRAVITY", ide_version: "2.29.0", ide_name: "antigravity" });
  });
});
