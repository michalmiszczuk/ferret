import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: false, // dist/ui is produced by `vite build` first
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
