import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolves the OpenCode user data directory across platforms, honoring
 * `OPENCODE_DATA_DIR` and `XDG_DATA_HOME` overrides when set.
 */
export function getOpencodeDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  const explicit = env.OPENCODE_DATA_DIR?.trim();
  if (explicit) {
    return explicit;
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return join(xdgDataHome, "opencode");
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim();
    if (localAppData) {
      return join(localAppData, "opencode");
    }
    return join(homeDir, "AppData", "Local", "opencode");
  }

  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "opencode");
  }

  return join(homeDir, ".local", "share", "opencode");
}

/**
 * Resolves the plugin-scoped data directory used for transient runtime state
 * such as refresh locks and debug logs.
 */
export function getGeminiPluginDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  return join(getOpencodeDataDir(env, platform, homeDir), "gemini-auth");
}
