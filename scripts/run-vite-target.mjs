import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { validateBuiltManifest } from "./validate-built-manifest.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const targets = ["chromium", "firefox", "safari"];
const mode = process.argv[2];
const requested = process.argv[3] ?? "chromium";

if (mode !== "build" && mode !== "dev") {
  fail("Usage: node scripts/run-vite-target.mjs <build|dev> <chromium|firefox|safari|all>");
}
if (requested === "all" && mode !== "build") {
  fail("The 'all' target is available only for builds.");
}

const selected = requested === "all" ? targets : [requested];
if (selected.some((target) => !targets.includes(target))) {
  fail(`Unknown browser target '${requested}'. Expected: ${targets.join(", ")}, or all.`);
}

const vite = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
for (const target of selected) {
  const result = spawnSync(process.execPath, [vite, mode], {
    env: { ...process.env, PALLADIN_TARGET: target },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (mode === "build") validateBuiltManifest(root, target);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
