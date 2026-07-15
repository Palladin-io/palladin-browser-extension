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
