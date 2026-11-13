/** Cloud Code project registration (loadCodeAssist / onboardUser), following CLIProxyAPI. */
import { currentVersion } from "./config";
import { upstreamJson } from "./fetch";
import { API } from "./vendor/protocol.js";
import { GOOG_API_CLIENT, defaultTierId, onboardBody, userAgents } from "./wire";

function extractProject(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = (data as Record<string, any>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object" && typeof value.id === "string" && value.id.trim()) return value.id.trim();
  }
  return "";
}

export async function resolveProject(accessToken: string): Promise<string> {
  const version = await currentVersion();
  const ua = userAgents(version);
  const load = await upstreamJson(`${API.dailyBase}${API.loadCodeAssistPath}`, {
    token: accessToken,
    ua: ua.short,
    body: { metadata: { ideType: "ANTIGRAVITY" } },
  });
  if (load.status !== 200) {
    throw new Error(`Antigravity loadCodeAssist failed (${load.status}): ${load.text.slice(0, 200)}`);
  }
  const existing = extractProject(load.json);
  if (existing) return existing;

  const tierId = defaultTierId(load.json);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await upstreamJson(`${API.dailyBase}${API.onboardUserPath}`, {
      token: accessToken,
      ua: ua.long,
      body: onboardBody(tierId, version),
      extraHeaders: { "X-Goog-Api-Client": GOOG_API_CLIENT },
      timeoutMs: 30_000,
    });
    if (res.status !== 200) {
      throw new Error(`Antigravity onboardUser failed (${res.status}): ${res.text.slice(0, 200)}`);
    }
    const project = extractProject(res.json?.response) || extractProject(res.json);
    if (project) return project;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Antigravity onboardUser did not complete in time");
}
