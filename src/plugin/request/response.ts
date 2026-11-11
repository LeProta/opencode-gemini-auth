import { logGeminiDebugResponse, type GeminiDebugContext } from "../debug";
import {
  enhanceGeminiErrorResponse,
  extractUsageMetadata,
  parseGeminiApiBody,
  rewriteGeminiPreviewAccessError,
  type GeminiApiBody,
} from "../request-helpers";
import { injectResponseIdFromTrace, isRecord } from "./shared";

function parseGeminiSseBody(rawText: string): GeminiApiBody | null {
  const dataLines: string[] = [];
  let lastParsed: GeminiApiBody | null = null;

  const flush = (): void => {
    if (dataLines.length === 0) {
      return;
    }
    const payload = dataLines.join("\n").trim();
    dataLines.length = 0;
    if (!payload || payload === "[DONE]") {
      return;
    }
    const parsed = parseGeminiApiBody(payload);
    if (parsed) {
      lastParsed = parsed;
    }
  };

  for (const rawLine of rawText.split(/\r?\n/)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith("data:")) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  flush();

  return lastParsed;
}

/**
 * Normalizes Gemini responses, preserving request metadata and usage counters.
 */
export async function transformGeminiResponse(
  response: Response,
  streaming: boolean,
  debugContext?: GeminiDebugContext | null,
  requestedModel?: string,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");

  if (!isJsonResponse && !isEventStreamResponse) {
    logGeminiDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)",
    });
    return response;
  }

  let bufferedText: string | null = null;
  try {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");

    if (streaming && response.ok && isEventStreamResponse && response.body) {
      logGeminiDebugResponse(debugContext, response, {
        note: "Streaming SSE payload (body omitted)",
        headersOverride: headers,
      });

      return new Response(transformStreamingPayloadStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    const text = await response.text();
    bufferedText = text;
    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    const parsedJson = parseGeminiApiBody(text);
    const parsedFromSse =
      !parsedJson && isEventStreamResponse ? parseGeminiSseBody(text) : null;
    const parsed = parsedJson ?? parsedFromSse;

    const enhanced =
      !response.ok && parsed ? enhanceGeminiErrorResponse(parsed, response.status) : null;
    if (enhanced?.retryAfterMs) {
      const retryAfterSec = Math.ceil(enhanced.retryAfterMs / 1000).toString();
      headers.set("Retry-After", retryAfterSec);
      headers.set("retry-after-ms", String(enhanced.retryAfterMs));
    }

    const previewPatched = parsed
      ? rewriteGeminiPreviewAccessError(enhanced?.body ?? parsed, response.status, requestedModel)
      : null;

    const effectiveBodyRaw = previewPatched ?? enhanced?.body ?? parsed ?? undefined;
    const effectiveBody =
      effectiveBodyRaw && isRecord(effectiveBodyRaw)
        ? injectResponseIdFromTrace(effectiveBodyRaw)
        : effectiveBodyRaw;

    attachUsageHeaders(headers, effectiveBody);

    logGeminiDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (buffered)" : undefined,
      headersOverride: headers,
    });

    if (!parsed) {
      return new Response(text, init);
    }

    if (effectiveBody && isRecord(effectiveBody) && "response" in effectiveBody) {
      if (isEventStreamResponse) {
        headers.set("content-type", "application/json; charset=utf-8");
      }
      return new Response(JSON.stringify(effectiveBody.response), init);
    }

    const wasModified =
      Boolean(enhanced?.body) ||
      Boolean(previewPatched) ||
      (effectiveBody !== undefined && effectiveBody !== parsed) ||
      Boolean(parsedFromSse);

    if (effectiveBody && wasModified) {
      if (isEventStreamResponse) {
        headers.set("content-type", "application/json; charset=utf-8");
      }
      return new Response(JSON.stringify(effectiveBody), init);
    }

    return new Response(text, init);
  } catch (error) {
    logGeminiDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Gemini response",
    });
    console.error("Failed to transform Gemini response:", error);
    if (bufferedText !== null) {
      const fallbackHeaders = new Headers(response.headers);
      fallbackHeaders.delete("content-length");
      fallbackHeaders.delete("content-encoding");
      return new Response(bufferedText, {
        status: response.status,
        statusText: response.statusText,
        headers: fallbackHeaders,
      });
    }
    return response;
  }
}

