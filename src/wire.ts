/**
 * Antigravity wire details that drift between client releases, mirrored from
 * router-for-me/CLIProxyAPI (MIT) at the commits recorded in ./upstream.ts:
 *   internal/misc/antigravity_version.go                     (version, User-Agents)
 *   internal/auth/antigravity/auth.go + constants.go          (registration)
 *   internal/runtime/executor/antigravity_executor_request.go (envelope)
 * When the update check reports a change in one of those files, port it here.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

/** Cloud Code rejects newer models for clients below 2.23.0. */
export const FALLBACK_VERSION = "2.29.0";
const HUB_PLATFORM = "os_type=darwin; arch=arm64";
export const NODE_API_CLIENT_UA = "google-api-nodejs-client/10.3.0";
export const GOOG_API_CLIENT = "gl-node/22.21.1";

// Changelists belong to specific Hub releases; unknown releases send no `cl=`.
const HUB_CHANGELISTS: Record<string, string> = {
  "2.23.0": "998057262",
  "2.24.0": "1000335682",
  "2.29.0": "1013060670",
};

/** OAuth token exchange and refresh: the same for every client version. */
export const TOKEN_USER_AGENT = "Go-http-client/2.0";

export function userAgents(version: string) {
  const cl = HUB_CHANGELISTS[version];
  const short = `antigravity/hub/${version} (aidev_client; ${HUB_PLATFORM}${cl ? `; cl=${cl}` : ""})`;
  return {
    /** generate / stream / loadCodeAssist / fetchAvailableModels / quota */
    short,
    /** onboardUser */
    long: `${short} ${NODE_API_CLIENT_UA}`,
  };
}

export function onboardBody(tierId: string, version: string) {
  return {
    tier_id: tierId,
    metadata: { ide_type: "ANTIGRAVITY", ide_version: version, ide_name: "antigravity" },
  };
}

/** allowedTiers[isDefault] → currentTier → free-tier (CLIProxyAPI defaultAntigravityTierID). */
export function defaultTierId(loadResp: any): string {
  const tiers = Array.isArray(loadResp?.allowedTiers) ? loadResp.allowedTiers : [];
  const preferred = tiers.find((t: any) => t?.isDefault === true && typeof t.id === "string" && t.id.trim());
  if (preferred) return preferred.id.trim();
  const current = loadResp?.currentTier?.id;
  return typeof current === "string" && current.trim() ? current.trim() : "free-tier";
}

/** sha256(first user turn's parts[0].text), top 63 bits, as "-<decimal>". */
export function stableSessionId(contents: unknown): string {
  for (const content of Array.isArray(contents) ? contents : []) {
    if (content?.role !== "user") continue;
    const text = content?.parts?.[0]?.text;
    if (typeof text !== "string" || !text) continue;
    const value = createHash("sha256").update(text).digest().readBigUInt64BE(0) & 0x7fffffffffffffffn;
    return `-${value}`;
  }
  return `-${randomBytes(8).readBigUInt64BE(0) & 0x7fffffffffffffffn}`;
}

/** Wraps a Gemini-format request the way CLIProxyAPI's geminiToAntigravityDoc + finalizer do. */
export function antigravityEnvelope(
  model: string,
  project: string,
  geminiRequest: Record<string, any>,
): Record<string, unknown> {
  const { toolConfig: topToolConfig, ...rest } = geminiRequest;
  const request: Record<string, any> = { ...rest };
  if (topToolConfig && !request.toolConfig) request.toolConfig = topToolConfig;
  delete request.safetySettings;

  const isImage = model.includes("image");
  const isClaude = model.includes("claude");
  if (isClaude) {
    request.toolConfig = {
      ...request.toolConfig,
      functionCallingConfig: { ...request.toolConfig?.functionCallingConfig, mode: "VALIDATED" },
    };
  } else if (request.generationConfig) {
    const { maxOutputTokens: _dropped, ...generationConfig } = request.generationConfig;
    request.generationConfig = generationConfig;
  }

  const envelope: Record<string, unknown> = {
    model,
    userAgent: "antigravity",
    requestType: isImage ? "image_gen" : "agent",
  };
  if (project) envelope.project = project;
  if (isImage) {
    envelope.requestId = `image_gen/${Date.now()}/${randomUUID()}/12`;
  } else {
    envelope.requestId = `agent-${randomUUID()}`;
    if (!request.sessionId) request.sessionId = stableSessionId(request.contents);
  }
  envelope.request = request;
  return envelope;
}
