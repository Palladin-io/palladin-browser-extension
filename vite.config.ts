import { fileURLToPath, URL } from "node:url";

import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { buildManifest, resolveBuildTarget } from "./manifest/build-manifest";

const target = resolveBuildTarget(process.env.PALLADIN_TARGET);

export default defineConfig({
  define: {
    __PALLADIN_TARGET__: JSON.stringify(target),
  },
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  plugins: [
    react(),
    crx({
      manifest: buildManifest(target),
      // CRXJS needs its Firefox mode to retain and bundle background.scripts;
      // Safari consumes the same service-worker packaging shape as Chromium.
      browser: target === "firefox" ? "firefox" : "chrome",
    }),
  ],
  build: {
    outDir: `dist/${target}`,
    emptyOutDir: true,
    // MV3 forbids remote code; everything must be bundled locally.
    target: "esnext",
    rollupOptions: {
      // Chromium's offscreen clipboard document is created at runtime (not
      // declared in the manifest), so it must be an explicit build input. The
      // other targets omit both this input and the unsupported permission.
      ...(target === "chromium"
        ? {
            input: {
              offscreen: fileURLToPath(new URL("./src/offscreen/index.html", import.meta.url)),
            },
          }
        : {}),
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
