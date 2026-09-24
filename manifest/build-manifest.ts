import { sharedUnlockWebMatches, type SharedUnlockEnvironment } from "../src/shared/config/shared-unlock-environments";
import sharedUnlock from "./manifest.chromium.shared-unlock.json" with { type: "json" };
import { FIREFOX_SHARED_UNLOCK_BRIDGE_PATH } from "../src/shared/messaging/shared-unlock-firefox";
import { createPublicKey } from "node:crypto";

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

export interface ChromeBetaBuild {
  runNumber: number;
  publicKey?: string | undefined;
  bootstrap: boolean;
}

export function buildManifest(target: BuildTarget = "chromium", sharedUnlockEnvironments: readonly SharedUnlockEnvironment[] = [], beta?: ChromeBetaBuild, stablePublicKey?: string): ManifestV3Export {
  const overlay = overlays[target];
  if (!overlay) {
    throw new Error(`Unknown build target: ${target}`);
  }
  const manifest = deepMerge(base as unknown as Json, overlay);
  if (stablePublicKey !== undefined) {
    if (target !== "chromium" || beta || !stablePublicKey) {
      throw new Error("Configure the Chrome Web Store stable public key for a stable Chromium build");
    }
    const key = createPublicKey({ key: Buffer.from(stablePublicKey, "base64"), format: "der", type: "spki" });
    const canonical = key.export({ format: "der", type: "spki" }).toString("base64");
    if (canonical !== stablePublicKey || canonical === chromium.key) throw new Error("Stable requires its assigned canonical store public key");
    manifest.key = canonical;
  }
  if (beta) {
    if (target !== "chromium" || !Number.isSafeInteger(beta.runNumber) || beta.runNumber < 1 || beta.runNumber > 4294967295) {
      throw new Error("Chrome beta requires a positive 32-bit CI run number and the Chromium target");
    }
    if (!beta.bootstrap && !beta.publicKey) throw new Error("Configure the Chrome Web Store beta public key");
    if (beta.publicKey) {
      const key = createPublicKey({ key: Buffer.from(beta.publicKey, "base64"), format: "der", type: "spki" });
      const canonical = key.export({ format: "der", type: "spki" }).toString("base64");
      if (canonical !== beta.publicKey || canonical === chromium.key) throw new Error("Beta requires its own canonical store public key");
      manifest.key = canonical;
    } else {
      // The first unpublished item receives its identity from the store.
      delete manifest.key;
    }
    manifest.version = `0.0.${Math.floor(beta.runNumber / 65536)}.${beta.runNumber % 65536}`;
    manifest.version_name = `${base.version}-beta.${beta.runNumber}`;
    manifest.name = "__MSG_extensionBetaName__";
    manifest.description = "__MSG_extensionBetaDescription__";
  }
  if (target === "safari") {
    // Safari rejects port-bearing host patterns; runtime API/origin checks retain exact ports.
    manifest.host_permissions = (manifest.host_permissions as string[]).map(pattern => pattern.replace(/^(https?:\/\/[^/:]+):\d+\//, "$1/"));
  }
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
  if (target === "safari" && sharedUnlockEnvironments.length > 0) {
    const matches = sharedUnlockWebMatches(sharedUnlockEnvironments);
    manifest.permissions = [...new Set([...(manifest.permissions as string[]), "webNavigation"])];
    manifest.host_permissions = [...new Set([...(manifest.host_permissions as string[]), ...matches])];
    manifest.externally_connectable = { matches };
  }
  return manifest as unknown as ManifestV3Export;
}
