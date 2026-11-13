import { describe, expect, it } from "bun:test";

import { BodyLimitError, readBoundedText, readResponseText } from "./bounded";

const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

describe("bounded reads", () => {
  it("reads a body under the limit, multi-byte characters split across chunks included", async () => {
    const bytes = new TextEncoder().encode("é");
    const split = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 1));
        controller.enqueue(bytes.slice(1));
        controller.close();
      },
    });
    expect(await readBoundedText(split, 10, "body")).toBe("é");
    expect(await readBoundedText(null, 10, "body")).toBe("");
  });

  it("stops as soon as the body grows past the limit", async () => {
    await expect(readBoundedText(stream("12345", "67890", "x"), 8, "body")).rejects.toBeInstanceOf(BodyLimitError);
  });

  it("cancels a stalled body when the signal aborts", async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel: () => {
        cancelled = true;
      },
    });
    const read = readBoundedText(stalled, 100, "body", AbortSignal.timeout(20));
    await expect(read).rejects.toThrow();
    expect(cancelled).toBe(true);
  });

  it("refuses a declared length above the limit without reading", async () => {
    const response = new Response("tiny", { headers: { "content-length": "999999" } });
    await expect(readResponseText(response, 100, "body")).rejects.toBeInstanceOf(BodyLimitError);
  });
});
