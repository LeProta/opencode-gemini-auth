import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  formatGeminiQuotaOutput,
  formatRelativeResetTime,
  retrieveGeminiQuotaReport,
} from "./quota";
import type { RetrieveUserQuotaBucket } from "./project/types";
import type { OAuthAuthDetails } from "./types";

const REAL_DATE_NOW = Date.now;
const FIXED_NOW = Date.parse("2026-02-21T00:00:00.000Z");

describe("formatRelativeResetTime", () => {
  beforeEach(() => {
    Date.now = () => FIXED_NOW;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  it("formats future reset times as relative labels", () => {
    const reset = new Date(FIXED_NOW + 90 * 60 * 1000).toISOString();
    expect(formatRelativeResetTime(reset)).toBe("resets in 1h 30m");
  });

  it("returns reset pending when reset time is in the past", () => {
    const reset = new Date(FIXED_NOW - 60 * 1000).toISOString();
    expect(formatRelativeResetTime(reset)).toBe("reset pending");
  });
});

describe("formatGeminiQuotaOutput", () => {
  beforeEach(() => {
    Date.now = () => FIXED_NOW;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  it("renders grouped progress bars, groups by version, and hides token type when all are REQUESTS", () => {
    const buckets: RetrieveUserQuotaBucket[] = [
      {
        modelId: "gemini-2.5-pro_vertex",
        tokenType: "requests",
        remainingFraction: 0.5,
        remainingAmount: "100",
        resetTime: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
      },
      {
        modelId: "gemini-2.5-flash",
        remainingAmount: "20",
      },
      {
        modelId: "gemini-2.5-pro",
        tokenType: "requests",
        remainingFraction: 0.7,
        remainingAmount: "140",
        resetTime: new Date(FIXED_NOW + 2 * 60 * 60 * 1000).toISOString(),
      },
      {
        modelId: "gemini-3-pro-preview",
        tokenType: "requests",
        remainingFraction: 0.95,
      },
      {
        modelId: "gemini-2.0-flash",
        tokenType: "requests",
        remainingFraction: 0.8,
      },
    ];

    const output = formatGeminiQuotaOutput("test-project", buckets);
    expect(output).toContain("Gemini quota usage for project `test-project`");
    expect(output).toContain("Variant");
    expect(output).toContain("Remaining");
    expect(output).toContain("Reset");
    expect(output).not.toContain("Type");
    expect(output).toContain("gemini-2.5-flash\n  ↳ default");
    expect(output).toContain("gemini-2.5-pro\n  ↳ default");
    expect(output).toContain("  ↳ vertex");
    expect(output).toContain("Gemini 3 (1 model, 1 bucket)");
    expect(output).toContain("Gemini 2.5 (2 models, 3 buckets)");
    expect(output).toContain("Gemini 2.0 (1 model, 1 bucket)");
    expect(output).toContain("▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░ 70.0% (140 left)");
    expect(output).toContain(
      "▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░ 50.0% (100 left)",
    );
    expect(output.indexOf("Gemini 3 (1 model, 1 bucket)")).toBeLessThan(
      output.indexOf("Gemini 2.5 (2 models, 3 buckets)"),
    );
    expect(output.indexOf("Gemini 2.5 (2 models, 3 buckets)")).toBeLessThan(
      output.indexOf("Gemini 2.0 (1 model, 1 bucket)"),
    );
    expect(output).toContain("\n\nGemini 2.5 (2 models, 3 buckets)");
    expect(output.indexOf("gemini-2.0-flash")).toBeGreaterThan(
      output.indexOf("gemini-2.5-pro"),
    );
    expect(output.indexOf("gemini-2.5-flash")).toBeLessThan(
      output.indexOf("gemini-2.5-pro"),
    );
  });

  it("shows token type column when multiple token types are present", () => {
    const buckets: RetrieveUserQuotaBucket[] = [
      {
        modelId: "gemini-2.5-pro_vertex",
        tokenType: "REQUESTS",
        remainingFraction: 0.9,
      },
      {
        modelId: "gemini-2.5-pro",
        tokenType: "TOKENS",
        remainingFraction: 0.8,
      },
    ];

    const output = formatGeminiQuotaOutput("test-project", buckets);
    expect(output).toContain("Type");
    expect(output).toContain("Gemini 2.5 (1 model, 2 buckets)");
    expect(output).toContain("REQUESTS");
    expect(output).toContain("TOKENS");
    expect(output).toContain("  ↳ vertex");
  });
});

describe("retrieveGeminiQuotaReport", () => {
  const sampleAuth: OAuthAuthDetails = {
    type: "oauth",
    refresh: "refresh-token",
    access: "access-token",
    expires: FIXED_NOW + 60_000,
  };

  it("reports uninitialized, non-oauth, error, and thrown resolver states cleanly", async () => {
    const uninitialized = await retrieveGeminiQuotaReport({
      resolveAuth: async () => ({ status: "uninitialized" }),
      ensureProjectContext: async () => {
        throw new Error("should not run");
      },
      getConfiguredProjectId: () => undefined,
    });
    expect(uninitialized.ok).toBe(false);
    expect(uninitialized.text).toContain("before Google auth is initialized");

    const notOauth = await retrieveGeminiQuotaReport({
      resolveAuth: async () => ({ status: "not_oauth" }),
      ensureProjectContext: async () => {
        throw new Error("should not run");
      },
      getConfiguredProjectId: () => undefined,
    });
    expect(notOauth.ok).toBe(false);
    expect(notOauth.text).toContain("requires OAuth with Google");

    const authError = await retrieveGeminiQuotaReport({
      resolveAuth: async () => ({ status: "error", message: "token expired" }),
      ensureProjectContext: async () => {
        throw new Error("should not run");
      },
      getConfiguredProjectId: () => undefined,
    });
    expect(authError).toEqual({ ok: false, text: "token expired" });

    const thrown = await retrieveGeminiQuotaReport({
      resolveAuth: async () => {
        throw new Error("network down");
      },
      ensureProjectContext: async () => {
        throw new Error("should not run");
      },
      getConfiguredProjectId: () => undefined,
    });
    expect(thrown).toEqual({ ok: false, text: "Gemini quota lookup failed: network down" });
  });

  it("formats quota buckets without relying on global auth state", async () => {
    const origNow = Date.now;
    Date.now = () => FIXED_NOW;
    try {
      let seenProjectArg: string | undefined;
      let seenModelArg: string | undefined;
      const report = await retrieveGeminiQuotaReport({
        resolveAuth: async () => ({ status: "ok", auth: sampleAuth }),
        getConfiguredProjectId: async () => "configured-proj",
        getUserAgentModel: () => "gemini-2.5-pro",
        ensureProjectContext: async (auth, configuredProjectId, userAgentModel) => {
          seenProjectArg = configuredProjectId;
          seenModelArg = userAgentModel;
          return { auth, effectiveProjectId: "effective-proj" };
        },
        fetchUserQuota: async () => ({
          buckets: [
            {
              modelId: "gemini-2.5-pro",
              tokenType: "REQUESTS",
              remainingFraction: 0.75,
              remainingAmount: "150",
            },
          ],
        }),
      });

      expect(seenProjectArg).toBe("configured-proj");
      expect(seenModelArg).toBe("gemini-2.5-pro");
      expect(report.ok).toBe(true);
      expect(report.projectId).toBe("effective-proj");
      expect(report.buckets).toHaveLength(1);
      expect(report.text).toContain("Gemini quota usage for project `effective-proj`");
      expect(report.text).toContain("75.0% (150 left)");

      const empty = await retrieveGeminiQuotaReport({
        resolveAuth: async () => ({ status: "ok", auth: sampleAuth }),
        getConfiguredProjectId: () => undefined,
        ensureProjectContext: async (auth) => ({ auth, effectiveProjectId: "effective-proj" }),
        fetchUserQuota: async () => ({ buckets: [] }),
      });
      expect(empty.ok).toBe(false);
      expect(empty.projectId).toBe("effective-proj");
      expect(empty.text).toContain("No Gemini quota buckets were returned");
    } finally {
      Date.now = origNow;
    }
  });
});
