import type { GeminiApiBody, GeminiUsageMetadata } from "./types";

/**
 * Parses a Gemini API body; handles array-wrapped responses the API sometimes returns.
 */
export function parseGeminiApiBody(rawText: string): GeminiApiBody | null {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      const firstObject = parsed.find(
        (item: unknown) => typeof item === "object" && item !== null && !Array.isArray(item),
      );
      return firstObject && typeof firstObject === "object" && !Array.isArray(firstObject)
        ? (firstObject as GeminiApiBody)
        : null;
    }

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as GeminiApiBody)
      : null;
  } catch {
    return null;
  }
}

/**
 * Extracts usageMetadata from a wrapped response or top-level Gemini body, guarding types.
 */
export function extractUsageMetadata(body: GeminiApiBody): GeminiUsageMetadata | null {
  const responseUsage =
    body.response && typeof body.response === "object" && !Array.isArray(body.response)
      ? (body.response as { usageMetadata?: unknown }).usageMetadata
      : undefined;
  const usage = (responseUsage ?? (body as { usageMetadata?: unknown }).usageMetadata) as
    | GeminiUsageMetadata
    | undefined;

  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }

  const asRecord = usage as Record<string, unknown>;
  const toNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  return {
    totalTokenCount: toNumber(asRecord.totalTokenCount),
    promptTokenCount: toNumber(asRecord.promptTokenCount),
    candidatesTokenCount: toNumber(asRecord.candidatesTokenCount),
    cachedContentTokenCount: toNumber(asRecord.cachedContentTokenCount),
  };
}
