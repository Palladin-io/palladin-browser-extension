/**
 * Guard test: key material must never be written to extension storage.
 * This greps the entire background source tree (comments stripped, so a prose
 * mention of the rule does not trip it) and fails if any forbidden persistence
 * API appears in code. A regression that reaches for localStorage / IndexedDB /
 * storage.local / storage.sync is caught here, in CI, before review.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const BACKGROUND_DIR = resolve(process.cwd(), "src/background");

const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "localStorage", pattern: /\blocalStorage\b/ },
  { label: "sessionStorage", pattern: /\bsessionStorage\b/ },
  { label: "indexedDB", pattern: /\bindexedDB\b/i },
  { label: "storage.local", pattern: /\bstorage\.local\b/ },
  { label: "storage.sync", pattern: /\bstorage\.sync\b/ },
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments (keep `://` in URLs intact)
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("key-storage guard", () => {
  const files = sourceFiles(BACKGROUND_DIR);

  it("finds background source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("uses no forbidden persistence API for anything in the background", () => {
    const violations: string[] = [];
    for (const file of files) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(code)) violations.push(`${file}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("uses storage.session only through the non-key SessionStore binding", () => {
    const runtime = readFileSync(join(BACKGROUND_DIR, "session/runtime.ts"), "utf8");
    expect(runtime).toContain("chrome.storage.session");
    const store = readFileSync(join(BACKGROUND_DIR, "session/session-store.ts"), "utf8");
    expect(store).not.toContain("setKeys(");
    expect(store).not.toContain("getKeys(");
    expect(store).not.toContain("palladin.session.keys");
  });
});
