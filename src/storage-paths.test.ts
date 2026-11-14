import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { getGeminiPluginDataDir, getOpencodeDataDir } from "./storage-paths";

describe("storage-paths", () => {
  const home = "C:\\Users\\Alice Martin";

  it("honors an explicit OPENCODE_DATA_DIR, then XDG_DATA_HOME", () => {
    expect(
      getOpencodeDataDir({ OPENCODE_DATA_DIR: "D:\\my data\\opencode", XDG_DATA_HOME: "D:\\ignored" }, home),
    ).toBe("D:\\my data\\opencode");
    expect(getOpencodeDataDir({ XDG_DATA_HOME: "D:\\xdg data", LOCALAPPDATA: "C:\\ignored" }, home)).toBe(
      join("D:\\xdg data", "opencode"),
    );
  });

  it("defaults to LOCALAPPDATA, then APPDATA, then the profile folder", () => {
    expect(getOpencodeDataDir({ LOCALAPPDATA: `${home}\\AppData\\Local`, APPDATA: "C:\\ignored" }, home)).toBe(
      join(home, "AppData", "Local", "opencode"),
    );
    expect(getOpencodeDataDir({ APPDATA: `${home}\\AppData\\Roaming` }, home)).toBe(
      join(home, "AppData", "Roaming", "opencode"),
    );
    expect(getOpencodeDataDir({}, home)).toBe(join(home, "AppData", "Local", "opencode"));
  });

  it("keeps the plugin's files in its own subfolder, spaces in the path included", () => {
    expect(getGeminiPluginDataDir({ OPENCODE_DATA_DIR: "D:\\my data\\opencode" }, home)).toBe(
      "D:\\my data\\opencode\\gemini-auth",
    );
  });
});
