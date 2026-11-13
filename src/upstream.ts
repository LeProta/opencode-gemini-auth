import { readCache, writeCache } from "./cache";
import { geminiFetch } from "./fetch";

// Updated by `npm run check:cliproxy -- --accept` — do not edit by hand.
// Last reviewed commit of each CLIProxyAPI file that src/wire.ts mirrors.
export const CLIPROXY_UPSTREAM = {
  repo: "router-for-me/CLIProxyAPI",
  files: {
    "internal/misc/antigravity_version.go": "f72f8bfd6a1c7d69ca371dd4a7bdf490db50c154",
    "internal/auth/antigravity/constants.go": "7c627ffbdb4acff7107e05e4416e45c15a003d50",
    "internal/auth/antigravity/auth.go": "02e9e85204052dfed9bf73b7075c7b414111a4b3",
    "internal/runtime/executor/antigravity_executor_request.go": "cc95661ce438a528fa7283bf93f7dbf684d1e3fe",
  } as Record<string, string>,
} as const;

// src/vendor/protocol.js: hyqhyq3/dsh-gemini-oauth-bridge@bba1f84 (stable helpers only).

const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

// Notice only: never downloads or runs code.
let updateChecked = false;

export async function checkUpstreamUpdate(notify: (message: string) => void): Promise<void> {
  if (process.env.OPENCODE_ANTIGRAVITY_UPDATE_CHECK === "0" || updateChecked) return;
  updateChecked = true;
  const { repo, files } = CLIPROXY_UPSTREAM;
  const cache = await readCache();
  let latest = cache.upstreamShas;
  if (Date.now() - (cache.updateCheckedAt ?? 0) >= UPDATE_CHECK_TTL_MS) {
    try {
      const entries = await Promise.all(
        Object.keys(files).map(async (path) => {
          const res = await geminiFetch(`https://api.github.com/repos/${repo}/commits?path=${path}&per_page=1`, {
            headers: { "User-Agent": "opencode-gemini-auth", Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(5_000),
          });
          if (!res.ok) throw new Error(`GitHub ${res.status}`);
          const [commit] = (await res.json()) as Array<{ sha?: string }>;
          return [path, commit?.sha ?? ""] as const;
        }),
      );
      latest = Object.fromEntries(entries);
      await writeCache({ updateCheckedAt: Date.now(), upstreamShas: latest });
    } catch {}
  }
  const changed = Object.entries(files)
    .filter(([path, reviewed]) => latest?.[path] && latest[path] !== reviewed)
    .map(([path]) => path.split("/").pop());
  if (changed.length) {
    notify(
      `${repo} changed its Antigravity protocol files (${changed.join(", ")}). ` +
        "Run `npm run check:cliproxy` in the plugin repo, port the diff into src/wire.ts, then accept.",
    );
  }
}
