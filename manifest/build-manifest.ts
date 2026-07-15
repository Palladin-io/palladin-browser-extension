import type { ManifestV3Export } from "@crxjs/vite-plugin";

import base from "./manifest.base.json" with { type: "json" };
import chromium from "./manifest.chromium.json" with { type: "json" };

/**
 * Build targets. Chromium is the only shipped target today (Chrome / Brave /
 * Edge / Opera share one MV3 build). Firefox (E3) and Safari (E4) land as
 * additional overlays without touching the base — see the epic phases.
 */
export type BuildTarget = "chromium";

type Json = Record<string, unknown>;

const overlays: Record<BuildTarget, Json> = {
  chromium,
};

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

export function buildManifest(target: BuildTarget = "chromium"): ManifestV3Export {
  const overlay = overlays[target];
  if (!overlay) {
    throw new Error(`Unknown build target: ${target}`);
  }
  return deepMerge(base as unknown as Json, overlay) as unknown as ManifestV3Export;
}
