import { describe, expect, it } from "bun:test";

import { BodyLimitError, readBoundedText, readPrefix, readResponseText } from "./bounded";

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

  // A cloned body is one branch of a tee: its cancel() settles only once the other
  // branch is cancelled or the source ends, so giving up early must not await it.
  describe("on a cloned response whose other branch is not being read", () => {
    const pulled = (...chunks: string[]) => {
      let index = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[index++];
          if (chunk === undefined) controller.close();
          else controller.enqueue(new TextEncoder().encode(chunk));
        },
      });
    };
    const settled = (read: Promise<unknown>) =>
      Promise.race([
        read.then(
          (value) => value,
          (error: unknown) => error,
        ),
        new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
      ]);

    it("rejects a body that grows past the limit instead of hanging", async () => {
      const response = new Response(pulled("12345", "67890", "x"));
      expect(await settled(readResponseText(response.clone(), 8, "body"))).toBeInstanceOf(BodyLimitError);
      expect(await response.text()).toBe("1234567890x");
    });

    it("rejects a declared length above the limit instead of hanging", async () => {
      const response = new Response(pulled("tiny"), { headers: { "content-length": "999999" } });
      expect(await settled(readResponseText(response.clone(), 100, "body"))).toBeInstanceOf(BodyLimitError);
      expect(await response.text()).toBe("tiny");
    });

    it("returns a debug excerpt without waiting for the rest of the body", async () => {
      const response = new Response(pulled("12345", "67890", "x"));
      expect(await settled(readPrefix(response.clone().body, 4))).toBe("1234");
      expect(await response.text()).toBe("1234567890x");
    });
  });
});
