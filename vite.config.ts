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
      // The install-time onboarding page is opened at runtime and must be an
      // explicit input on every target. Chromium also creates its offscreen
      // clipboard document at runtime; Firefox needs the sidebar input.
      ...(target === "chromium"
        ? {
            input: {
              onboarding: fileURLToPath(new URL("./src/onboarding/index.html", import.meta.url)),
              offscreen: fileURLToPath(new URL("./src/offscreen/index.html", import.meta.url)),
            },
          }
        : target === "firefox"
          ? {
              // CRXJS recognises Chromium's `side_panel` entry automatically,
              // while Firefox's `sidebar_action.default_panel` needs an
              // explicit HTML build input. Both still compile the same app.
              input: {
                onboarding: fileURLToPath(new URL("./src/onboarding/index.html", import.meta.url)),
                sidePanel: fileURLToPath(new URL("./src/side-panel/index.html", import.meta.url)),
              },
            }
          : {
              input: {
                onboarding: fileURLToPath(new URL("./src/onboarding/index.html", import.meta.url)),
              },
            }),
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
