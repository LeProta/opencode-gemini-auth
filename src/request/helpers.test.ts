import { describe, expect, it } from "bun:test";

import {
  enhanceGeminiErrorResponse,
  extractUsageMetadata,
  normalizeThinkingConfig,
  parseGeminiApiBody,
} from "./helpers";

describe("enhanceGeminiErrorResponse", () => {
  it("adds retry hint and rate-limit message for 429 rate limits", () => {
    const body = {
      error: {
        message: "rate limited",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
            domain: "cloudcode-pa.googleapis.com",
          },
          {
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "5s",
          },
        ],
      },
    };

    const result = enhanceGeminiErrorResponse(body, 429);
    expect(result?.retryAfterMs).toBe(5000);
    expect(result?.body?.error?.message).toContain("Rate limit exceeded");
  });

  it("adds quota exhausted message for terminal limits", () => {
    const body = {
      error: {
        message: "quota exhausted",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "QUOTA_EXHAUSTED",
            domain: "cloudcode-pa.googleapis.com",
          },
        ],
      },
    };

    const result = enhanceGeminiErrorResponse(body, 429);
    expect(result?.body?.error?.message).toContain("Quota exhausted");
    expect(result?.retryAfterMs).toBeUndefined();
  });

  it("adds validation links for VALIDATION_REQUIRED errors", () => {
    const body = {
      error: {
        message: "validation required",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "VALIDATION_REQUIRED",
            domain: "cloudcode-pa.googleapis.com",
          },
          {
            "@type": "type.googleapis.com/google.rpc.Help",
            links: [
              { url: "https://example.com/validate" },
              { description: "Learn more", url: "https://support.google.com/help" },
            ],
          },
        ],
      },
    };

    const result = enhanceGeminiErrorResponse(body, 403);
    expect(result?.body?.error?.message).toContain("Complete validation: https://example.com/validate");
    expect(result?.body?.error?.message).toContain("Learn more: https://support.google.com/help");
  });

  it("extracts retry delay from message text when details are missing", () => {
    const body = {
      error: {
        message: "Please retry in 2s",
      },
    };

    const result = enhanceGeminiErrorResponse(body, 503);
    expect(result?.retryAfterMs).toBe(2000);
  });
});

describe("normalizeThinkingConfig", () => {
  it("forces includeThoughts to false when thinking is not enabled", () => {
    expect(normalizeThinkingConfig({ includeThoughts: true })).toEqual({ includeThoughts: false });
    expect(normalizeThinkingConfig({ thinkingBudget: 0, includeThoughts: true })).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    });
  });

  it("keeps includeThoughts when thinking is enabled by budget or level", () => {
    expect(normalizeThinkingConfig({ thinkingBudget: 8192, includeThoughts: true })).toEqual({
      thinkingBudget: 8192,
      includeThoughts: true,
    });
    expect(normalizeThinkingConfig({ thinkingLevel: "HIGH", includeThoughts: true })).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    });
  });

  it("supports dynamic thinkingBudget (-1) and none/off levels", () => {
    expect(normalizeThinkingConfig({ thinkingBudget: -1, includeThoughts: true })).toEqual({
      thinkingBudget: -1,
      includeThoughts: true,
    });
    expect(normalizeThinkingConfig({ thinkingLevel: "none", includeThoughts: true })).toEqual({
      thinkingLevel: "none",
      includeThoughts: false,
    });
    expect(normalizeThinkingConfig({ thinkingLevel: "OFF", includeThoughts: true })).toEqual({
      thinkingLevel: "off",
      includeThoughts: false,
    });
  });

  it("enforces model-family thinkingMode mutual exclusion", () => {
    expect(
      normalizeThinkingConfig(
        { thinkingLevel: "HIGH", thinkingBudget: 8192, includeThoughts: true },
        { thinkingMode: "level" },
      ),
    ).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    });
    expect(
      normalizeThinkingConfig(
        { thinkingLevel: "HIGH", thinkingBudget: 8192, includeThoughts: true },
        { thinkingMode: "budget" },
      ),
    ).toEqual({
      thinkingBudget: 8192,
      includeThoughts: true,
    });
    expect(
      normalizeThinkingConfig(
        { thinkingBudget: 8192, includeThoughts: true },
        { thinkingMode: "level" },
      ),
    ).toBeUndefined();
    expect(
      normalizeThinkingConfig(
        { thinkingBudget: 8192, includeThoughts: true },
        { thinkingMode: "none" },
      ),
    ).toBeUndefined();
  });
});

describe("enhanceGeminiErrorResponse extended", () => {
  it("matches OpenCode quota exceeded pattern while preserving Quota exhausted and details", () => {
    const body = {
      error: {
        message: "Daily quota depleted for model gemini-2.5-pro; resets in 4h",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "UNRELATED", domain: "other.example" },
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "QUOTA_EXHAUSTED",
            domain: "cloudaicompanion.googleapis.com",
          },
        ],
      },
    };

    const result = enhanceGeminiErrorResponse(body, 429);
    expect(result?.body?.error?.message).toContain("Quota exhausted");
    expect(result?.body?.error?.message?.toLowerCase()).toContain("quota exceeded");
    expect(result?.body?.error?.message).toContain("resets in 4h");
  });

  it("handles MODEL_CAPACITY_EXHAUSTED and case-insensitive retry messages", () => {
    const body = {
      error: {
        message: "No capacity available. please retry in 1500ms",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "MODEL_CAPACITY_EXHAUSTED",
            domain: "cloudcode-pa.googleapis.com",
          },
        ],
      },
    };

    const result = enhanceGeminiErrorResponse(body, 429);
    expect(result?.retryAfterMs).toBe(1500);
    expect(result?.body?.error?.message).toContain("Model capacity temporarily exhausted");
  });

  it("supports cloudaicompanion validation without duplicating learn-more as validation link", () => {
    const body = {
      error: {
        message: "validation required",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "VALIDATION_REQUIRED",
            domain: "cloudaicompanion.googleapis.com",
            metadata: {
              validation_link: "https://accounts.google.com/verify",
            },
          },
          {
            "@type": "type.googleapis.com/google.rpc.Help",
            links: [{ description: "Learn more", url: "https://support.google.com/help" }],
          },
        ],
      },
    };

    const result = enhanceGeminiErrorResponse(body, 403);
    expect(result?.body?.error?.message).toContain(
      "Complete validation: https://accounts.google.com/verify",
    );
    expect(result?.body?.error?.message).toContain("Learn more: https://support.google.com/help");
  });
});

describe("parsing helpers", () => {
  it("ignores nested arrays and reads both wrapped and top-level usageMetadata", () => {
    const parsed = parseGeminiApiBody(
      JSON.stringify([
        ["not-an-object"],
        {
          response: {
            usageMetadata: { totalTokenCount: 42, promptTokenCount: 10, candidatesTokenCount: 32 },
          },
        },
      ]),
    );
    expect(parsed).toBeDefined();
    expect(extractUsageMetadata(parsed!)).toEqual({
      totalTokenCount: 42,
      promptTokenCount: 10,
      candidatesTokenCount: 32,
      cachedContentTokenCount: undefined,
    });

    expect(
      extractUsageMetadata({
        usageMetadata: { totalTokenCount: 15, promptTokenCount: 5, candidatesTokenCount: 10 },
      }),
    ).toEqual({
      totalTokenCount: 15,
      promptTokenCount: 5,
      candidatesTokenCount: 10,
      cachedContentTokenCount: undefined,
    });
  });
});
