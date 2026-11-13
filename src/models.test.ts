import { describe, expect, it } from "bun:test";

import { requestedThinkingLevel, upstreamModelFor } from "./models";

const catalog = [
  "gemini-2.5-pro",
  "gemini-3-flash",
  "gemini-3.8-flash-low",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-tiered",
  "claude-sonnet-4-6",
];

describe("upstreamModelFor", () => {
  it("keeps ids the catalog serves as they are", () => {
    expect(upstreamModelFor("gemini-2.5-pro", catalog)).toBe("gemini-2.5-pro");
  });

  it("puts the requested thinking level into effort-suffixed ids", () => {
    expect(upstreamModelFor("gemini-3.8-flash", catalog, "low")).toBe("gemini-3.8-flash-low");
    expect(upstreamModelFor("gemini-3.8-flash", catalog, "medium")).toBe("gemini-3.8-flash-medium");
    expect(upstreamModelFor("gemini-3.8-flash", catalog)).toBe("gemini-3.8-flash-high");
    // an unknown level falls back to the strongest available effort
    expect(upstreamModelFor("gemini-3.8-flash", catalog, "minimal")).toBe("gemini-3.8-flash-high");
  });

  it("maps a preview id onto its released counterpart", () => {
    expect(upstreamModelFor("gemini-3-flash-preview", catalog)).toBe("gemini-3-flash");
  });

  it("finds nothing for models the subscription does not serve", () => {
    expect(upstreamModelFor("gemini-4-argon", catalog)).toBeUndefined();
    expect(upstreamModelFor("gemini-3.1-pro-preview", catalog)).toBeUndefined();
  });
});

describe("requestedThinkingLevel", () => {
  it("reads the level OpenCode's variants put in the body", () => {
    expect(requestedThinkingLevel(JSON.stringify({ generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } } }))).toBe("low");
    expect(requestedThinkingLevel(JSON.stringify({ contents: [] }))).toBeUndefined();
    expect(requestedThinkingLevel("not json")).toBeUndefined();
    expect(requestedThinkingLevel(undefined)).toBeUndefined();
  });
});
