import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts", "server.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true, // index and server share one chunk instead of two identical bundles
  target: "node20",
  // A fixed name keeps dist/ diffs readable from one release to the next.
  esbuildOptions(options) {
    options.chunkNames = "shared";
  },
});
