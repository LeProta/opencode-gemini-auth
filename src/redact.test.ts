import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeLogger, initLogger, log, redact } from "./redact";

describe("logger", () => {
  it("masks OAuth codes, state and PKCE in diagnostic query strings and structured values", () => {
    const query = new URLSearchParams({ code: "synthetic-code", state: "synthetic-state", code_verifier: "synthetic-verifier", code_challenge: "synthetic-challenge" });
    const masked = JSON.stringify(redact({
      url: `https://example.test/callback?${query}`,
      form: query,
      code_verifier: "synthetic-verifier",
      code_challenge: "synthetic-challenge",
      state: "synthetic-state",
      status: 400,
    }));
    for (const value of ["synthetic-code", "synthetic-state", "synthetic-verifier", "synthetic-challenge"]) {
      expect(masked).not.toContain(value);
    }
    expect(masked).toContain('"status":400');
  });

  const createdDirs: string[] = [];

  afterEach(() => {
    closeLogger();
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("redacts sensitive fields and token patterns while preserving non-secret counters", () => {
    const circular: Record<string, unknown> = {
      tokenType: "Bearer",
      tokenCount: 42,
      promptTokenCount: 10,
      expires: 1700000000,
      refresh_rotated: true,
      access_token: "ya29.super-secret-access",
      refreshToken: "1//super-secret-refresh",
      clientSecret: "GOCSPX-super-secret",
      headers: {
        Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
        "x-goog-api-key": "AIzaSyDummyKeyValue1234567890",
        "content-type": "application/json",
      },
    };
    circular.self = circular;

    const masked = redact(circular) as Record<string, unknown>;
    expect(masked.tokenType).toBe("Bearer");
    expect(masked.tokenCount).toBe(42);
    expect(masked.promptTokenCount).toBe(10);
    expect(masked.expires).toBe(1700000000);
    expect(masked.refresh_rotated).toBe(true);
    expect(masked.access_token).toBe("[redacted]");
    expect(masked.refreshToken).toBe("[redacted]");
    expect(masked.clientSecret).toBe("[redacted]");
    expect(masked.self).toBe("[Circular]");

    const headers = masked.headers as Record<string, unknown>;
    expect(headers.Authorization).toBe("[redacted]");
    expect(headers["x-goog-api-key"]).toBe("[redacted]");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("redacts tokens embedded in strings and skips writing when disabled", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gemini-logger-off-"));
    createdDirs.push(tempDir);
    const logPath = join(tempDir, "disabled.log");

    initLogger({ enabled: false, filePath: logPath });
    log("Bearer ya29.secret_token_value", { refresh_token: "1//secret_refresh_token" });
    expect(existsSync(logPath)).toBe(false);
  });

  it("writes redacted lines lazily to the configured file without leaking open handles", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gemini-logger-on-"));
    createdDirs.push(tempDir);
    const logPath = join(tempDir, "nested", "plugin.log");

    initLogger({ enabled: true, filePath: logPath });
    log("Attempt refresh with Bearer ya29.secret_token_12345", {
      refresh_token: "1//very-secret-refresh",
      tokenCount: 7,
    });
    closeLogger();

    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("Bearer [redacted]");
    expect(content).toContain('"refresh_token":"[redacted]"');
    expect(content).toContain('"tokenCount":7');
    expect(content).not.toContain("ya29.secret_token_12345");
    expect(content).not.toContain("1//very-secret-refresh");
  });

  it("ignores unwritable log directories without throwing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "gemini-logger-unwritable-"));
    createdDirs.push(tempDir);
    const blockingFile = join(tempDir, "not-a-directory");
    writeFileSync(blockingFile, "occupied", "utf8");

    initLogger({ enabled: true, filePath: join(blockingFile, "nested", "plugin.log") });
    expect(() => log("best-effort message", { access_token: "secret" })).not.toThrow();
  });
});
