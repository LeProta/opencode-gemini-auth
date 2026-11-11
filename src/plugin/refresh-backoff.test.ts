import { afterEach, describe, expect, it } from "bun:test";
import {
  BASE_COOLDOWN_MS,
  classifyRefreshFailure,
  clearRefreshOutcome,
  computeBackoffMs,
  getRefreshCooldownUntil,
  getRefreshFailureKind,
  isRefreshCooldownActive,
  MAX_COOLDOWN_MS,
  noteRefreshTerminal,
  noteRefreshTransient,
  resetRefreshBackoffState,
} from "./refresh-backoff";

describe("refresh-backoff", () => {
  afterEach(() => {
    resetRefreshBackoffState();
  });

  it("classifies terminal OAuth errors vs transient failures", () => {
    expect(classifyRefreshFailure("invalid_grant", 400)).toBe("terminal");
    expect(classifyRefreshFailure("INVALID_CLIENT", 401)).toBe("terminal");
    expect(classifyRefreshFailure("unauthorized_client", 400)).toBe("terminal");
    expect(classifyRefreshFailure("unsupported_grant_type", 400)).toBe("terminal");

    expect(classifyRefreshFailure("temporarily_unavailable", 503)).toBe("transient");
    expect(classifyRefreshFailure(undefined, 429)).toBe("transient");
    expect(classifyRefreshFailure(undefined, undefined)).toBe("transient");
  });

  it("computes bounded exponential backoff", () => {
    expect(computeBackoffMs(0)).toBe(0);
    expect(computeBackoffMs(1)).toBe(BASE_COOLDOWN_MS);
    expect(computeBackoffMs(2)).toBe(BASE_COOLDOWN_MS * 2);
    expect(computeBackoffMs(3)).toBe(MAX_COOLDOWN_MS);
    expect(computeBackoffMs(10)).toBe(MAX_COOLDOWN_MS);
  });

  it("tracks transient cooldowns, expiration, and clearing", () => {
    let clock = 1_000_000;
    const now = () => clock;

    const first = noteRefreshTransient("k1", { now });
    expect(first.failures).toBe(1);
    expect(first.cooldownMs).toBe(BASE_COOLDOWN_MS);
    expect(getRefreshFailureKind("k1")).toBe("transient");
    expect(isRefreshCooldownActive("k1", now)).toBe(true);

    clock += BASE_COOLDOWN_MS - 1;
    expect(isRefreshCooldownActive("k1", now)).toBe(true);

    clock += 1;
    expect(isRefreshCooldownActive("k1", now)).toBe(false);

    const second = noteRefreshTransient("k1", { now });
    expect(second.failures).toBe(2);
    expect(second.cooldownMs).toBe(BASE_COOLDOWN_MS * 2);

    clearRefreshOutcome("k1");
    expect(getRefreshFailureKind("k1")).toBeUndefined();
    expect(getRefreshCooldownUntil("k1")).toBeUndefined();
    expect(isRefreshCooldownActive("k1", now)).toBe(false);
  });

  it("blocks retries on terminal failures until cleared", () => {
    noteRefreshTerminal("k2", { code: "invalid_grant" });
    expect(getRefreshFailureKind("k2")).toBe("terminal");
    expect(getRefreshCooldownUntil("k2")).toBe(Number.POSITIVE_INFINITY);
    expect(isRefreshCooldownActive("k2", () => 9_999_999_999)).toBe(true);

    clearRefreshOutcome("k2");
    expect(isRefreshCooldownActive("k2")).toBe(false);
  });
});
