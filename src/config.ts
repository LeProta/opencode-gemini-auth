/** Antigravity client version reported upstream: the manual setting, else the version set in the code. */
import { DEFAULT_VERSION } from "./wire";

export const VERSION_OVERRIDE_ENV = "OPENCODE_ANTIGRAVITY_VERSION";
const VERSION_PATTERN = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
let overrideWarned = false;

/** A valid setting wins; a malformed one is ignored (and said so once): it is written into the User-Agent. */
export function versionOverride(raw = process.env[VERSION_OVERRIDE_ENV]): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (VERSION_PATTERN.test(value)) return value;
  if (!overrideWarned) {
    overrideWarned = true;
    console.error(`[leprota.google-auth] ${VERSION_OVERRIDE_ENV} must look like 2.31.2; using ${DEFAULT_VERSION} instead.`);
  }
  return undefined;
}

/**
 * Nothing is read from the network or from the cache: the reported version changes only
 * with the code or with the manual setting.
 */
export function currentVersion(): string {
  return versionOverride() ?? DEFAULT_VERSION;
}
