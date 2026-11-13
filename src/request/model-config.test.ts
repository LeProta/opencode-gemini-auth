import { describe, expect, it } from "bun:test";

import { getGeminiModelCapabilities } from "./model-config";

describe("getGeminiModelCapabilities", () => {
  it("resolves Gemini 3+ capabilities with level thinking and functionCall IDs", () => {
    expect(getGeminiModelCapabilities("gemini-3-flash-preview")).toEqual({
      family: "gemini-3",
      thinkingMode: "level",
      usesFunctionCallIds: true,
      requiresThoughtSignatureFallback: true,
    });
    expect(getGeminiModelCapabilities("models/gemini-3.1-pro-preview")).toEqual({
      family: "gemini-3",
      thinkingMode: "level",
      usesFunctionCallIds: true,
      requiresThoughtSignatureFallback: true,
    });
    expect(getGeminiModelCapabilities("google/gemini-3-pro")).toEqual({
      family: "gemini-3",
      thinkingMode: "level",
      usesFunctionCallIds: true,
      requiresThoughtSignatureFallback: true,
    });
  });

  it("resolves Gemini 2.5 capabilities with budget thinking and no functionCall IDs", () => {
    expect(getGeminiModelCapabilities("gemini-2.5-pro")).toEqual({
      family: "gemini-2.5",
      thinkingMode: "budget",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false,
    });
    expect(getGeminiModelCapabilities("gemini-2.5-flash-lite")).toEqual({
      family: "gemini-2.5",
      thinkingMode: "budget",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false,
    });
  });

  it("disables thinkingMode on image, 2.0, 1.x, and robotics models", () => {
    expect(getGeminiModelCapabilities("gemini-2.5-flash-image")).toEqual({
      family: "gemini-image",
      thinkingMode: "none",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false,
    });
    expect(getGeminiModelCapabilities("gemini-3-pro-image-preview")).toEqual({
      family: "gemini-image",
      thinkingMode: "none",
      usesFunctionCallIds: true,
      requiresThoughtSignatureFallback: true,
    });
    expect(getGeminiModelCapabilities("gemini-2.0-flash")).toEqual({
      family: "gemini-2.0",
      thinkingMode: "none",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false,
    });
    expect(getGeminiModelCapabilities("gemini-1.5-pro")).toEqual({
      family: "gemini-1.x",
      thinkingMode: "none",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false,
    });
    expect(getGeminiModelCapabilities("gemini-pro")).toEqual({
      family: "gemini-1.x",
      thinkingMode: "none",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false,
    });
    expect(getGeminiModelCapabilities("gemini-robotics-er-1.5-preview")).toEqual({
      family: "gemini-1.x",
      thinkingMode: "none",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false,
    });
  });

  it("handles unknown and unversioned Gemini model IDs safely", () => {
    expect(getGeminiModelCapabilities("")).toEqual({
      family: "unknown",
      thinkingMode: "none",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false,
    });
    expect(getGeminiModelCapabilities("gemini-exp-latest")).toEqual({
      family: "unknown",
      thinkingMode: "none",
      usesFunctionCallIds: true,
      requiresThoughtSignatureFallback: true,
    });
  });
});
