/** Subscription quota pools (google_quota tool, /gquota command). */
import { currentVersion } from "./config";
import { upstreamJson } from "./fetch";
import { API, parseQuotaSummary } from "./vendor/protocol.js";
import { userAgents } from "./wire";

/** Subscription quota pools (weekly / 5-hour windows), as the bridge reads them. */
export async function fetchQuotaSummary(accessToken: string, project: string): Promise<QuotaSummary | null> {
  const ua = userAgents(await currentVersion());
  for (const base of [API.dailyBase, API.prodBase]) {
    try {
      const res = await upstreamJson(`${base}${API.quotaSummaryPath}`, {
        token: accessToken,
        ua: ua.short,
        body: project ? { project } : {},
      });
      if (res.status !== 200) continue;
      const summary = parseQuotaSummary(res.json) as QuotaSummary | null;
      if (summary) return summary;
    } catch {}
  }
  return null;
}

export interface QuotaSummary {
  description: string;
  groups: Array<{
    name: string;
    description: string;
    buckets: Array<{ name: string; window: string; remaining: number | null; resetAt: number | null; disabled: boolean }>;
  }>;
}

export function formatQuotaSummary(summary: QuotaSummary, now = Date.now()): string {
  const lines = ["Google subscription quota:"];
  for (const group of summary.groups) {
    lines.push("", `${group.name || "Models"}`);
    for (const bucket of group.buckets) {
      const label = bucket.name || bucket.window || "quota";
      const left = bucket.disabled ? "inactive" : bucket.remaining === null ? "unknown" : `${Math.round(bucket.remaining * 100)}% left`;
      const reset = bucket.resetAt ? `, resets in ${formatDuration(bucket.resetAt - now)}` : "";
      lines.push(`- ${label}: ${left}${reset}`);
    }
  }
  return lines.join("\n");
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.round(hours / 24)} days`;
}
