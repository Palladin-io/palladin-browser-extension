import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __PALLADIN_TARGET__: JSON.stringify("chromium"),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
    },
  },
  test: {
    // Node by default (pure worker/units); popup component tests opt into jsdom
    // per-file via a `// @vitest-environment jsdom` docblock.
    environment: "node",
    include: [
      "src/**/*.test.{ts,tsx}",
      "manifest/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
  },
});
