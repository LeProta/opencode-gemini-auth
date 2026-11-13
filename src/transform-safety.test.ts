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
