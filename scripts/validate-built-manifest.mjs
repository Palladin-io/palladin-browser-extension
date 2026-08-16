import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const commonPermissions = ["storage", "activeTab", "alarms", "nativeMessaging"];

export function validateBuiltManifest(root, target) {
  const outputDirectory = resolve(root, "dist", target);
  const manifestPath = resolve(outputDirectory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  invariant(manifest.manifest_version === 3, `${target}: expected Manifest V3`);
  invariant(manifest.name === "Palladin", `${target}: unexpected extension name`);
  invariant(
    sameSet(manifest.host_permissions, [
      "http://localhost:5000/*",
      "https://api.stage.palladin.io/*",
      "https://api.palladin.io/*",
    ]),
    `${target}: unexpected host permissions`,
  );
  invariant(
    sameSet(manifest.optional_host_permissions, [
      "http://localhost/*",
      "http://127.0.0.1/*",
      "https://*/*",
    ]),
    `${target}: unexpected optional host permissions`,
  );

  if (target === "chromium") validateChromium(manifest, outputDirectory);
  if (target === "firefox") validateFirefox(manifest, outputDirectory);
  if (target === "safari") validateSafari(manifest, outputDirectory);
}

function validateChromium(manifest, outputDirectory) {
  invariant(typeof manifest.key === "string", "chromium: missing stable extension key");
  invariant(manifest.minimum_chrome_version === "116", "chromium: wrong version floor");
  invariant(
    sameSet(manifest.permissions, [...commonPermissions, "offscreen"]),
    "chromium: unexpected permissions",
  );
  validateBackgroundFile(manifest.background?.service_worker, outputDirectory, "chromium");
  invariant(manifest.background?.scripts === undefined, "chromium: unexpected background scripts");
  invariant(
    existsSync(resolve(outputDirectory, "src/offscreen/index.html")),
    "chromium: offscreen clipboard document is missing",
  );
}

function validateFirefox(manifest, outputDirectory) {
  invariant(manifest.key === undefined, "firefox: Chromium key leaked into manifest");
  invariant(sameSet(manifest.permissions, commonPermissions), "firefox: unexpected permissions");
  invariant(
    manifest.background?.service_worker === undefined,
    "firefox: unsupported service worker survived bundling",
  );
  invariant(
    Array.isArray(manifest.background?.scripts) && manifest.background.scripts.length === 1,
    "firefox: expected exactly one background script",
  );
  validateBackgroundFile(manifest.background.scripts[0], outputDirectory, "firefox");
  const gecko = manifest.browser_specific_settings?.gecko;
  invariant(gecko?.id === "browser-extension@palladin.io", "firefox: wrong Gecko ID");
  invariant(gecko?.strict_min_version === "140.0", "firefox: wrong version floor");
  invariant(
    sameSet(gecko?.data_collection_permissions?.required, [
      "authenticationInfo",
      "browsingActivity",
    ]),
    "firefox: wrong data collection declaration",
  );
  invariant(
    !existsSync(resolve(outputDirectory, "src/offscreen/index.html")),
    "firefox: Chromium offscreen document leaked into artifact",
  );
}

function validateSafari(manifest, outputDirectory) {
  invariant(manifest.key === undefined, "safari: Chromium key leaked into manifest");
  invariant(sameSet(manifest.permissions, commonPermissions), "safari: unexpected permissions");
  validateBackgroundFile(manifest.background?.service_worker, outputDirectory, "safari");
  invariant(
    manifest.browser_specific_settings?.safari?.strict_min_version === "16.4",
    "safari: wrong version floor",
  );
  invariant(
    !existsSync(resolve(outputDirectory, "src/offscreen/index.html")),
    "safari: Chromium offscreen document leaked into artifact",
  );
}

function validateBackgroundFile(path, outputDirectory, target) {
  invariant(typeof path === "string" && path.length > 0, `${target}: background entry is missing`);
  invariant(existsSync(resolve(outputDirectory, path)), `${target}: background entry was not built`);
}

function sameSet(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && expected.every((value) => actual.includes(value));
}

function invariant(condition, message) {
  if (!condition) throw new Error(`Built manifest validation failed: ${message}`);
}
