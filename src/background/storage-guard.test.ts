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

const CIPHERTEXT_CACHE = join('vault', 'protocol2', 'cache.ts');
const LEGACY_HOST_PAIRING_MIGRATION = join('agent', 'legacy-pairing.ts');
const PUBLIC_SERVER_CONFIG_STORE = join('config', 'server-runtime.ts');
const SEALED_SESSION_STORE = join('session', 'runtime.ts');

const FORBIDDEN: readonly {
  readonly label: string;
  readonly pattern: RegExp;
  readonly allowInSuffixes?: readonly string[];
}[] = [
  { label: "localStorage", pattern: /\blocalStorage\b/ },
  { label: "sessionStorage", pattern: /\bsessionStorage\b/ },
  { label: "indexedDB", pattern: /\bindexedDB\b/i, allowInSuffixes: [CIPHERTEXT_CACHE] },
  {
    label: "storage.local",
    pattern: /\bstorage\.local\b/,
    allowInSuffixes: [
      LEGACY_HOST_PAIRING_MIGRATION,
      PUBLIC_SERVER_CONFIG_STORE,
      SEALED_SESSION_STORE,
    ],
  },
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
      for (const { label, pattern, allowInSuffixes } of FORBIDDEN) {
        if (pattern.test(code) && !allowInSuffixes?.some((suffix) => file.endsWith(suffix))) {
          violations.push(`${file}: ${label}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("uses storage.session only to purge the obsolete plaintext session records", () => {
    const runtime = readFileSync(join(BACKGROUND_DIR, "session/runtime.ts"), "utf8");
    expect(runtime).toContain("chrome.storage.session");
    expect(runtime).toContain("chrome.storage.local");
    const store = readFileSync(join(BACKGROUND_DIR, "session/session-store.ts"), "utf8");
    expect(store).not.toContain("setKeys(");
    expect(store).not.toContain("getKeys(");
    expect(store.match(/palladin\.session\.keys/g)).toHaveLength(1);
  });

  it("keeps the durable session exception limited to a sealed envelope", () => {
    const runtime = stripComments(
      readFileSync(join(BACKGROUND_DIR, SEALED_SESSION_STORE), "utf8"),
    );
    expect(runtime).toContain("chrome.storage.local.get");
    expect(runtime).toContain("chrome.storage.local.set");
    expect(runtime).toContain("chrome.storage.local.remove");
    expect(runtime).not.toMatch(/\b(masterKey|privateKey|vaultKey|password|accessToken|refreshToken)\b/);
  });

  it("keeps the IndexedDB exception ciphertext-only", () => {
    const cache = stripComments(readFileSync(join(BACKGROUND_DIR, CIPHERTEXT_CACHE), "utf8"));
    expect(cache).toContain("indexedDB");
    expect(cache).not.toMatch(/\b(masterKey|privateKey|vaultKey|entryDek|memberSecret)\b/i);
  });

  it("only removes obsolete Native Messaging pairing state", () => {
    const migration = stripComments(
      readFileSync(join(BACKGROUND_DIR, LEGACY_HOST_PAIRING_MIGRATION), "utf8"),
    );
    expect(migration).toContain("storage.local.remove");
    expect(migration).not.toContain("storage.local.get");
    expect(migration).not.toContain("storage.local.set");
    expect(migration).toContain("agentInjectHostPairing");
    expect(migration).toContain("agentInjectHostPairingIntent");
    expect(migration).not.toMatch(/\b(privateKey|sessionKey|ephemeralKey|nonce|ciphertext|accessToken|refreshToken)\b/);
  });

  it("keeps the durable server exception limited to a non-secret API URL", () => {
    const runtime = stripComments(
      readFileSync(join(BACKGROUND_DIR, PUBLIC_SERVER_CONFIG_STORE), "utf8"),
    );
    expect(runtime).toContain("storage.local.get");
    expect(runtime).toContain("storage.local.set");
    expect(runtime).toContain("storage.local.remove");
    expect(runtime).not.toMatch(
      /\b(privateKey|masterKey|vaultKey|sessionKey|password|ciphertext|accessToken|refreshToken)\b/,
    );
  });
});
