/** Antigravity client version reported upstream: override, live manifest, cache, then fallback. */
import { readCache, writeCache } from "./cache";
import { readResponseText } from "./bounded";
import { geminiFetch } from "./fetch";
import { VERSION, parseVersionManifest } from "./vendor/protocol.js";
import { FALLBACK_VERSION } from "./wire";

const VERSION_TTL_MS = 6 * 60 * 60 * 1000;
const VERSION_MEMO_MS = 10 * 60 * 1000;

let versionMemo: { value: Promise<string>; expires: number } | undefined;

export function currentVersion(): Promise<string> {
  if (!versionMemo || Date.now() > versionMemo.expires) {
    versionMemo = { value: loadVersion(), expires: Date.now() + VERSION_MEMO_MS };
  }
  return versionMemo.value;
}

export const VERSION_OVERRIDE_ENV = "OPENCODE_ANTIGRAVITY_VERSION";
const VERSION_PATTERN = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
/** Every source of the reported version passes here: it is written into the User-Agent. */
const isVersion = (value: unknown): value is string => typeof value === "string" && VERSION_PATTERN.test(value);
let overrideWarned = false;

/** A valid override wins over the manifest; a malformed one is ignored (and said so once). */
export function versionOverride(raw = process.env[VERSION_OVERRIDE_ENV]): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (isVersion(value)) return value;
  if (!overrideWarned) {
    overrideWarned = true;
    console.error(`[leprota.google-auth] ${VERSION_OVERRIDE_ENV} must look like 2.31.2; using the live Antigravity version instead.`);
  }
  return undefined;
}

async function loadVersion(): Promise<string> {
  const forced = versionOverride();
  if (forced) return forced;
  const now = Date.now();
  const cache = await readCache();
  const cacheAge = now - (cache.versionFetchedAt ?? 0);
  const cached = isVersion(cache.version) ? cache.version : undefined;
  if (cached && cacheAge < VERSION_TTL_MS) return cached;
  const live = fetchLiveVersion(now);
  if (cached && cacheAge < VERSION_TTL_MS * 4) {
    // Yesterday's version answers now; the manifest (up to 10 s when it is unreachable)
    // is read behind it instead of holding the first request of the day.
    void live.then((version) => {
      if (version) versionMemo = undefined;
    });
    return cached;
  }
  return (await live) ?? FALLBACK_VERSION;
}

async function fetchLiveVersion(now: number): Promise<string | null> {
  try {
    const res = await geminiFetch(VERSION.manifestUrl, {
      headers: { "User-Agent": "electron-builder", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(10_000),
    });
    const version = res.status === 200 ? parseVersionManifest(await readResponseText(res, 64 * 1024, "Antigravity version manifest")) : null;
    if (!isVersion(version)) return null;
    await writeCache({ version, versionFetchedAt: now });
    return version;
  } catch {
    return null;
  }
}

/** Test hook: forget the memoized version. */
export function resetVersionForTests(): void {
  versionMemo = undefined;
}
