import { describe, expect, it } from "bun:test";

import { readPrefix } from "./bounded";
import { prepareGeminiRequest } from "./request";
import { isTrustedGoogleUrl, toAntigravityRequest } from "./transform";

describe("outgoing Antigravity request safety", () => {
  const input = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent";
  const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });

  it("drops headers that described the caller's body and refuses redirects", () => {
    const prepared = prepareGeminiRequest(
      input,
      { method: "POST", headers: { "content-length": String(body.length), "content-encoding": "gzip" }, body },
      "tok",
      "proj-1",
    );
    const { init } = toAntigravityRequest(String(prepared.request), prepared.init, "proj-1", "2.31.2");
    const headers = new Headers(init.headers);
    expect(String(init.body).length).toBeGreaterThan(body.length);
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("content-encoding")).toBeNull();
    expect(init.redirect).toBe("error");
  });

  it("sends the headers of the client profile and nothing the host added", () => {
    for (const action of ["generateContent", "streamGenerateContent"]) {
      const prepared = prepareGeminiRequest(
        input.replace("generateContent", action),
        {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            "user-agent": "opencode/2.2.7 ai-sdk/google/3.0.0",
            "x-goog-api-client": "genai-js/1.0.0",
            "x-goog-api-key": "synthetic-key",
            "x-goog-user-project": "someone-else",
            "x-opencode-session": "session-1",
            cookie: "a=b",
          },
          body,
        },
        "tok",
        "proj-1",
      );
      const { init } = toAntigravityRequest(String(prepared.request), prepared.init, "proj-1", "2.31.2");
      const sent: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        sent[name] = value;
      });
      expect(sent).toEqual({
        authorization: "Bearer tok",
        "content-type": "application/json",
        "user-agent": "antigravity/hub/2.31.2 (aidev_client; os_type=darwin; arch=arm64)",
        ...(action === "streamGenerateContent" ? { accept: "text/event-stream" } : {}),
      });
    }
  });

  it("builds the envelope itself: a caller cannot set its fields or turn on paid credits", () => {
    const wrapped = JSON.stringify({
      project: "caller-project",
      model: "caller-model",
      requestId: "caller-id",
      requestType: "web_search",
      userAgent: "caller-agent",
      user_prompt_id: "caller-prompt",
      enabledCreditTypes: ["GOOGLE_ONE_AI"],
      request: JSON.parse(body),
    });
    const prepared = prepareGeminiRequest(input, { method: "POST", body: wrapped }, "tok", "proj-1");
    const { init } = toAntigravityRequest(String(prepared.request), prepared.init, "proj-1", "2.31.2");
    const envelope = JSON.parse(String(init.body));
    // Fields of google.internal.cloud.code.v1internal.GenerateContentRequest, and only the ones the profile sends.
    expect(Object.keys(envelope).sort()).toEqual(["model", "project", "request", "requestId", "requestType", "userAgent"]);
    expect(envelope).toMatchObject({ model: "gemini-3-flash", project: "proj-1", requestType: "agent", userAgent: "antigravity" });
    expect(envelope.requestId).toMatch(/^agent-[0-9a-f-]{36}$/);
  });

  it("only trusts the two Cloud Code origins", () => {
    expect(isTrustedGoogleUrl("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent")).toBe(true);
    expect(isTrustedGoogleUrl("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")).toBe(true);
    expect(isTrustedGoogleUrl("https://evil.example/v1internal:generateContent")).toBe(false);
    expect(isTrustedGoogleUrl("https://user:pw@daily-cloudcode-pa.googleapis.com/")).toBe(false);
    expect(isTrustedGoogleUrl("http://daily-cloudcode-pa.googleapis.com/")).toBe(false);
  });

  it("reads only a bounded debug excerpt and cancels the rest", async () => {
    let cancelled = false;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(1000)));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect((await readPrefix(stream, 2500)).length).toBe(2500);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });
});
