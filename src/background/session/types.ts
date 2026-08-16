/**
 * Shared session vocabulary. The keys themselves are `Uint8Array` while they
 * live in worker memory; the persisted forms (base64) are internal to
 * {@link ./session-store} and never surface here.
 */

/**
 * Session lifecycle, orthogonal to whether the browser tab is open:
 *   - `signed-out` — no tokens; a full {@link login} is required.
 *   - `locked`     — authenticated (tokens present) but no in-memory keys; an
 *                    {@link unlock} re-derives them from the password. Reached by
 *                    auto-lock, by an explicit lock, or by a service-worker
 *                    restart that cleared JS memory but not `storage.session`
 *                    when auto-lock had already wiped the keys.
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
  /** 32-byte X25519 private key recovered by unwrapping {@link AccountMaterial.encryptedPrivateKey}. */
  readonly privateKey: Uint8Array;
}

/** Result of starting a login: either fully done, or a pending TOTP second factor. */
export type LoginResult =
  | { readonly status: "unlocked" }
  | { readonly status: "totp-required"; readonly challengeToken: string };

/** Typed failures so callers (popup) can localise without string-matching. */
export type SessionErrorCode =
  | "invalid-credentials"
  | "incorrect-password"
  | "no-account-material"
  | "unsupported-security"
  | "not-authenticated"
  | "network";

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}