function attachUsageHeaders(headers: Headers, effectiveBody: unknown): void {
  if (!isRecord(effectiveBody)) {
    return;
  }
  const usage = extractUsageMetadata(effectiveBody as GeminiApiBody);
  if (!usage) {
    return;
  }

  if (usage.cachedContentTokenCount !== undefined) {
    headers.set("x-gemini-cached-content-token-count", String(usage.cachedContentTokenCount));
  }
  if (usage.totalTokenCount !== undefined) {
    headers.set("x-gemini-total-token-count", String(usage.totalTokenCount));
  }
  if (usage.promptTokenCount !== undefined) {
    headers.set("x-gemini-prompt-token-count", String(usage.promptTokenCount));
  }
  if (usage.candidatesTokenCount !== undefined) {
    headers.set("x-gemini-candidates-token-count", String(usage.candidatesTokenCount));
  }
}

function transformStreamingPayloadStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let pendingDataLines: string[] = [];
  let pendingOtherLines: string[] = [];
  let pendingLineEnding = "\n";
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const flushEvent = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    trailingSeparator: string,
  ): void => {
    const hasData = pendingDataLines.length > 0;
    const hasOther = pendingOtherLines.length > 0;
    if (!hasData && !hasOther) {
      if (trailingSeparator) {
        controller.enqueue(encoder.encode(trailingSeparator));
      }
      return;
    }

    const outputLines: string[] = [...pendingOtherLines];
    if (hasData) {
      const joinedData = pendingDataLines.join("\n").trim();
      outputLines.push(transformStreamingDataPayload(joinedData));
    }

    pendingDataLines = [];
    pendingOtherLines = [];
    controller.enqueue(encoder.encode(`${outputLines.join(pendingLineEnding)}${trailingSeparator}`));
  };

  const processLine = (
    rawLine: string,
    lineEnding: string,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void => {
    if (rawLine === "") {
      const separator = lineEnding ? `${pendingLineEnding}${lineEnding}` : pendingLineEnding;
      flushEvent(controller, separator);
      pendingLineEnding = "\n";
      return;
    }
    if (lineEnding) {
      pendingLineEnding = lineEnding;
    } else if (pendingDataLines.length === 0 && pendingOtherLines.length === 0) {
      pendingLineEnding = "";
    }
    if (rawLine.startsWith("data:")) {
      pendingDataLines.push(rawLine.slice(5).trimStart());
      return;
    }
    pendingOtherLines.push(rawLine);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = stream.getReader();
      const pump = (): void => {
        reader!
          .read()
          .then(({ done, value }) => {
            if (done) {
              buffer += decoder.decode();
              if (buffer.length > 0) {
                const rawLine = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
                buffer = "";
                processLine(rawLine, "", controller);
              }
              flushEvent(controller, pendingLineEnding);
              controller.close();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex !== -1) {
              const line = buffer.slice(0, newlineIndex);
              buffer = buffer.slice(newlineIndex + 1);
              const hasCr = line.endsWith("\r");
              const rawLine = hasCr ? line.slice(0, -1) : line;
              processLine(rawLine, hasCr ? "\r\n" : "\n", controller);
              newlineIndex = buffer.indexOf("\n");
            }
            pump();
          })
          .catch((error) => {
            controller.error(error);
          });
      };
      pump();
    },
    cancel(reason) {
      if (reader) {
        reader.cancel(reason).catch(() => {});
      }
    },
  });
}

function transformStreamingDataPayload(json: string): string {
  if (!json || json === "[DONE]") {
    return json ? `data: ${json}` : "data:";
  }

  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) {
      return `data: ${json}`;
    }
    const patched = injectResponseIdFromTrace(parsed);
    if (patched.response !== undefined) {
      return `data: ${JSON.stringify(patched.response)}`;
    }
    return `data: ${JSON.stringify(patched)}`;
  } catch {
    return `data: ${json}`;
  }
}
