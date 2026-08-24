import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { extname, resolve, sep } from "node:path";

const CONTENT_HASH_LENGTH = 12;

/**
 * CRXJS gives its tiny dynamic-import loaders stable filenames even when the
 * imported chunk changes. Chromium may retain the old loader across an
 * unpacked-extension reload and then request an asset removed by emptyOutDir.
 * Bind every loader path in the built manifest to the loader's final bytes.
 */
export function cacheBustContentLoaders(root, target) {
  const outputDirectory = resolve(root, "dist", target);
  const manifestPath = resolve(outputDirectory, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let rewritten = 0;

  for (const contentScript of manifest.content_scripts ?? []) {
    if (!Array.isArray(contentScript.js)) continue;
    contentScript.js = contentScript.js.map((relativePath) => {
      if (typeof relativePath !== "string" || !relativePath.includes("-loader-")) {
        return relativePath;
      }
      const sourcePath = safeOutputPath(outputDirectory, relativePath);
      const source = readFileSync(sourcePath);
      const digest = createHash("sha256").update(source).digest("hex").slice(0, CONTENT_HASH_LENGTH);
      const extension = extname(relativePath);
      const rewrittenPath = `${relativePath.slice(0, -extension.length)}-content-${digest}${extension}`;
      const destinationPath = safeOutputPath(outputDirectory, rewrittenPath);
      if (existsSync(destinationPath)) {
        throw new Error(`Content loader cache-bust collision: ${rewrittenPath}`);
      }
      renameSync(sourcePath, destinationPath);
      rewritten += 1;
      return rewrittenPath;
    });
  }

  if (rewritten === 0) throw new Error(`${target}: no generated content loaders found`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function safeOutputPath(outputDirectory, relativePath) {
  const candidate = resolve(outputDirectory, relativePath);
  if (candidate === outputDirectory || !candidate.startsWith(`${outputDirectory}${sep}`)) {
    throw new Error(`Content loader path escaped build output: ${relativePath}`);
  }
  return candidate;
}
