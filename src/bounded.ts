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

/** Reads a body as UTF-8 text, cancelling it as soon as it grows past `limit` bytes. */
export async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
  label: string,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new BodyLimitError(label, limit);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}

/** Reads a Response body with both the declared and the actual size checked. */
export async function readResponseText(response: Response, limit: number, label: string): Promise<string> {
  const declared = contentLength(response.headers);
  if (declared !== undefined && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new BodyLimitError(label, limit);
  }
  return readBoundedText(response.body, limit, label);
}
