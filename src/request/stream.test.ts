import { describe, expect, it } from "bun:test";

import { MAX_SSE_LINE_CHARS, transformStreamingPayloadStream } from "./response";

const encoder = new TextEncoder();

/** A source that counts how often it is pulled and whether it was cancelled. */
function countingSource(chunks: string[]) {
  const state = { pulls: 0, cancelled: false };
  let index = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls += 1;
        if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++]!));
        else controller.close();
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

const event = (text: string) => `data: {"response":{"candidates":[{"content":{"parts":[{"text":"${text}"}]}}]}}\n\n`;

describe("streaming SSE transform", () => {
  it("unwraps the Antigravity envelope event by event", async () => {
    const { stream } = countingSource([event("a"), event("b")]);
    const text = await new Response(transformStreamingPayloadStream(stream)).text();
    // The last "\n" is the end-of-stream separator the transform has always emitted.
    expect(text).toBe(
      'data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\n\ndata: {"candidates":[{"content":{"parts":[{"text":"b"}]}}]}\n\n\n',
    );
  });

  it("hands Google's thought signatures to OpenCode unchanged, even split across chunks", async () => {
    const signature = "CpQCAdHtim9+/ZzA\\u003d\\u003d"; // "=" escaped the way Google's JSON does
    const parts = `[{"functionCall":{"name":"bash","args":{}},"thoughtSignature":"${signature}"},{"text":"","thoughtSignature":"${signature}"}]`;
    const sse = `data: {"response":{"candidates":[{"content":{"role":"model","parts":${parts}}}]},"traceId":"t1"}\n\n`;
    const cut = sse.indexOf("Htim9");
    const { stream } = countingSource([sse.slice(0, cut), sse.slice(cut)]);
    const text = await new Response(transformStreamingPayloadStream(stream)).text();
    const received = JSON.parse(text.slice("data: ".length).trim()).candidates[0].content.parts;
    expect(received).toEqual(JSON.parse(parts));
    expect(received[0].thoughtSignature).toBe("CpQCAdHtim9+/ZzA==");
  });

  it("does not drain the upstream while nobody reads the output", async () => {
    const { stream, state } = countingSource(Array.from({ length: 100 }, (_, i) => event(String(i))));
    transformStreamingPayloadStream(stream);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.pulls).toBeLessThan(5);
  });

  it("forwards cancellation to the upstream", async () => {
    const { stream, state } = countingSource([event("a"), event("b"), event("c")]);
    const reader = transformStreamingPayloadStream(stream).getReader();
    await reader.read();
    await reader.cancel("user stopped");
    await new Promise((resolve) => setTimeout(resolve, 10)); // pipeThrough cancels the source asynchronously
    expect(state.cancelled).toBe(true);
  });

  it("errors on a line that never ends instead of buffering it forever", async () => {
    const huge = "data: " + "x".repeat(MAX_SSE_LINE_CHARS + 10);
    const { stream } = countingSource([huge]);
    await expect(new Response(transformStreamingPayloadStream(stream)).text()).rejects.toThrow("SSE line exceeds");
  });
});

describe("transformGeminiResponse size limits", () => {
  it("fails visibly on an error body above the error limit instead of buffering it", async () => {
    const { MAX_GEMINI_ERROR_BYTES, transformGeminiResponse } = await import("./response");
    const { BodyLimitError } = await import("../bounded");
    const big = new Response(`{"error":{"message":"${"x".repeat(MAX_GEMINI_ERROR_BYTES)}"}}`, {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    await expect(transformGeminiResponse(big, false)).rejects.toBeInstanceOf(BodyLimitError);
  });

  it("still reads a normal error body", async () => {
    const { transformGeminiResponse } = await import("./response");
    const small = new Response(`{"error":{"code":500,"message":"boom"}}`, {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    const out = await transformGeminiResponse(small, false);
    expect(out.status).toBe(500);
    expect(await out.text()).toContain("boom");
  });
});
