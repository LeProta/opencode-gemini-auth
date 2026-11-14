import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isGeminiDebugEnabled,
  logGeminiDebugMessage,
  logGeminiDebugResponse,
  startGeminiDebugRequest,
} from "./debug";

describe("debug", () => {
  const originalDebug = process.env.OPENCODE_GEMINI_DEBUG;
  const originalDataDir = process.env.OPENCODE_DATA_DIR;
  const tempDirs: string[] = [];

  afterEach(() => {
    delete process.env.OPENCODE_GEMINI_DEBUG_CONTENT;
    if (originalDebug === undefined) {
      delete process.env.OPENCODE_GEMINI_DEBUG;
    } else {
      process.env.OPENCODE_GEMINI_DEBUG = originalDebug;
    }
    if (originalDataDir === undefined) {
      delete process.env.OPENCODE_DATA_DIR;
    } else {
      process.env.OPENCODE_DATA_DIR = originalDataDir;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("evaluates OPENCODE_GEMINI_DEBUG dynamically", () => {
    delete process.env.OPENCODE_GEMINI_DEBUG;
    expect(isGeminiDebugEnabled()).toBe(false);

    process.env.OPENCODE_GEMINI_DEBUG = "1";
    expect(isGeminiDebugEnabled()).toBe(true);

    process.env.OPENCODE_GEMINI_DEBUG = "0";
    expect(isGeminiDebugEnabled()).toBe(false);
  });

  it("writes redacted debug traces inside OPENCODE_DATA_DIR without leaving open file handles", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gemini-debug-test-"));
    tempDirs.push(tempDir);
    process.env.OPENCODE_DATA_DIR = tempDir;
    process.env.OPENCODE_GEMINI_DEBUG = "1";
    process.env.OPENCODE_GEMINI_DEBUG_CONTENT = "1";

    const ctx = startGeminiDebugRequest({
      originalUrl: "https://example.test/v1?access_token=ya29.secret_url_tok",
      resolvedUrl: "https://example.test/v1",
      method: "POST",
      headers: {
        Authorization: "Bearer ya29.secret_header_token",
        "x-goog-api-key": "AIzaSyDummyKeyValue1234567890",
      },
      body: JSON.stringify({ refresh_token: "1//secret_body_refresh", ok: true }),
      streaming: false,
    });

    logGeminiDebugMessage("Saw token ya29.secret_msg_token");
    logGeminiDebugResponse(ctx, new Response("ok", { status: 200 }), {
      body: '{"access_token":"ya29.secret_response_token"}',
    });

    const logDir = join(tempDir, "gemini-auth", "logs");
    expect(existsSync(logDir)).toBe(true);
    const files = readdirSync(logDir);
    expect(files.length).toBe(1);

    const content = readFileSync(join(logDir, files[0] as string), "utf8");
    expect(content).toContain("[redacted]");
    expect(content).not.toContain("secret_url_tok");
    expect(content).not.toContain("secret_header_token");
    expect(content).not.toContain("AIzaSyDummyKeyValue1234567890");
    expect(content).not.toContain("secret_body_refresh");
    expect(content).not.toContain("secret_msg_token");
    expect(content).not.toContain("secret_response_token");
  });

  it("keeps prompts and answers out of the log unless content logging is opted into", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gemini-debug-test-"));
    tempDirs.push(tempDir);
    process.env.OPENCODE_DATA_DIR = tempDir;
    process.env.OPENCODE_GEMINI_DEBUG = "1";

    const ctx = startGeminiDebugRequest({
      originalUrl: "https://example.test/v1",
      resolvedUrl: "https://example.test/v1",
      method: "POST",
      body: JSON.stringify({ contents: [{ parts: [{ text: "private prompt words" }] }] }),
      streaming: false,
    });
    logGeminiDebugResponse(ctx, new Response("ok", { status: 200 }), { body: '{"text":"private answer words"}' });

    const logDir = join(tempDir, "gemini-auth", "logs");
    const content = readFileSync(join(logDir, readdirSync(logDir)[0] as string), "utf8");
    expect(content).toContain("Response 200");
    expect(content).toContain("OPENCODE_GEMINI_DEBUG_CONTENT=1");
    expect(content).not.toContain("private prompt words");
    expect(content).not.toContain("private answer words");
  });
});
