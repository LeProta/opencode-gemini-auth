/** Non-secret plugin cache (client version, model catalogs, update check), in OpenCode's plugin storage. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getGeminiPluginDataDir } from "./storage-paths";

export interface ModelCaps {
  contextLength?: number;
  maxCompletionTokens?: number;
  supportsImages?: boolean;
}

export interface AntigravityCache {
  version?: string;
  versionFetchedAt?: number;
  /** Last catalog fetched (pre-2.1 caches only have this). */
  models?: string[];
  /** Catalog of each account, by Cloud Code project. */
  modelsByProject?: Record<string, string[]>;
  modelCaps?: Record<string, ModelCaps>;
  updateCheckedAt?: number;
  upstreamShas?: Record<string, string>;
}

const cachePath = () => join(getGeminiPluginDataDir(), "antigravity.json");
const STORAGE_KEY = "antigravity-cache";

export interface CacheStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: any): Promise<void>;
}

let storage: CacheStorage | undefined;
let memo: Promise<AntigravityCache> | undefined;

/** OpenCode V2: keep the cache in the plugin's storage instead of a file of our own. */
export function useCacheStorage(next: CacheStorage): void {
  if (storage) return;
  storage = next;
  memo = undefined;
}

async function readFileCache(): Promise<AntigravityCache> {
  try {
    return JSON.parse(await readFile(cachePath(), "utf8")) as AntigravityCache;
  } catch {
    return {};
  }
}

async function loadCache(): Promise<AntigravityCache> {
  if (!storage) return readFileCache();
  try {
    const stored = await storage.get(STORAGE_KEY);
    if (stored && typeof stored === "object") return stored as AntigravityCache;
  } catch {}
  return readFileCache(); // one-time migration from the old file
}

export function readCache(): Promise<AntigravityCache> {
  memo ??= loadCache();
  return memo;
}

let writes: Promise<void> = Promise.resolve();

export function writeCache(patch: AntigravityCache): Promise<void> {
  // Chained on the memo and on the previous write: two writes started together
  // used to read the same snapshot, and the second one dropped the first one's patch.
  const merged = (memo = readCache().then((current) => ({ ...current, ...patch })));
  writes = writes.then(async () => {
    const next = await merged;
    try {
      if (storage) {
        await storage.set(STORAGE_KEY, next);
        return;
      }
      await mkdir(getGeminiPluginDataDir(), { recursive: true });
      await writeFile(cachePath(), JSON.stringify(next, null, 2));
    } catch {}
  });
  return writes;
}
