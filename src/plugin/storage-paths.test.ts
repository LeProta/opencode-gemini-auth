import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { getGeminiPluginDataDir, getOpencodeDataDir } from "./storage-paths";

describe("storage-paths", () => {
  it("honors explicit OPENCODE_DATA_DIR override", () => {
    const dir = getOpencodeDataDir(
      { OPENCODE_DATA_DIR: "C:\\custom\\opencode-data", XDG_DATA_HOME: "/ignored" },
      "win32",
      "C:\\Users\\Alice",
    );
    expect(dir).toBe("C:\\custom\\opencode-data");
  });

  it("honors XDG_DATA_HOME across platforms", () => {
    const dir = getOpencodeDataDir(
      { XDG_DATA_HOME: "/tmp/xdg-data" },
      "linux",
      "/home/alice",
    );
    expect(dir).toBe(join("/tmp/xdg-data", "opencode"));
  });

  it("resolves Windows LOCALAPPDATA, APPDATA, and homedir fallback", () => {
    expect(
      getOpencodeDataDir(
        { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
        "win32",
        "C:\\Users\\Alice",
      ),
    ).toBe(join("C:\\Users\\Alice\\AppData\\Local", "opencode"));

    expect(
      getOpencodeDataDir(
        { APPDATA: "C:\\Users\\Alice\\AppData\\Roaming" },
        "win32",
        "C:\\Users\\Alice",
      ),
    ).toBe(join("C:\\Users\\Alice\\AppData\\Roaming", "opencode"));

    expect(getOpencodeDataDir({}, "win32", "C:\\Users\\Alice")).toBe(
      join("C:\\Users\\Alice", "AppData", "Local", "opencode"),
    );
  });

  it("resolves macOS and Linux default locations and plugin subdirectory", () => {
    expect(getOpencodeDataDir({}, "darwin", "/Users/alice")).toBe(
      join("/Users/alice", "Library", "Application Support", "opencode"),
    );
    expect(getOpencodeDataDir({}, "linux", "/home/alice")).toBe(
      join("/home/alice", ".local", "share", "opencode"),
    );
    expect(getGeminiPluginDataDir({ OPENCODE_DATA_DIR: "/data/oc" }, "linux", "/home/alice")).toBe(
      join("/data/oc", "gemini-auth"),
    );
  });
});
