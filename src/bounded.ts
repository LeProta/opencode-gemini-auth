/** Size-limited body reads, same contract as the Anthropic plugin's bounded.ts. */
export class BodyLimitError extends Error {
  constructor(label: string, limit: number) {
    super(`${label} exceeds ${limit} byte limit`);
    this.name = "BodyLimitError";
  }
}

export function contentLength(headers: Headers): number | undefined {
  const raw = headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/** Reads a body as UTF-8 text, cancelling it as soon as it grows past `limit` bytes or `signal` aborts. */
export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!body) return "";
  signal?.throwIfAborted();
  const reader = body.getReader();
  const onAbort = () => void reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        // Not awaited (here and below): on a cloned body, one branch of a tee, cancel()
        // settles only once the other branch is cancelled or the source ends.
        void reader.cancel().catch(() => {});
        throw new BodyLimitError(label, limit);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

/** First `maxBytes` of a body (debug excerpts); the rest is cancelled, never buffered. */
export async function readPrefix(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, maxBytes));
}

/** Reads a Response body with both the declared and the actual size checked. */
export async function readResponseText(
  response: Response,
  limit: number,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  const declared = contentLength(response.headers);
  if (declared !== undefined && declared > limit) {
    void response.body?.cancel().catch(() => {});
    throw new BodyLimitError(label, limit);
  }
  return readBoundedText(response.body, limit, label, signal);
}
