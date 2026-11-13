#!/usr/bin/env node
// Lists CLIProxyAPI commits not yet reviewed for the files src/wire.ts mirrors.
//   npm run check:cliproxy               show what changed, with diff links
//   npm run check:cliproxy -- --accept   record the latest commits as reviewed
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamPath = join(root, "src/upstream.ts");
const source = await readFile(upstreamPath, "utf8");
const repo = source.match(/repo: "([^"]+)"/)[1];
const files = Object.fromEntries([...source.matchAll(/"([^"]+\.go)": "([0-9a-f]{40})"/g)].map((m) => [m[1], m[2]]));
const headers = { "User-Agent": "opencode-gemini-auth-check", Accept: "application/vnd.github+json" };

let next = source;
let pending = 0;
for (const [path, reviewed] of Object.entries(files)) {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits?path=${path}&per_page=30`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const commits = await res.json();
  const index = commits.findIndex((c) => c.sha === reviewed);
  const fresh = index === -1 ? commits : commits.slice(0, index);
  if (!fresh.length) {
    console.log(`ok       ${path}`);
    continue;
  }
  pending += fresh.length;
  console.log(`CHANGED  ${path}  (${fresh.length}${index === -1 ? "+" : ""} new)`);
  for (const c of fresh) console.log(`         ${c.commit.committer.date.slice(0, 10)} ${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]}`);
  console.log(`         diff: https://github.com/${repo}/compare/${reviewed.slice(0, 12)}...${fresh[0].sha.slice(0, 12)}`);
  next = next.replace(`"${path}": "${reviewed}"`, `"${path}": "${fresh[0].sha}"`);
}

if (process.argv.includes("--accept")) {
  await writeFile(upstreamPath, next);
  console.log(pending ? "Recorded the latest commits as reviewed in src/upstream.ts." : "Nothing to record.");
} else if (pending) {
  console.log("\nPort what matters into src/wire.ts, run the tests, then rerun with -- --accept.");
}
