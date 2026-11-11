import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import {
  computeGeminiRetryDecision,
  fetchWithRetry,
  recordRetryCooldown,
  resolveRetryDelayMs,
  retryInternals,
  waitForRetryCooldown,
} from "./retry";
import { classifyQuotaResponse } from "./retry/quota";

const originalSetTimeout = globalThis.setTimeout;
const scheduledDelays: number[] = [];

function makeQuota429(
  reason: "RATE_LIMIT_EXCEEDED" | "QUOTA_EXHAUSTED" | "MODEL_CAPACITY_EXHAUSTED",
  retryDelay?: string,
  wrappedAsArray = false,
): Response {
  const details: Record<string, unknown>[] = [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      domain: "cloudcode-pa.googleapis.com",
    },
  ];
  if (retryDelay) {
    details.push({
      "@type": "type.googleapis.com/google.rpc.RetryInfo",
      retryDelay,
    });
  }
  const payload = {
    error: {
      message: "rate limited",
      details,
    },
  };
  return new Response(
    JSON.stringify(
      wrappedAsArray
        ? [payload]
        : payload,
    ),
    {
      status: 429,
      headers: { "content-type": "application/json" },
    },
  );
}

function makeQuota429WithMessage(
  reason: "RATE_LIMIT_EXCEEDED" | "QUOTA_EXHAUSTED" | "MODEL_CAPACITY_EXHAUSTED",
  message: string,
  wrappedAsArray = false,
): Response {
  const details: Record<string, unknown>[] = [
    {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      domain: "cloudcode-pa.googleapis.com",
    },
  ];
  const payload = {
    error: {
      message,
      details,
    },
  };
  return new Response(
    JSON.stringify(
      wrappedAsArray
        ? [payload]
        : payload,
    ),
    {
      status: 429,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("fetchWithRetry", () => {
  beforeEach(() => {
    mock.restore();
    scheduledDelays.length = 0;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: (...args: any[]) => void,
      delay?: number | undefined,
    ) => {
      scheduledDelays.push(typeof delay === "number" ? delay : 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
  });

  afterEach(() => {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
  });

  it("retries transient network errors", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        const err = new Error("socket reset") as Error & { code?: string };
        err.code = "ECONNRESET";
        throw err;
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("retries rate-limit responses with retry hints", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return makeQuota429("RATE_LIMIT_EXCEEDED", "1500ms");
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("does not retry terminal quota exhaustion", async () => {
    const fetchMock = mock(async () => makeQuota429("QUOTA_EXHAUSTED"));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(429);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("classifies cloudaicompanion quota errors", async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          message: "quota exhausted",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "QUOTA_EXHAUSTED",
              domain: "cloudaicompanion.googleapis.com",
            },
          ],
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );

    await expect(classifyQuotaResponse(response)).resolves.toEqual({
      terminal: true,
      reason: "QUOTA_EXHAUSTED",
    });
  });

  it("fails fast on model capacity exhaustion when no retry hint is provided", async () => {
    const fetchMock = mock(async () => makeQuota429("MODEL_CAPACITY_EXHAUSTED"));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(429);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("fails fast on array-wrapped model capacity exhaustion payload", async () => {
    const fetchMock = mock(async () =>
      makeQuota429WithMessage(
        "MODEL_CAPACITY_EXHAUSTED",
        "No capacity available for model gemini-3-flash-preview on the server",
        true,
      ),
    );
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(429);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("applies cooldown after terminal model capacity exhaustion", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return makeQuota429WithMessage(
          "MODEL_CAPACITY_EXHAUSTED",
          "No capacity available for model gemini-3-flash-preview on the server",
          true,
        );
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const firstResponse = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ project: "project-1", model: "gemini-3-flash-preview" }),
    });
    const secondResponse = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ project: "project-1", model: "gemini-3-flash-preview" }),
    });

    expect(firstResponse.status).toBe(429);
    expect(secondResponse.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(scheduledDelays).toContain(8000);
  });

  it("retries model capacity exhaustion when server provides RetryInfo", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return makeQuota429("MODEL_CAPACITY_EXHAUSTED", "500ms");
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("retries immediately when server returns Retry-After: 0", async () => {
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("applies cooldown across requests to avoid repeated initial 429s", async () => {
    const fetchMock = mock(async () => {
      const callNumber = fetchMock.mock.calls.length;
      if (callNumber === 1) {
        return makeQuota429("RATE_LIMIT_EXCEEDED", "1500ms");
      }
      if (callNumber === 3 && scheduledDelays.length < 2) {
        return makeQuota429("RATE_LIMIT_EXCEEDED", "1500ms");
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const firstResponse = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ project: "project-1", model: "gemini-2.5-flash" }),
    });
    const secondResponse = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ project: "project-1", model: "gemini-2.5-flash" }),
    });

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(3);
    expect(scheduledDelays.length).toBe(2);
    expect(scheduledDelays[0]).toBe(1500);
    expect(scheduledDelays[1]).toBeGreaterThan(0);
    expect(scheduledDelays[1]).toBeLessThanOrEqual(1500);
  });
});

describe("retryInternals", () => {
  it("parses retry delays from both ms and s notation", () => {
    expect(retryInternals.parseRetryDelayValue("1200ms")).toBe(1200);
    expect(retryInternals.parseRetryDelayValue("1.5s")).toBe(1500);
    expect(retryInternals.parseRetryDelayFromMessage("Please retry in 2s")).toBe(2000);
  });
});

