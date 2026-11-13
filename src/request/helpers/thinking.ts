import type { GeminiThinkingMode } from "../model-config";
import type { ThinkingConfig } from "./types";

export interface NormalizeThinkingOptions {
  thinkingMode?: GeminiThinkingMode;
}

/**
 * Normalizes thinkingConfig aliases into canonical Gemini field names,
 * optionally enforcing model-family thinking mode compatibility.
 */
export function normalizeThinkingConfig(
  config: unknown,
  options?: NormalizeThinkingOptions,
): ThinkingConfig | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }

  const thinkingMode = options?.thinkingMode;
  if (thinkingMode === "none") {
    return undefined;
  }

  const record = config as Record<string, unknown>;
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const levelRaw = record.thinkingLevel ?? record.thinking_level;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;

  const thinkingBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : undefined;
  const thinkingLevel =
    typeof levelRaw === "string" && levelRaw.trim().length > 0 ? levelRaw.trim().toLowerCase() : undefined;
  const includeThoughts = typeof includeRaw === "boolean" ? includeRaw : undefined;

  const effectiveBudget = thinkingMode === "level" ? undefined : thinkingBudget;
  const effectiveLevel = thinkingMode === "budget" ? undefined : thinkingLevel;

  if (
    effectiveBudget === undefined &&
    effectiveLevel === undefined &&
    (thinkingBudget !== undefined || thinkingLevel !== undefined)
  ) {
    return undefined;
  }

  if (effectiveBudget === undefined && effectiveLevel === undefined && includeThoughts === undefined) {
    return undefined;
  }

  const budgetEnabled = effectiveBudget !== undefined && (effectiveBudget > 0 || effectiveBudget === -1);
  const levelEnabled =
    effectiveLevel !== undefined && effectiveLevel !== "none" && effectiveLevel !== "off";
  // Off only when the caller turned thinking off (budget 0, level none/off). A caller
  // that names no budget or level leaves the model's default thinking on, and one
  // that does not mention includeThoughts leaves that choice to withThoughts().
  const thinkingOff = (effectiveBudget !== undefined || effectiveLevel !== undefined) && !budgetEnabled && !levelEnabled;
  const finalIncludeThoughts = thinkingOff ? false : includeThoughts;

  const normalized: ThinkingConfig = {};
  if (effectiveBudget !== undefined) {
    normalized.thinkingBudget = effectiveBudget;
  }
  if (effectiveLevel !== undefined) {
    normalized.thinkingLevel = effectiveLevel;
  }
  if (finalIncludeThoughts !== undefined) {
    normalized.includeThoughts = finalIncludeThoughts;
  }

  return normalized;
}
