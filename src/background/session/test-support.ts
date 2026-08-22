/**
 * Shared test doubles for the session suite: an in-memory `storage.session`, a
 * fake `chrome.alarms`, and a mock backend built from REAL crypto fixtures so the
 * login → unlock round-trip exercises the actual Identity KDF derivation and
 * authenticated private-key unwrap. Not a test file (no `.test.ts`), imported
 * by the specs.
 */

import {
  deriveIdentityV1,
  encryptWithKey,
  fromBase64Url,
  IDENTITY_KDF_PROFILE,
  IDENTITY_KDF_PROFILE_ID,
  IDENTITY_SECURITY_VERSION,
  randomBytes,
  toBase64,
  toBase64Url,
  wipe,
} from "@palladin/crypto";

import type { AlarmScheduler } from "./auto-lock";
import type { StorageArea } from "./session-store";
import type { FetchLike } from "./auth-client";
import type { AccountMaterial } from "./types";

/** In-memory stand-in for `chrome.storage.session` (structured values). */
export class FakeStorageArea implements StorageArea {
  private readonly map = new Map<string, unknown>();

  get(keys: string[]): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (this.map.has(key)) out[key] = this.map.get(key);
    return Promise.resolve(out);
  }

  set(items: Record<string, unknown>): Promise<void> {
    // Round-trip through JSON to mimic chrome.storage's structured serialisation
    // (so a test can't accidentally rely on holding a live object reference).
    for (const [key, value] of Object.entries(items)) {
      this.map.set(key, JSON.parse(JSON.stringify(value)));
    }
    return Promise.resolve();
  }

  remove(keys: string[]): Promise<void> {
    for (const key of keys) this.map.delete(key);
    return Promise.resolve();
  }

  /** Test helper: raw view of what is persisted. */
  keys(): string[] {
    return [...this.map.keys()];
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  values(): unknown[] {
    return [...this.map.values()];
  }
}

interface CreatedAlarm {
  when?: number;
  delayInMinutes?: number;
}

/** Fake `chrome.alarms` that records scheduling and can fire on demand. */
export class FakeAlarms implements AlarmScheduler {
  readonly created = new Map<string, CreatedAlarm>();
  private listener: ((name: string) => void) | null = null;

  create(name: string, info: CreatedAlarm): void {
    this.created.set(name, info);
  }

  clear(name: string): Promise<boolean> {
    return Promise.resolve(this.created.delete(name));
  }

  /** Wire the AutoLock dispatcher so `fire` drives the real handler. */
  onFire(listener: (name: string) => void): void {
    this.listener = listener;
  }

  fire(name: string): void {
    this.listener?.(name);
  }

  whenFor(name: string): number | undefined {
    return this.created.get(name)?.when;
  }
}

export interface TestAccount {
  readonly email: string;
  readonly password: string;
  readonly accountId: string;
  readonly kdfSalt: string;
  readonly encryptedPrivateKey: string;
  readonly expectedAuthCredential: string;
  /** base64 of the private key the unlock must recover. */
  readonly privateKeyB64: string;
}

export function accountMaterial(account: TestAccount): AccountMaterial {
  return {
    accountId: account.accountId,
    kdf: {
      securityVersion: IDENTITY_SECURITY_VERSION,
      minimumSecurityVersion: IDENTITY_SECURITY_VERSION,
      profileId: IDENTITY_KDF_PROFILE_ID,
      kdfSalt: account.kdfSalt,
    },
    encryptedPrivateKey: account.encryptedPrivateKey,
  };
}

/** Build a fixture account with real salts, wrapped private key, and authHash. */
export async function buildTestAccount(
  email = "user@palladin.test",
  password = "correct horse battery staple",
): Promise<TestAccount> {
  const accountId = "00112233-4455-4677-8899-aabbccddeeff";
  const kdfSalt = await randomBytes(16);
  const identity = await deriveIdentityV1(password, accountId, kdfSalt);
  const privateKey = await randomBytes(32);
  const encryptedPrivateKeyBytes = await encryptWithKey(privateKey, identity.masterKey);
  const encryptedPrivateKey = toBase64Url(encryptedPrivateKeyBytes);
  const expectedAuthCredential = toBase64Url(identity.authCredential);
  const encodedKdfSalt = toBase64Url(kdfSalt);
  const privateKeyB64 = toBase64(privateKey);
  wipe(identity.authCredential);
  wipe(identity.masterKey);
  wipe(encryptedPrivateKeyBytes);
  wipe(kdfSalt);
  wipe(privateKey);
  return {
    email,
    password,
    accountId,
    kdfSalt: encodedKdfSalt,
    encryptedPrivateKey,
    expectedAuthCredential,
    privateKeyB64,
  };
}

