import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { cacheBustContentLoaders } from "./cache-bust-content-loaders.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("content loader cache busting", () => {
  it("binds the manifest path to the final loader bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "palladin-loader-test-"));
    temporaryDirectories.push(root);
    const output = join(root, "dist", "chromium");
    const assets = join(output, "assets");
    mkdirSync(assets, { recursive: true });
    const sourcePath = "assets/index.ts-loader-static.js";
    const source = "import('./index.ts-new-content.js');\n";
    writeFileSync(join(output, sourcePath), source);
    writeFileSync(join(output, "manifest.json"), JSON.stringify({
      content_scripts: [{ js: [sourcePath], matches: ["<all_urls>"] }],
    }));

    cacheBustContentLoaders(root, "chromium");

    const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
    const digest = createHash("sha256").update(source).digest("hex").slice(0, 12);
    const expected = `assets/index.ts-loader-static-content-${digest}.js`;
    expect(manifest.content_scripts[0].js).toEqual([expected]);
    expect(existsSync(join(output, sourcePath))).toBe(false);
    expect(readFileSync(join(output, expected), "utf8")).toBe(source);
  });

  it("rejects a generated loader path outside the build output", async () => {
    const root = await mkdtemp(join(tmpdir(), "palladin-loader-test-"));
    temporaryDirectories.push(root);
    const output = join(root, "dist", "chromium");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "manifest.json"), JSON.stringify({
      content_scripts: [{ js: ["../../escaped-loader-static.js"] }],
    }));

    expect(() => cacheBustContentLoaders(root, "chromium"))
      .toThrow("Content loader path escaped build output");
  });
});
