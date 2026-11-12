/**
 * Maps OpenCode's built-in Google model ids onto the ids the Antigravity catalog
 * serves for the signed-in account.
 *
 *   gemini-2.5-pro                     -> gemini-2.5-pro            (same id)
 *   gemini-3.8-flash + thinkingLevel   -> gemini-3.8-flash-<level>  (effort in the id)
 *   gemini-3-flash-preview             -> gemini-3-flash            (preview alias)
 *
 * A built-in model with no match is not served by the subscription and gets hidden.
 */

/** Fallback when the request names no level: the strongest effort first. */
const EFFORT_ORDER = ["high", "medium", "low"];

export function upstreamModelFor(
  id: string,
  available: readonly string[],
  level?: string,
): string | undefined {
  const known = new Set(available);
  const stems = id.endsWith("-preview") ? [id, id.slice(0, -"-preview".length)] : [id];
  for (const stem of stems) {
    if (known.has(stem)) return stem;
    const efforts = level ? [level, ...EFFORT_ORDER] : EFFORT_ORDER;
    for (const effort of efforts) {
      if (known.has(`${stem}-${effort}`)) return `${stem}-${effort}`;
    }
  }
  return undefined;
}

/** `generationConfig.thinkingConfig.thinkingLevel` of a Gemini request body, if any. */
export function requestedThinkingLevel(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const level = JSON.parse(body)?.generationConfig?.thinkingConfig?.thinkingLevel;
    return typeof level === "string" && level ? level.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
