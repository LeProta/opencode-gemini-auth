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
