import { describe, expect, it } from "bun:test";

import { GEMINI_CODE_ASSIST_ENDPOINT } from "../constants";
import {
  isGenerativeLanguageRequest,
  prepareGeminiRequest,
  repairGeminiToolPairs,
  transformGeminiResponse,
} from ".";

describe("request helpers", () => {
  it("detects generativelanguage URLs", () => {
    expect(
      isGenerativeLanguageRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
      ),
    ).toBe(true);
    expect(isGenerativeLanguageRequest("https://example.com/foo")).toBe(false);
  });

  it("wraps requests for Gemini Code Assist streaming", () => {
    const input =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent";
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "should-be-removed",
        "x-goog-api-key": "should-also-be-removed",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        system_instruction: { parts: [{ text: "system" }] },
      }),
    };

    const result = prepareGeminiRequest(input, init, "token-123", "project-456");

    expect(result.streaming).toBe(true);
    expect(typeof result.request).toBe("string");
    expect(result.request).toBe(
      `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
    );

    const headers = new Headers(result.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer token-123");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBeNull();
    expect(headers.get("Accept")).toBe("text/event-stream");

    const parsed = JSON.parse(result.init.body as string) as Record<string, unknown>;
    expect(parsed.project).toBe("project-456");
    expect(parsed.model).toBe("gemini-3-flash-preview");
    expect(parsed.user_prompt_id).toBeTruthy();
    expect((parsed.request as Record<string, unknown>).session_id).toBeTruthy();
    expect((parsed.request as Record<string, unknown>).systemInstruction).toBeDefined();
    expect((parsed.request as Record<string, unknown>).system_instruction).toBeUndefined();
  });

  it("drops thought-only model parts from replayed history", () => {
    const input =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent";
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: "give me a joke" }] },
          {
            role: "model",
            parts: [{ text: "internal thought", thought: true }],
          },
          { role: "user", parts: [{ text: "well?" }] },
        ],
      }),
    };

    const result = prepareGeminiRequest(input, init, "token-123", "project-456");
    const parsed = JSON.parse(result.init.body as string) as Record<string, unknown>;
    const request = parsed.request as Record<string, unknown>;
    const contents = request.contents as Array<Record<string, unknown>>;

    expect(contents.length).toBe(2);
    expect(contents[0]?.role).toBe("user");
    expect(contents[1]?.role).toBe("user");
  });

  it("maps traceId to responseId for JSON responses", async () => {
    const response = new Response(
      JSON.stringify({
        traceId: "trace-123",
        response: {
          candidates: [],
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

    const transformed = await transformGeminiResponse(response, false);
    const parsed = (await transformed.json()) as Record<string, unknown>;
    expect(parsed.responseId).toBe("trace-123");
  });

  it("maps traceId to responseId for streaming payloads", async () => {
    const response = new Response(
      'data: {"traceId":"trace-456","response":{"candidates":[]}}\n\n',
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );

    const transformed = await transformGeminiResponse(response, true);
    const payload = await transformed.text();
    expect(payload).toContain('"responseId":"trace-456"');
    expect(payload).not.toContain('"traceId"');
  });

  it("injects model-level thinking defaults when request has no thinkingConfig", () => {
    const input =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      }),
    };

    const result = prepareGeminiRequest(input, init, "token-123", "project-456", {
      models: {
        "gemini-3-flash-preview": {
          thinkingLevel: "HIGH",
          includeThoughts: true,
        },
      },
      provider: {
        thinkingLevel: "low",
        includeThoughts: false,
      },
    });

    const parsed = JSON.parse(result.init.body as string) as Record<string, unknown>;
    const request = parsed.request as Record<string, unknown>;
    const generationConfig = request.generationConfig as Record<string, unknown>;
    expect(generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "high",
      includeThoughts: true,
    });
  });

  it("prefers request thinkingConfig over model/provider defaults", () => {
    const input =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: {
          thinkingConfig: {
            thinkingLevel: "low",
            includeThoughts: false,
          },
        },
      }),
    };

    const result = prepareGeminiRequest(input, init, "token-123", "project-456", {
      models: {
        "gemini-3-flash-preview": {
          thinkingLevel: "high",
          includeThoughts: true,
        },
      },
      provider: {
        thinkingLevel: "high",
        includeThoughts: true,
      },
    });

    const parsed = JSON.parse(result.init.body as string) as Record<string, unknown>;
    const request = parsed.request as Record<string, unknown>;
    const generationConfig = request.generationConfig as Record<string, unknown>;
    expect(generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "low",
      includeThoughts: false,
    });
  });

  it("moves root-level thinkingConfig into generationConfig", () => {
    const input =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        thinkingConfig: {
          thinkingLevel: "low",
          includeThoughts: true,
        },
      }),
    };

    const result = prepareGeminiRequest(input, init, "token-123", "project-456", {
      provider: {
        thinkingLevel: "high",
        includeThoughts: false,
      },
    });

    const parsed = JSON.parse(result.init.body as string) as Record<string, unknown>;
    const request = parsed.request as Record<string, unknown>;
    const generationConfig = request.generationConfig as Record<string, unknown>;
    expect(request.thinkingConfig).toBeUndefined();
    expect(generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "low",
      includeThoughts: true,
    });
  });

  it("checks exact hostname for isGenerativeLanguageRequest and inherits Request headers", () => {
    expect(
      isGenerativeLanguageRequest(
        "https://evil.example/?target=generativelanguage.googleapis.com",
      ),
    ).toBe(false);
    expect(
      isGenerativeLanguageRequest(
        new Request(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
        ),
      ),
    ).toBe(true);

    const noActionReq = new Request(
      "https://generativelanguage.googleapis.com/v1beta/models",
      { headers: { "x-api-key": "keep-on-non-action", "x-custom": "yes" } },
    );
    const noActionPrepared = prepareGeminiRequest(noActionReq, undefined, "tok", "proj");
    expect(new Headers(noActionPrepared.init.headers).get("x-api-key")).toBe("keep-on-non-action");

    const req = new Request(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
      { headers: { "x-trace-test": "inherited", "x-api-key": "strip-me" } },
    );
    const prepared = prepareGeminiRequest(
      req,
      { method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }) },
      "tok",
      "proj",
    );
    const outHeaders = new Headers(prepared.init.headers);
    expect(outHeaders.get("x-trace-test")).toBe("inherited");
    expect(outHeaders.get("x-api-key")).toBeNull();
  });

  it("preserves user_prompt_id on wrapped payloads and cleans extra_body aliases", () => {
    const input =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";
    const result = prepareGeminiRequest(
      input,
      {
        method: "POST",
        body: JSON.stringify({
          project: "project-wrapped",
          userPromptId: "prompt-keep-1",
          sessionId: "top-session-remove",
          request: {
            contents: [{ role: "user", parts: [{ text: "hi" }] }],
            session_id: "sess-1",
            extra_body: { sessionId: "extra-sess", promptId: "extra-prompt" },
          },
        }),
      },
      "tok",
      "project-ignored",
    );

    const parsed = JSON.parse(result.init.body as string) as Record<string, unknown>;
    const req = parsed.request as Record<string, unknown>;
    expect(parsed.user_prompt_id).toBe("prompt-keep-1");
    expect(parsed.userPromptId).toBeUndefined();
    expect(parsed.sessionId).toBeUndefined();
    expect(req.session_id).toBe("sess-1");
    expect(req.extra_body).toBeUndefined();
  });

  it("returns Google's thought signatures unchanged, on the part that carried them", () => {
    // Opaque values: base64 characters, and one that contains the documented dummy value.
    const first = "CpQCAdHtim9+/ZzA==";
    const last = "EoYBCoMBAb4+9vt/skip_thought_signature_validator==";
    const result = prepareGeminiRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
      {
        method: "POST",
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "run both" }] },
            {
              role: "model",
              parts: [
                { functionCall: { name: "bash", args: {} }, thoughtSignature: first },
                { functionCall: { name: "read", args: {} } },
              ],
            },
            {
              role: "user",
              parts: [
                { functionResponse: { name: "bash", response: {} } },
                { functionResponse: { name: "read", response: {} } },
              ],
            },
            // A step the API did not sign gets the dummy value Google documents, and only that step.
            { role: "model", parts: [{ functionCall: { name: "bash", args: {} } }] },
            { role: "user", parts: [{ functionResponse: { name: "bash", response: {} } }] },
            { role: "model", parts: [{ text: "done" }, { text: "", thoughtSignature: last }] },
            { role: "user", parts: [{ text: "thanks" }] },
          ],
        }),
      },
      "tok",
      "proj",
    );
    const contents = (JSON.parse(result.init.body as string).request as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    }).contents;
    const signatures = contents.map((content) => content.parts.map((part) => part.thoughtSignature ?? null));
    expect(signatures).toEqual([
      [null],
      [first, null],
      [null, null],
      ["skip_thought_signature_validator"],
      [null],
      [null, last],
      [null],
    ]);
  });

  it("rescues thoughtSignature when stripping thought parts and avoids overwriting with skip fallback", () => {
    const input =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";
    const result = prepareGeminiRequest(
      input,
      {
        method: "POST",
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: "run tool" }] },
            {
              role: "model",
              parts: [
                { text: "internal", thought: true, thoughtSignature: "real-sig-999" },
                { functionCall: { name: "bash", args: { cmd: "ls" } } },
                { functionCall: { name: "read", args: { path: "a" } } },
              ],
            },
            {
              role: "user",
              parts: [
                { functionResponse: { name: "bash", response: { ok: true } } },
                { functionResponse: { name: "read", response: { ok: true } } },
              ],
            },
          ],
        }),
      },
      "tok",
      "proj",
    );

    const parsed = JSON.parse(result.init.body as string) as Record<string, unknown>;
    const contents = (parsed.request as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents;
    const modelParts = contents[1]!.parts;
    expect(modelParts.length).toBe(2);
    expect(modelParts[0]?.thoughtSignature).toBe("real-sig-999");
    expect(modelParts[1]?.thoughtSignature).toBeUndefined();
    expect((modelParts[0]?.functionCall as { id?: string }).id).toBeTruthy();
  });

  it("applies model-aware tool IDs, thought signatures, and thinking mode filtering", () => {
    const baseContents = [
      { role: "user", parts: [{ text: "hi" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "echo", args: {} } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { name: "echo", response: {} } }],
      },
    ];

    const gemini25 = prepareGeminiRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
      {
        method: "POST",
        body: JSON.stringify({
          contents: baseContents,
          generationConfig: {
            thinkingConfig: { thinkingBudget: -1, thinkingLevel: "high", includeThoughts: true },
          },
        }),
      },
      "tok",
      "proj",
    );
    const parsed25 = JSON.parse(gemini25.init.body as string) as {
      request: {
        contents: Array<{ parts: Array<Record<string, unknown>> }>;
        generationConfig: { thinkingConfig?: Record<string, unknown> };
      };
    };
    const modelPart25 = parsed25.request.contents[1]!.parts[0]!;
    expect(modelPart25.thoughtSignature).toBeUndefined();
    expect((modelPart25.functionCall as { id?: string }).id).toBeUndefined();
    expect(parsed25.request.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: -1,
      includeThoughts: true,
    });

    const gemini20 = prepareGeminiRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          generationConfig: {
            thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
          },
        }),
      },
      "tok",
      "proj",
    );
    const parsed20 = JSON.parse(gemini20.init.body as string) as {
      request: { generationConfig: { thinkingConfig?: unknown } };
    };
    expect(parsed20.request.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("merges provider and model thinking defaults without dropping provider fields", () => {
    const result = prepareGeminiRequest(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
      {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
        }),
      },
      "tok",
      "proj",
      {
        provider: { includeThoughts: true, thinkingLevel: "low" },
        models: { "gemini-3-flash-preview": { thinkingLevel: "medium" } },
      },
    );
    const parsed = JSON.parse(result.init.body as string) as {
      request: { generationConfig: { thinkingConfig: Record<string, unknown> } };
    };
    expect(parsed.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "medium",
      includeThoughts: true,
    });
  });

  it("losslessly repairs orphan functionCalls and functionResponses", () => {
    const repaired = repairGeminiToolPairs(
      [
        {
          role: "user",
          parts: [
            { functionResponse: { name: "orphan_before", response: {} } },
            { text: "hello" },
          ],
        },
        {
          role: "model",
          parts: [
            {
              functionCall: { id: "fc-1", name: "bash", args: {} },
              thoughtSignature: "keep-sig",
            },
          ],
        },
        {
          role: "user",
          parts: [{ text: "never mind, continue" }],
        },
      ],
      "gemini-3-flash-preview",
    ) as Array<{ role: string; parts: Array<Record<string, unknown>> }>;

    expect(repaired.length).toBe(4);
    expect(repaired[0]!.parts).toEqual([{ text: "hello" }]);
    expect(repaired[1]!.parts[0]!.thoughtSignature).toBe("keep-sig");
    expect((repaired[2]!.parts[0]!.functionResponse as { id?: string; name: string }).id).toBe(
      "fc-1",
    );
    expect((repaired[2]!.parts[0]!.functionResponse as { name: string }).name).toBe("bash");
    expect(repaired[3]!.parts).toEqual([{ text: "never mind, continue" }]);
  });

  it("never pairs a tool result with a different call id of the same tool", () => {
    const repaired = repairGeminiToolPairs(
      [
        { role: "model", parts: [{ functionCall: { id: "call-A", name: "read", args: {} } }] },
        {
          role: "user",
          parts: [{ functionResponse: { id: "call-B", name: "read", response: { output: "B" } } }],
        },
      ],
      "gemini-3-flash-preview",
    ) as Array<{ role: string; parts: Array<{ functionResponse: Record<string, unknown> }> }>;

    expect(repaired.length).toBe(2);
    expect(repaired[1]!.parts).toEqual([
      {
        functionResponse: {
          id: "call-A",
          name: "read",
          response: { error: "Tool call was interrupted before receiving a response." },
        },
      },
    ]);
  });

  it("serializes enhanced 429 JSON and SSE error responses and usage headers without cache", async () => {
    const jsonErr = new Response(
      JSON.stringify({
        error: {
          message: "rate limited",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "RATE_LIMIT_EXCEEDED",
              domain: "cloudcode-pa.googleapis.com",
            },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" },
          ],
        },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "content-length": "999",
          "content-encoding": "gzip",
        },
      },
    );

    const transformedErr = await transformGeminiResponse(jsonErr, false);
    expect(transformedErr.headers.get("content-length")).toBeNull();
    expect(transformedErr.headers.get("content-encoding")).toBeNull();
    expect(transformedErr.headers.get("Retry-After")).toBe("3");
    expect(transformedErr.headers.get("retry-after-ms")).toBe("3000");
    const errPayload = (await transformedErr.json()) as { error: { message: string } };
    expect(errPayload.error.message).toContain("Rate limit exceeded");

    const sseErr = new Response(
      'data: {"error":{"message":"quota exhausted","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"QUOTA_EXHAUSTED","domain":"cloudcode-pa.googleapis.com"}]}}\n\n',
      {
        status: 429,
        headers: { "content-type": "text/event-stream" },
      },
    );
    const transformedSseErr = await transformGeminiResponse(sseErr, true);
    expect(transformedSseErr.headers.get("content-type")).toContain("application/json");
    const sseErrBody = (await transformedSseErr.json()) as { error: { message: string } };
    expect(sseErrBody.error.message).toContain("Quota exhausted");

    const okWithUsage = new Response(
      JSON.stringify({
        response: {
          candidates: [],
          usageMetadata: { totalTokenCount: 25, promptTokenCount: 10, candidatesTokenCount: 15 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const transformedOk = await transformGeminiResponse(okWithUsage, false);
    expect(transformedOk.headers.get("x-gemini-total-token-count")).toBe("25");
    expect(transformedOk.headers.get("x-gemini-prompt-token-count")).toBe("10");
    expect(transformedOk.headers.get("x-gemini-candidates-token-count")).toBe("15");
    expect(transformedOk.headers.get("x-gemini-cached-content-token-count")).toBeNull();
  });

  it("handles chunked multi-line SSE payloads cleanly", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'event: message\ndata: {"traceId":"trace-split",',
      '"response":{"candidates":[{"index":0}]}}\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const transformed = await transformGeminiResponse(response, true);
    const payload = await transformed.text();
    expect(payload).toContain("event: message");
    expect(payload).toContain('"responseId":"trace-split"');
    expect(payload).not.toContain('"traceId"');
  });
});
