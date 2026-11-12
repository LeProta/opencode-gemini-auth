import { describe, expect, it } from "bun:test";

import { prepareGeminiRequest } from "../plugin/request";
import { isPublishableModelId, toAntigravityRequest } from "./client";

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
    expect(envelope.request.generationConfig).toEqual({ temperature: 0.5 });
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
