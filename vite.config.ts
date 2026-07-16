import { fileURLToPath, URL } from "node:url";

import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { buildManifest, type BuildTarget } from "./manifest/build-manifest";

const target = (process.env.PALLADIN_TARGET ?? "chromium") as BuildTarget;

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  plugins: [react(), crx({ manifest: buildManifest(target) })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // MV3 forbids remote code; everything must be bundled locally.
    target: "esnext",
    rollupOptions: {
      // The offscreen clipboard document is created at runtime (not declared in
      // the manifest), so it must be listed explicitly as an input for @crxjs to
      // build it to a stable path.
      input: {
        offscreen: fileURLToPath(new URL("./src/offscreen/index.html", import.meta.url)),
      },
      output: {
        // Deterministic asset names keep the least-privilege review diff-able.
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  server: {
    port: 5180,
    strictPort: true,
  },
});
