import { describe, expect, it } from "bun:test";

import { prepareGeminiRequest } from "./request";
import { isPublishableModelId } from "./models";
import { formatQuotaSummary } from "./quota";
import { toAntigravityRequest, withThoughts } from "./transform";

describe("toAntigravityRequest", () => {
  const input =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-high:streamGenerateContent?alt=sse";
  const body = JSON.stringify({
    contents: [
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ text: "hi" }] },
    ],
    safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }],
    generationConfig: { maxOutputTokens: 1000, temperature: 0.5 },
  });

  const rewrite = (text: string) => {
    const prepared = prepareGeminiRequest(input, { method: "POST", body: text }, "tok", "proj-1");
    return toAntigravityRequest(String(prepared.request), prepared.init, "proj-1", "2.29.0");
  };

  it("targets the daily Antigravity surface with the bridge envelope", () => {
    const { url, init } = rewrite(body);
    expect(url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");

    const headers = new Headers(init.headers);
    expect(headers.get("User-Agent")).toBe(
      "antigravity/hub/2.29.0 (aidev_client; os_type=darwin; arch=arm64; cl=1013060670)",
    );
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.has("x-activity-request-id")).toBe(false);

    const envelope = JSON.parse(String(init.body));
    expect(envelope.model).toBe("gemini-3.1-pro-high");
    expect(envelope.project).toBe("proj-1");
    expect(envelope.requestType).toBe("agent");
    expect(envelope.userAgent).toBe("antigravity");
    expect(envelope.requestId).toMatch(/^agent-[0-9a-f-]{36}$/);
    expect(envelope.request.safetySettings).toBeUndefined();
    expect(envelope.request.session_id).toBeUndefined();
    // CLIProxyAPI drops maxOutputTokens for every non-Claude model
    // and the reasoning text is requested so OpenCode can show it
    expect(envelope.request.generationConfig).toEqual({ temperature: 0.5, thinkingConfig: { includeThoughts: true, thinkingLevel: "high" } });
    expect(envelope.request.contents[0].parts[0].text).toBe("hello");
  });

  it("keeps one sessionId per conversation", () => {
    const first = JSON.parse(String(rewrite(body).init.body));
    const second = JSON.parse(String(rewrite(body).init.body));
    expect(first.request.sessionId).toMatch(/^-\d+$/);
    expect(second.request.sessionId).toBe(first.request.sessionId);
    expect(second.requestId).not.toBe(first.requestId);
  });
});

describe("isPublishableModelId", () => {
  it("drops internal routing ids", () => {
    expect(isPublishableModelId("gemini-3.1-pro-high")).toBe(true);
    expect(isPublishableModelId("chat_20706")).toBe(false);
    expect(isPublishableModelId("tab_flash_lite_preview")).toBe(false);
  });
});

describe("withThoughts", () => {
  const tc = (model: string, request: Record<string, any> = {}) => withThoughts(model, request).generationConfig?.thinkingConfig;

  it("pairs includeThoughts with a level or budget, like CLIProxyAPI", () => {
    expect(tc("gemini-3.8-flash-low")).toEqual({ includeThoughts: true, thinkingLevel: "low" });
    expect(tc("gemini-3-flash")).toEqual({ includeThoughts: true, thinkingLevel: "high" });
    expect(tc("gemini-2.5-flash-thinking")).toEqual({ includeThoughts: true, thinkingBudget: -1 });
  });

  it("leaves image models and explicit opt-outs alone", () => {
    expect(tc("gemini-3.1-flash-image")).toBeUndefined();
    expect(tc("gemini-3-flash", { generationConfig: { thinkingConfig: { includeThoughts: false } } })).toEqual({
      includeThoughts: false,
    });
  });
});

describe("formatQuotaSummary", () => {
  it("prints each pool and window with what is left and the reset", () => {
    const now = Date.UTC(2026, 10, 12, 12);
    const text = formatQuotaSummary(
      {
        description: "",
        groups: [
          {
            name: "Gemini",
            description: "",
            buckets: [
              { name: "Weekly limit", window: "weekly", remaining: 0.42, resetAt: now + 3 * 86_400_000, disabled: false },
              { name: "", window: "5h", remaining: null, resetAt: now + 90 * 60_000, disabled: true },
            ],
          },
        ],
      },
      now,
    );
    expect(text).toContain("- Weekly limit: 42% left, resets in 3 days");
    expect(text).toContain("- 5h: inactive, resets in 1 h 30 min");
  });
});
