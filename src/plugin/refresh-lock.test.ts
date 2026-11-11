import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRefreshLock, DEFAULT_LOCK_TTL_MS } from "./refresh-lock";

describe("refresh-lock", () => {
  const tempDirs: string[] = [];

  const createTempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "gemini-refresh-lock-"));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("enforces mutual exclusion, hashes lock filenames, and releases idempotently", () => {
    const dir = createTempDir();
    const secretKey = "1//raw-refresh-token-never-in-filename";

    const first = acquireRefreshLock(secretKey, { dir });
    expect(first).not.toBeNull();
    expect(existsSync(first!.path)).toBe(true);

    const entries = readdirSync(dir);
    expect(entries.length).toBe(1);
    expect(entries[0]).not.toContain("raw-refresh-token");

    const contender = acquireRefreshLock(secretKey, { dir });
    expect(contender).toBeNull();

    first!.release();
    first!.release();
    expect(existsSync(first!.path)).toBe(false);

    const reacquired = acquireRefreshLock(secretKey, { dir });
    expect(reacquired).not.toBeNull();
    reacquired!.release();
  });

  it("reclaims stale locks past ttlMs without letting the old owner delete the new owner lock", () => {
    const dir = createTempDir();
    let clock = 10_000;
    const now = () => clock;

    const first = acquireRefreshLock("account-a", {
      dir,
      ttlMs: DEFAULT_LOCK_TTL_MS,
      now,
    });
    expect(first).not.toBeNull();

    clock += DEFAULT_LOCK_TTL_MS - 1;
    expect(
      acquireRefreshLock("account-a", {
        dir,
        ttlMs: DEFAULT_LOCK_TTL_MS,
        now,
      }),
    ).toBeNull();

    clock += 2;
    const second = acquireRefreshLock("account-a", {
      dir,
      ttlMs: DEFAULT_LOCK_TTL_MS,
      now,
    });
    expect(second).not.toBeNull();

    first!.release();
    expect(existsSync(second!.path)).toBe(true);
    expect(existsSync(`${second!.path}.reclaim`)).toBe(false);

    second!.release();
    expect(existsSync(second!.path)).toBe(false);
  });

  it("does not steal lock while another contender holds an active reclaim guard", () => {
    const dir = createTempDir();
    let clock = 50_000;
    const now = () => clock;

    const first = acquireRefreshLock("account-reclaim", {
      dir,
      ttlMs: DEFAULT_LOCK_TTL_MS,
      now,
    });
    expect(first).not.toBeNull();

    clock += DEFAULT_LOCK_TTL_MS + 50;
    const reclaimPath = `${first!.path}.reclaim`;
    writeFileSync(
      reclaimPath,
      JSON.stringify({ pid: 99999, token: "active-reclaimer", createdAt: clock }),
      "utf8",
    );

    const contender = acquireRefreshLock("account-reclaim", {
      dir,
      ttlMs: DEFAULT_LOCK_TTL_MS,
      now,
    });
    expect(contender).toBeNull();
    expect(existsSync(first!.path)).toBe(true);

    rmSync(reclaimPath, { force: true });
    first!.release();
  });
});
