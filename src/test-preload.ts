// Tests never read or write the developer's real plugin data (cache file, debug logs).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENCODE_DATA_DIR = mkdtempSync(join(tmpdir(), "opencode-gemini-auth-test-"));