export interface MockBackendOptions {
  totpRequired?: boolean;
  totpCode?: string;
  totpRateLimited?: boolean;
  unknownEmail?: string;
  logoutResponse?: Promise<Response>;
}

export interface MockBackend {
  fetch: FetchLike;
  calls: string[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Mock backend implementing the auth + account endpoints against a fixture
 * account. Wrong `authCredential` → 401 (wrong password at login); everything else
 * mirrors the real contract used by the web panel.
 */
export function mockBackend(
  account: TestAccount,
  options: MockBackendOptions = {},
): MockBackend {
  const calls: string[] = [];
  const totpCode = options.totpCode ?? "123456";
  const authResponse = {
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    userId: account.accountId,
    isOnboarded: true,
    emailVerified: true,
  } as const;
  const doFetch: FetchLike = (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push(url);

    if (url.endsWith("/api/auth/login/salt")) {
      if (body["profileId"] !== IDENTITY_KDF_PROFILE_ID) return Promise.resolve(json(null, 400));
      return Promise.resolve(json({
        accountId: body["email"] === options.unknownEmail ? null : account.accountId,
        profileId: IDENTITY_KDF_PROFILE_ID,
        securityVersion: IDENTITY_SECURITY_VERSION,
        kdfSalt: account.kdfSalt,
        memoryKiB: IDENTITY_KDF_PROFILE.memoryKiB,
        iterations: IDENTITY_KDF_PROFILE.iterations,
        parallelism: IDENTITY_KDF_PROFILE.parallelism,
      }));
    }
    if (url.endsWith("/api/auth/login")) {
      if (
        body["email"] === options.unknownEmail
        || body["authCredential"] !== account.expectedAuthCredential
        || body["securityVersion"] !== IDENTITY_SECURITY_VERSION
        || body["kdfProfileId"] !== IDENTITY_KDF_PROFILE_ID
      ) return Promise.resolve(json(null, 401));
      if (options.totpRequired) {
        return Promise.resolve(json({ totpRequired: true, challengeToken: "challenge-1" }));
      }
      return Promise.resolve(json(authResponse));
    }
    if (url.endsWith("/api/auth/login/totp")) {
      if (options.totpRateLimited) {
        return Promise.resolve(new Response(null, {
          status: 429,
          headers: { "retry-after": "60" },
        }));
      }
      if (body["code"] !== totpCode) return Promise.resolve(json(null, 401));
      return Promise.resolve(json(authResponse));
    }
    if (url.endsWith("/api/auth/refresh")) {
      return Promise.resolve(json({
        accessToken: authResponse.accessToken,
        refreshToken: authResponse.refreshToken,
      }));
    }
    if (url.endsWith("/api/auth/logout")) {
      return options.logoutResponse ?? Promise.resolve(json(null, 204));
    }
    if (url.endsWith("/api/account")) {
      return Promise.resolve(
        json({
          userId: account.accountId,
          email: account.email,
          kdf: {
            securityVersion: IDENTITY_SECURITY_VERSION,
            minimumSecurityVersion: IDENTITY_SECURITY_VERSION,
            profileId: IDENTITY_KDF_PROFILE_ID,
            kdfSalt: account.kdfSalt,
            credentialRevision: 1,
            privateKeyWrapRevision: 1,
            deviceWrapperMetadata: null,
          },
          encryptedPrivateKey: account.encryptedPrivateKey,
        }),
      );
    }
    return Promise.resolve(json(null, 404));
  };
  return { fetch: doFetch, calls };
}

export { fromBase64Url, toBase64 };
