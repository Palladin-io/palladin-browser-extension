/**
 * Shared session vocabulary. The keys themselves are `Uint8Array` while they
 * live in worker memory; the persisted forms (base64) are internal to
 * {@link ./session-store} and never surface here.
 */

/**
 * Session lifecycle, orthogonal to whether the browser tab is open:
 *   - `signed-out` — no sealed session; a full {@link login} is required.
 *   - `locked`     — a sealed authenticated session exists but no in-memory keys; an
 *                    {@link unlock} re-derives them from the password. Reached by
 *                    auto-lock, by an explicit lock, or by a service-worker
 *                    restart, compatible extension update, or explicit lock.
 *   - `unlocked`   — keys are in memory and ready to decrypt.
 */
export type SessionStatus = "signed-out" | "locked" | "unlocked";

/** Auth tokens. Not vault key material — see the refresh-token note in the PR. */
export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
  /** Exact API base URL that issued this session; tokens never cross server boundaries. */
  readonly apiUrl: string;
}

/**
 * Non-secret crypto material cached so an {@link unlock} can re-derive keys
 * offline, without a network round-trip. `salt` is public; `encryptedPrivateKey`
 * is ciphertext wrapped by the master key — neither is a secret at rest.
 */
export interface AccountMaterial {
  readonly accountId: string;
  readonly kdf: {
    readonly securityVersion: number;
    readonly minimumSecurityVersion: number;
    readonly profileId: string;
    readonly kdfSalt: string;
  };
  readonly encryptedPrivateKey: string;
}

/** In-memory key material. Callers must never persist or log these buffers. */
export interface SessionKeys {
  /** 32-byte Argon2id-derived master key. */
  readonly masterKey: Uint8Array;
  /** 32-byte member private key recovered by unwrapping {@link AccountMaterial.encryptedPrivateKey}. */
  readonly privateKey: Uint8Array;
  /** Key-wrapper suite of {@link privateKey}, fixed by the Identity security version. */
  readonly memberKeySuiteId: string;
  /** Directory version of {@link privateKey} from authenticated account state. */
  readonly memberKeyVersion: number;
}

/** What an unlock source can recover from cached material alone. */
export type DerivedSessionKeys = Omit<SessionKeys, "memberKeyVersion">;

/** Result of starting a login: either fully done, or a pending TOTP second factor. */
export type LoginResult =
  | { readonly status: "unlocked" }
  | { readonly status: "totp-required"; readonly challengeToken: string }
  /** Identity v2 account on a browser without its Secret Key; nothing was derived or sent. */
  | { readonly status: "secret-key-required" };

/** Typed failures so callers (popup) can localise without string-matching. */
export type SessionErrorCode =
  | "invalid-credentials"
  | "incorrect-password"
  | "no-account-material"
  | "unsupported-security"
  | "not-authenticated"
  | "rate-limited"
  | "secret-key-required"
  | "secret-key-invalid"
  | "secret-key-transfer-failed"
  | "network";

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "SessionError";
  }
}
