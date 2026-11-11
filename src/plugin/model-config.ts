export type GeminiModelFamily =
  | "gemini-3"
  | "gemini-2.5"
  | "gemini-2.0"
  | "gemini-1.x"
  | "gemini-image"
  | "unknown";

export type GeminiThinkingMode = "level" | "budget" | "none";

export interface GeminiModelCapabilities {
  family: GeminiModelFamily;
  thinkingMode: GeminiThinkingMode;
  usesFunctionCallIds: boolean;
  requiresThoughtSignatureFallback: boolean;
}

const MODEL_PREFIX_RE = /^(?:google\/|models\/)+/;
const GEMINI_VERSION_RE = /^gemini(?:-live)?-(\d+)(?:\.(\d+))?(?:\b|-|$)/;
const IMAGE_MODEL_RE = /(?:^|-)image(?:-|$)|^imagen(?:-|$)/;

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(MODEL_PREFIX_RE, "");
}

/**
 * Resolves model-family capabilities (thinking config mode, function-call IDs,
 * and thought-signature fallback requirements) for a Gemini model identifier.
 */
export function getGeminiModelCapabilities(modelId: string): GeminiModelCapabilities {
  const normalized = normalizeModelId(modelId);
  if (!normalized) {
    return {
      family: "unknown",
      thinkingMode: "none",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false,
    };
  }

  const versionMatch = normalized.match(GEMINI_VERSION_RE);
  const major = versionMatch ? Number(versionMatch[1]) : null;
  const minor = versionMatch && versionMatch[2] !== undefined ? Number(versionMatch[2]) : null;

  if (IMAGE_MODEL_RE.test(normalized)) {
    const isGemini3OrNewer = major !== null && major >= 3;
    return {
      family: "gemini-image",
      thinkingMode: "none",
      usesFunctionCallIds: isGemini3OrNewer,
      requiresThoughtSignatureFallback: isGemini3OrNewer,
    };
  }

  if (major !== null) {
    if (major >= 3) {
      return {
        family: "gemini-3",
        thinkingMode: "level",
        usesFunctionCallIds: true,
        requiresThoughtSignatureFallback: true,
      };
    }

    if (major === 2 && minor === 5) {
      return {
        family: "gemini-2.5",
        thinkingMode: "budget",
        usesFunctionCallIds: false,
        requiresThoughtSignatureFallback: false,
      };
    }

    if (major === 2) {
      return {
        family: "gemini-2.0",
        thinkingMode: "none",
        usesFunctionCallIds: false,
        requiresThoughtSignatureFallback: false,
      };
    }

    return {
      family: "gemini-1.x",
      thinkingMode: "none",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false,
    };
  }

  if (
    normalized === "gemini-pro" ||
    normalized === "gemini-pro-vision" ||
    normalized.startsWith("gemini-robotics-")
  ) {
    return {
      family: "gemini-1.x",
      thinkingMode: "none",
      usesFunctionCallIds: false,
      requiresThoughtSignatureFallback: false,
    };
  }

  if (normalized.startsWith("gemini-")) {
    return {
      family: "unknown",
      thinkingMode: "none",
      usesFunctionCallIds: true,
      requiresThoughtSignatureFallback: true,
    };
  }

  return {
    family: "unknown",
    thinkingMode: "none",
    usesFunctionCallIds: false,
    requiresThoughtSignatureFallback: false,
  };
}
