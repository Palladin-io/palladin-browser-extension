/**
 * Vault test doubles: a mock backend built from REAL crypto fixtures (a sealed
 * Vault Key + entries encrypted under it), plus a {@link SessionAccessor} fake.
 * The round-trip exercises the actual unseal + decrypt path, so a reveal test
 * proves the wire format, not a stub. Not a test file — imported by the specs.
 */

import {
  ENTRY_TYPE_CREDENTIAL,
  ENTRY_TYPE_KEY,
  encryptEntry,
  generateKeyPair,
  sealVaultKey,
  unsealVaultKey,
  type EntryContent,
  type EntryPlaintext,
} from "@palladin/crypto";

import type { FetchLike } from "./vault-client";
import type { SessionAccessor } from "./vault-data-service";

export const TOTP_OTPAUTH =
  "otpauth://totp/Palladin:me?secret=JBSWY3DPEHPK3PXP&issuer=Palladin";

export interface EntryFixture {
  id: string;
  label: string;
  type: "key" | "credential";
  urlDomain?: string;
  content: EntryContent;
}

export interface VaultFixture {
  id: string;
  name: string;
  wrappedVK: string;
  entries: EntryFixture[];
}

export interface VaultWorld {
  privateKey: Uint8Array;
  vaults: VaultFixture[];
}

/** Encrypt `plaintext` under a fresh VK sealed to `privateKey`'s public key. */
async function sealEntry(
  privateKey: Uint8Array,
  wrappedVK: string,
  plaintext: EntryPlaintext,
): Promise<EntryContent> {
  const vaultKey = await unsealVaultKey(wrappedVK, privateKey);
  return encryptEntry(plaintext, vaultKey);
}

/**
 * Build a one-vault world: a CREDENTIAL entry (with a TOTP seed) on example.com
 * and a KEY entry, all encrypted under one sealed Vault Key.
 */
export async function buildVaultWorld(): Promise<VaultWorld> {
  const { privateKey } = await generateKeyPair();
  const wrappedVK = await sealVaultKey(privateKey);

  const credential: EntryPlaintext = {
    type: ENTRY_TYPE_CREDENTIAL,
    username: "ada@example.com",
    password: "s3cr3t-p@ss",
    url: "https://example.com/login",
    totp: TOTP_OTPAUTH,
  };
  const key: EntryPlaintext = { type: ENTRY_TYPE_KEY, value: "sk-key-value-xyz" };

  const vault: VaultFixture = {
    id: "vault-1",
    name: "Personal",
    wrappedVK,
    entries: [
      {
        id: "entry-cred",
        label: "Example login",
        type: "credential",
        urlDomain: "www.example.com",
        content: await sealEntry(privateKey, wrappedVK, credential),
      },
      {
        id: "entry-key",
        label: "API key",
        type: "key",
        content: await sealEntry(privateKey, wrappedVK, key),
      },
    ],
  };

  return { privateKey, vaults: [vault] };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface VaultBackendOptions {
  /** Token the backend accepts; any other → 401 (drives the refresh path). */
  validToken?: string;
}

export interface VaultBackend {
  fetch: FetchLike;
  calls: string[];
}

/** Mock backend for the vault + entry GET endpoints against a fixture world. */
export function vaultBackend(
  world: VaultWorld,
  options: VaultBackendOptions = {},
): VaultBackend {
  const calls: string[] = [];
  const doFetch: FetchLike = (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url).pathname;
    calls.push(path);

    if (options.validToken) {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth !== `Bearer ${options.validToken}`) return Promise.resolve(json(null, 401));
    }

    if (path === "/api/vaults") {
      return Promise.resolve(json({ vaults: world.vaults.map((v) => ({ id: v.id, name: v.name })) }));
    }
    for (const vault of world.vaults) {
      if (path === `/api/vaults/${vault.id}`) {
        return Promise.resolve(json({ id: vault.id, wrappedVK: vault.wrappedVK }));
      }
      if (path === `/api/vaults/${vault.id}/entries`) {
        return Promise.resolve(
          json({
            items: vault.entries.map((entry) => ({
              id: entry.id,
              label: entry.label,
              type: entry.type,
              updatedAt: "2026-07-15T00:00:00Z",
              ...(entry.urlDomain ? { urlDomain: entry.urlDomain } : {}),
            })),
          }),
        );
      }
      for (const entry of vault.entries) {
        if (path === `/api/vaults/${vault.id}/entries/${entry.id}`) {
          return Promise.resolve(json({ id: entry.id, type: entry.type, content: entry.content }));
        }
      }
    }
    return Promise.resolve(json(null, 404));
  };
  return { fetch: doFetch, calls };
}

/** A {@link SessionAccessor} fake with a fixed token + in-memory private key. */
export function fakeSession(
  world: VaultWorld,
  overrides: Partial<SessionAccessor> & { token?: string } = {},
): SessionAccessor {
  const token = overrides.token ?? "valid-token";
  return {
    getAccessToken: overrides.getAccessToken ?? (() => Promise.resolve(token)),
    refreshAccessToken: overrides.refreshAccessToken ?? (() => Promise.resolve(token)),
    getPrivateKey: overrides.getPrivateKey ?? (() => world.privateKey),
  };
}
