/**
 * Shared test doubles for the session suite: an in-memory `storage.session`, a
 * fake `chrome.alarms`, and a mock backend built from REAL crypto fixtures so the
 * login → unlock round-trip exercises the actual double-Argon2id derivation and
 * secretbox unwrap. Not a test file (no `.test.ts`), imported by the specs.
 */

import {
  deriveKey,
  encryptWithKey,
  fromBase64,
  randomBytes,
  toBase64,
  wipe,
} from "@palladin/crypto";

import type { AlarmScheduler } from "./auto-lock";
import type { StorageArea } from "./session-store";
import type { FetchLike } from "./auth-client";

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
  readonly salt: string;
  readonly authSalt: string;
  readonly encryptedPrivateKey: string;
  readonly expectedAuthHash: string;
  /** base64 of the private key the unlock must recover. */
  readonly privateKeyB64: string;
}

/** Build a fixture account with real salts, wrapped private key, and authHash. */
export async function buildTestAccount(
  email = "user@palladin.test",
  password = "correct horse battery staple",
): Promise<TestAccount> {
  const salt = await randomBytes(16);
  const authSalt = await randomBytes(16);
  const masterKey = await deriveKey(password, salt);
  const privateKey = await randomBytes(32);
  const encryptedPrivateKey = toBase64(await encryptWithKey(privateKey, masterKey));
  const expectedAuthHash = toBase64(await deriveKey(password, authSalt));
  wipe(masterKey);
  return {
    email,
    password,
    salt: toBase64(salt),
    authSalt: toBase64(authSalt),
    encryptedPrivateKey,
    expectedAuthHash,
    privateKeyB64: toBase64(privateKey),
  };
}

const AUTH_RESPONSE = {
  accessToken: "access-token-1",
  refreshToken: "refresh-token-1",
  userId: "user-1",
  isOnboarded: true,
  emailVerified: true,
} as const;

export interface MockBackendOptions {
  totpRequired?: boolean;
  totpCode?: string;
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
 * account. Wrong `authHash` → 401 (wrong password at login); everything else
 * mirrors the real contract used by the web panel.
 */
export function mockBackend(
  account: TestAccount,
  options: MockBackendOptions = {},
): MockBackend {
  const calls: string[] = [];
  const totpCode = options.totpCode ?? "123456";
  const doFetch: FetchLike = (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push(url);

    if (url.endsWith("/api/auth/login/salt")) return Promise.resolve(json({ authSalt: account.authSalt }));
    if (url.endsWith("/api/auth/login")) {
      if (body["authHash"] !== account.expectedAuthHash) return Promise.resolve(json(null, 401));
      if (options.totpRequired) {
        return Promise.resolve(json({ totpRequired: true, challengeToken: "challenge-1" }));
      }
      return Promise.resolve(json(AUTH_RESPONSE));
    }
    if (url.endsWith("/api/auth/login/totp")) {
      if (body["code"] !== totpCode) return Promise.resolve(json(null, 401));
      return Promise.resolve(json(AUTH_RESPONSE));
    }
    if (url.endsWith("/api/auth/refresh")) return Promise.resolve(json(AUTH_RESPONSE));
    if (url.endsWith("/api/auth/logout")) return Promise.resolve(json(null, 204));
    if (url.endsWith("/api/account")) {
      return Promise.resolve(
        json({
          userId: AUTH_RESPONSE.userId,
          email: account.email,
          salt: account.salt,
          encryptedPrivateKey: account.encryptedPrivateKey,
        }),
      );
    }
    return Promise.resolve(json(null, 404));
  };
  return { fetch: doFetch, calls };
}

export { fromBase64, toBase64 };