describe("retry extensions", () => {
  const originalFetch = globalThis.fetch;
  const previousMaxRetryEnv = process.env.OPENCODE_GEMINI_MAX_RETRY_MS;

  beforeEach(() => {
    mock.restore();
    scheduledDelays.length = 0;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
      fn: (...args: any[]) => void,
      delay?: number | undefined,
    ) => {
      scheduledDelays.push(typeof delay === "number" ? delay : 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
  });

  afterEach(() => {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = originalSetTimeout;
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    if (previousMaxRetryEnv === undefined) {
      delete process.env.OPENCODE_GEMINI_MAX_RETRY_MS;
    } else {
      process.env.OPENCODE_GEMINI_MAX_RETRY_MS = previousMaxRetryEnv;
    }
  });

  it("fails fast when server retry delay exceeds OPENCODE_GEMINI_MAX_RETRY_MS", async () => {
    process.env.OPENCODE_GEMINI_MAX_RETRY_MS = "1000";
    const fetchMock = mock(async () => makeQuota429("RATE_LIMIT_EXCEEDED", "5s"));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      body: JSON.stringify({ project: "p1", model: "gemini-3-flash-preview" }),
    });

    expect(response.status).toBe(429);
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(scheduledDelays.length).toBe(0);
  });

  it("preserves 60s per-minute quota delays without truncating to 30s", async () => {
    const perMinuteResponse = new Response(
      JSON.stringify({
        error: {
          message: "per minute limit",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.QuotaFailure",
              violations: [{ quotaId: "GenerateRequestsPerMinute" }],
            },
          ],
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    );

    const quota = await classifyQuotaResponse(perMinuteResponse);
    expect(quota?.retryDelayMs).toBe(60_000);
    const delayMs = await resolveRetryDelayMs(perMinuteResponse, 1, quota?.retryDelayMs);
    expect(delayMs).toBe(60_000);
  });

  it("cancels discarded 503 response bodies before retrying and supports retry-after-ms: 0", async () => {
    let cancelled = false;
    const bodyStream = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response(bodyStream, {
          status: 503,
          headers: { "retry-after-ms": "0" },
        });
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", { method: "GET" });
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
    expect(cancelled).toBe(true);
    expect(scheduledDelays.length).toBe(0);
  });

  it("retries AggregateError wrapping ECONNRESET", async () => {
    const inner = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const agg = new AggregateError([inner], "connect failed");
    const fetchMock = mock(async () => {
      if (fetchMock.mock.calls.length === 1) {
        throw agg;
      }
      return new Response("ok", { status: 200 });
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", { method: "GET" });
    expect(response.status).toBe(200);
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it("stops retrying when AbortSignal aborts during sleep", async () => {
    const controller = new AbortController();
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
      scheduledDelays.push(typeof ms === "number" ? ms : 0);
      controller.abort();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    const fetchMock = mock(async () => makeQuota429("RATE_LIMIT_EXCEEDED", "1500ms"));
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const response = await fetchWithRetry("https://example.com", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(429);
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(scheduledDelays).toEqual([1500]);
  });

  it("classifies multiple ErrorInfo entries, offset arrays, and SSE 429 bodies", async () => {
    const multiInfo = new Response(
      JSON.stringify([
        null,
        {
          error: {
            message: "quota depleted",
            details: [
              { "@type": "type.googleapis.com/google.rpc.ErrorInfo", domain: "other.example", reason: "NOOP" },
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                domain: "cloudcode-pa.googleapis.com",
                reason: "QUOTA_EXHAUSTED",
              },
            ],
          },
        },
      ]),
      { status: 429, headers: { "content-type": "application/json" } },
    );
    expect(await classifyQuotaResponse(multiInfo)).toEqual({
      terminal: true,
      retryDelayMs: undefined,
      reason: "QUOTA_EXHAUSTED",
    });

    const sseQuota = new Response(
      'data: {"error":{"message":"rate limit","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","domain":"cloudcode-pa.googleapis.com","reason":"RATE_LIMIT_EXCEEDED"},{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"2s"}]}}\n\n',
      { status: 429, headers: { "content-type": "text/event-stream" } },
    );
    expect(await classifyQuotaResponse(sseQuota)).toEqual({
      terminal: false,
      retryDelayMs: 2000,
      reason: "RATE_LIMIT_EXCEEDED",
    });
  });

  it("computes V2 retry decisions and keeps newer cooldown on CAS delete", async () => {
    const okDecision = await computeGeminiRetryDecision(new Response("ok", { status: 200 }), 1);
    expect(okDecision).toEqual({
      shouldRetry: false,
      delayMs: 0,
      reason: "non_retryable_status",
    });

    const retryDecision = await computeGeminiRetryDecision(
      makeQuota429("RATE_LIMIT_EXCEEDED", "2s"),
      1,
      { terminal: false, retryDelayMs: 2000, reason: "RATE_LIMIT_EXCEEDED" },
    );
    expect(retryDecision).toEqual({
      shouldRetry: true,
      delayMs: 2000,
      cooldownMs: 2000,
      reason: "retryable",
    });

    const key = "cas-test-key";
    recordRetryCooldown(key, 500);
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
      scheduledDelays.push(typeof ms === "number" ? ms : 0);
      recordRetryCooldown(key, 5000);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    await waitForRetryCooldown(key);
    await waitForRetryCooldown(key);
    expect(scheduledDelays.length).toBe(2);
    expect(scheduledDelays[1]).toBeGreaterThan(2000);
  });
});
