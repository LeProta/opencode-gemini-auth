import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import { getGeminiPluginDataDir } from "./storage-paths";

export const DEFAULT_LOCK_TTL_MS = 20_000;

export interface RefreshLock {
  readonly path: string;
  release(): void;
}

export interface AcquireRefreshLockOptions {
  dir?: string;
  ttlMs?: number;
  now?: () => number;
}

interface LockFilePayload {
  pid: number;
  token: string;
  createdAt: number;
}

function hashLockKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

interface LockSnapshot {
  timestamp: number;
  token?: string;
  mtimeMs?: number;
}

function readLockSnapshot(lockPath: string): LockSnapshot | undefined {
  let statMtimeMs: number | undefined;
  try {
    statMtimeMs = statSync(lockPath).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return undefined;
    }
    return undefined;
  }

  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    if (typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt)) {
      return {
        timestamp: parsed.createdAt,
        token: typeof parsed.token === "string" ? parsed.token : undefined,
        mtimeMs: statMtimeMs,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return undefined;
    }
    // Fall back to filesystem mtime if the lock payload is unreadable or partial.
  }

  return statMtimeMs !== undefined ? { timestamp: statMtimeMs, mtimeMs: statMtimeMs } : undefined;
}

function isSameLockSnapshot(a: LockSnapshot, b: LockSnapshot): boolean {
  if (a.token !== undefined || b.token !== undefined) {
    return a.token === b.token && a.timestamp === b.timestamp;
  }
  return a.mtimeMs === b.mtimeMs && a.timestamp === b.timestamp;
}

function unlinkIfExists(targetPath: string): void {
  try {
    unlinkSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function tryCreateExclusiveLock(lockPath: string, payload: LockFilePayload): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(lockPath, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(payload), "utf8");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failure after releasing descriptor.
      }
    }
  }
}

function safeUnlinkOwnedLock(lockPath: string, ownerToken: string): void {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockFilePayload>;
    if (parsed.token !== ownerToken) {
      return;
    }
    unlinkIfExists(lockPath);
  } catch {
    // Lock already removed or reclaimed; nothing left to release.
  }
}

function tryReclaimStaleLock(
  lockPath: string,
  keyHash: string,
  ttlMs: number,
  now: () => number,
): boolean {
  const initialSnapshot = readLockSnapshot(lockPath);
  if (!initialSnapshot) {
    // Contender already released the lock between openSync EEXIST and stat/read.
    return true;
  }

  const currentNow = now();
  if (currentNow - initialSnapshot.timestamp <= ttlMs) {
    return false;
  }

  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimToken = randomUUID();
  const reclaimPayload: LockFilePayload = {
    pid: process.pid,
    token: reclaimToken,
    createdAt: currentNow,
  };

  if (!tryCreateExclusiveLock(reclaimPath, reclaimPayload)) {
    const reclaimSnapshot = readLockSnapshot(reclaimPath);
    if (!reclaimSnapshot || now() - reclaimSnapshot.timestamp <= ttlMs) {
      return false;
    }
    try {
      unlinkIfExists(reclaimPath);
    } catch {
      return false;
    }
    reclaimPayload.createdAt = now();
    if (!tryCreateExclusiveLock(reclaimPath, reclaimPayload)) {
      return false;
    }
  }

  try {
    const verifiedSnapshot = readLockSnapshot(lockPath);
    if (!verifiedSnapshot) {
      return true;
    }
    const verifyNow = now();
    if (
      !isSameLockSnapshot(initialSnapshot, verifiedSnapshot) ||
      verifyNow - verifiedSnapshot.timestamp <= ttlMs
    ) {
      return false;
    }

    log("Removing stale OAuth refresh lock", {
      keyHash,
      ageMs: verifyNow - verifiedSnapshot.timestamp,
      ttlMs,
    });
    unlinkIfExists(lockPath);
    return true;
  } catch {
    return false;
  } finally {
    safeUnlinkOwnedLock(reclaimPath, reclaimToken);
  }
}

/**
 * Attempts to acquire a cooperative filesystem mutex for refreshing a given key.
 * Automatically reclaims stale locks older than `ttlMs`. Returns `null` if held
 * by an active contender.
 */
export function acquireRefreshLock(
  key: string,
  options: AcquireRefreshLockOptions = {},
): RefreshLock | null {
  const dir = options.dir ?? join(getGeminiPluginDataDir(), "locks");
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const now = options.now ?? Date.now;

  mkdirSync(dir, { recursive: true });
  const keyHash = hashLockKey(key);
  const lockPath = join(dir, `refresh-${keyHash}.lock`);
  const ownerToken = randomUUID();
  const payload: LockFilePayload = {
    pid: process.pid,
    token: ownerToken,
    createdAt: now(),
  };

  if (!tryCreateExclusiveLock(lockPath, payload)) {
    if (!tryReclaimStaleLock(lockPath, keyHash, ttlMs, now)) {
      return null;
    }

    payload.createdAt = now();
    if (!tryCreateExclusiveLock(lockPath, payload)) {
      return null;
    }
  }

  let released = false;
  return {
    path: lockPath,
    release(): void {
      if (released) {
        return;
      }
      released = true;
      safeUnlinkOwnedLock(lockPath, ownerToken);
    },
  };
}
