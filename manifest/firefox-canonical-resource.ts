import type { CrxPlugin } from "@crxjs/vite-plugin";
import { FIREFOX_SHARED_UNLOCK_BRIDGE_PATH } from "../src/shared/messaging/shared-unlock-firefox";

/** CRXJS treats every declared resource as an input file, but manifest.json is
 * its own generated output. Add that self-reference only after CRXJS emits the
 * canonical manifest; never package a second, copied identity declaration. */
export function firefoxCanonicalManifestResource(): CrxPlugin {
  return {
    name: "palladin-firefox-canonical-manifest-resource",
    transformCrxManifest(manifest) {
      if (manifest.web_accessible_resources) {
        manifest.web_accessible_resources = manifest.web_accessible_resources.map(route => ({
          ...route, resources: route.resources.filter(resource => resource !== "manifest.json"),
        }));
      }
      return manifest;
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const asset = bundle["manifest.json"];
        if (!asset || asset.type !== "asset" || typeof asset.source !== "string") throw new Error("Missing canonical Firefox manifest");
        const manifest = JSON.parse(asset.source) as { web_accessible_resources?: Array<{ resources: string[] }> };
        const routes = manifest.web_accessible_resources?.filter(route => route.resources.includes(FIREFOX_SHARED_UNLOCK_BRIDGE_PATH));
        if (routes?.length !== 1) throw new Error("Missing exact Firefox bridge resource route");
        routes[0]!.resources.push("manifest.json");
        asset.source = JSON.stringify(manifest, null, 2);
      },
    },
  };
}
