/** Cloud Code project registration (loadCodeAssist / onboardUser), following CLIProxyAPI. */
import { currentVersion } from "./config";
import { upstreamJson } from "./fetch";
import { API } from "./vendor/protocol.js";
import { GOOG_API_CLIENT, defaultTierId, onboardBody, userAgents } from "./wire";

/** Google's error status (e.g. PERMISSION_DENIED), never the raw body, which can echo request data. */
function errorStatus(text: string): string {
  try {
    const status = JSON.parse(text)?.error?.status;
    if (typeof status === "string" && /^[A-Z_]{1,64}$/.test(status)) return status;
  } catch {}
  return "no error status";
}

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
  const version = currentVersion();
  const ua = userAgents(version);
  const load = await upstreamJson(`${API.dailyBase}${API.loadCodeAssistPath}`, {
    token: accessToken,
    ua: ua.short,
    body: { metadata: { ideType: "ANTIGRAVITY" } },
  });
  if (load.status !== 200) {
    throw new Error(`Antigravity loadCodeAssist failed (${load.status}): ${errorStatus(load.text)}`);
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
      throw new Error(`Antigravity onboardUser failed (${res.status}): ${errorStatus(res.text)}`);
    }
    const project = extractProject(res.json?.response) || extractProject(res.json);
    if (project) return project;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Antigravity onboardUser did not complete in time");
}
