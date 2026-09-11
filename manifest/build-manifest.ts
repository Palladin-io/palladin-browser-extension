import { sharedUnlockWebMatches, type SharedUnlockEnvironment } from "../src/shared/config/shared-unlock-environments";
import sharedUnlock from "./manifest.chromium.shared-unlock.json" with { type: "json" };
import { FIREFOX_SHARED_UNLOCK_BRIDGE_PATH } from "../src/shared/messaging/shared-unlock-firefox";

import type { ManifestV3Export } from "@crxjs/vite-plugin";

import base from "./manifest.base.json" with { type: "json" };
import chromium from "./manifest.chromium.json" with { type: "json" };
import firefox from "./manifest.firefox.json" with { type: "json" };
import safari from "./manifest.safari.json" with { type: "json" };

export const BUILD_TARGETS = ["chromium", "firefox", "safari"] as const;
export type BuildTarget = (typeof BUILD_TARGETS)[number];

type Json = Record<string, unknown>;

const overlays: Record<BuildTarget, Json> = {
  chromium,
  firefox,
  safari,
};

export function resolveBuildTarget(value: string | undefined): BuildTarget {
  const target = value ?? "chromium";
  if (BUILD_TARGETS.some((candidate) => candidate === target)) {
    return target as BuildTarget;
  }
  throw new Error(
    `Unknown build target: ${target}. Expected one of: ${BUILD_TARGETS.join(", ")}`,
  );
}

/**
 * Recursively merge a target overlay onto the shared base manifest. Objects are
 * merged key-by-key; every other value (including arrays) is replaced wholesale,
 * so an overlay can override a permission list rather than silently appending to
 * it. Keeping the raw manifest data in auditable JSON files — merged by this one
 * small function — is deliberate: the least-privilege review at CVT-382 reads our
 * source, never generated plugin output.
 */
function deepMerge<T extends Json>(target: T, source: Json): T {
  const result: Json = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = result[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Json {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export function buildManifest(target: BuildTarget = "chromium", sharedUnlockEnvironments: readonly SharedUnlockEnvironment[] = []): ManifestV3Export {
  const overlay = overlays[target];
  if (!overlay) {
    throw new Error(`Unknown build target: ${target}`);
  }
  const manifest = deepMerge(base as unknown as Json, overlay);
  if (target === "chromium" && sharedUnlockEnvironments.length > 0) {
    manifest.permissions = [...new Set([...(manifest.permissions as string[]), ...sharedUnlock.permissions])];
    manifest.externally_connectable = { ...sharedUnlock.externally_connectable,
      matches: sharedUnlockWebMatches(sharedUnlockEnvironments) };
  }
  if (target === "firefox" && sharedUnlockEnvironments.length > 0) {
    const matches = sharedUnlockWebMatches(sharedUnlockEnvironments);
    manifest.permissions = [...new Set([...(manifest.permissions as string[]), "webNavigation"])];
    manifest.web_accessible_resources = [{ resources: ["manifest.json", FIREFOX_SHARED_UNLOCK_BRIDGE_PATH], matches }];
    manifest.content_scripts = [...(manifest.content_scripts as unknown[]), {
      matches, js: ["src/content/shared-unlock-firefox.ts"], run_at: "document_start", all_frames: false,
    }];
  }
  return manifest as unknown as ManifestV3Export;
}
