import { homedir } from "node:os";
import { join } from "node:path";

/**
 * OpenCode's user data directory on Windows, the only supported platform:
 * `OPENCODE_DATA_DIR`, else `XDG_DATA_HOME`, else `%LOCALAPPDATA%\opencode`.
 */
export function getOpencodeDataDir(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string {
  const explicit = env.OPENCODE_DATA_DIR?.trim();
  if (explicit) {
    return explicit;
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  if (xdgDataHome) {
    return join(xdgDataHome, "opencode");
  }

  const localAppData = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim();
  return join(localAppData || join(homeDir, "AppData", "Local"), "opencode");
}

/** The plugin's own folder there: debug logs, and the cache file of installs older than plugin storage. */
export function getGeminiPluginDataDir(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string {
  return join(getOpencodeDataDir(env, homeDir), "gemini-auth");
}
