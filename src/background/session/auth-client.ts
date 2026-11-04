/**
 * Thin REST client for the backend auth + account endpoints the service worker
 * needs. It is the same email+password contract the web panel speaks (CVT-251/
 * 252) — the extension keeps a SEPARATE session, but the wire protocol and the
 * Identity password KDF is identical, so a credential proven here is proven
 * the same way it is in the panel.
 *
 * `fetch` is injected so tests exercise the full handshake against a mock without
 * a network. Nothing here derives keys or sees a password: the caller passes an
 * already-derived `authCredential` and reads back only public KDF metadata plus ciphertext.
 */

import { env } from "../config/env";
import { SessionError } from "./types";

export interface AuthResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
  readonly isOnboarded: boolean;
  readonly emailVerified?: boolean;
}

/** Token rotation returns no account profile; identity stays bound to the active session. */
export interface RefreshResponse {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface TotpRequiredResponse {
  readonly totpRequired: true;
  readonly challengeToken: string;
}

export type PasswordLoginResponse = AuthResponse | TotpRequiredResponse;

export interface LoginKdfBootstrap {
  readonly accountId: string;
  readonly profileId: string;
  readonly securityVersion: number;
  readonly kdfSalt: string;
  readonly memoryKiB: number;
  readonly iterations: number;
  readonly parallelism: number;
}

/** Recipient side of `recipient-shows-qr` Secret Key transfer (identity-kdf v3 device pairing). */
export interface SecretKeyTransferSession {
  readonly transferId: string;
  readonly challenge: string;
  readonly pollToken: string;
  readonly expiresAt: string;
}

export type SecretKeyTransferClaim =
  | { readonly status: "pending" }
  | { readonly status: "delivered"; readonly kemCiphertext: string; readonly ciphertext: string };

export function isTotpRequired(
  response: PasswordLoginResponse,
): response is TotpRequiredResponse {
  return (response as TotpRequiredResponse).totpRequired === true;
}

/** Crypto material returned by `GET /api/account`; only the unlock fields are read. */
export interface AccountResponse {
  readonly userId: string;
  readonly email: string;
  readonly kdf?: {
    readonly securityVersion: number;
    readonly minimumSecurityVersion: number;
    readonly profileId: string;
    readonly kdfSalt: string;
    readonly credentialRevision: number;
    readonly privateKeyWrapRevision: number;
    readonly deviceWrapperMetadata: string | null;
  } | null;
  /** Canonical base64url private key wrapped by the master key. */
  readonly encryptedPrivateKey?: string;
  /** Authenticated member key directory version of that private key. */
  readonly memberKeyVersion?: number | null;
}

export type FetchLike = typeof fetch;
export type ApiUrlSource = string | (() => string);

export class AuthClient {
  constructor(
    private readonly doFetch: FetchLike,
    private readonly apiUrlSource: ApiUrlSource = env.apiUrl,
  ) {}

  private get apiUrl(): string {
    return typeof this.apiUrlSource === "function" ? this.apiUrlSource() : this.apiUrlSource;
  }

  currentApiUrl(): string {
    return this.apiUrl;
  }

  private boundApiUrl(expectedApiUrl?: string): string {
    const apiUrl = this.apiUrl;
    if (expectedApiUrl !== undefined && apiUrl !== expectedApiUrl) {
      throw new SessionError("network", "Server changed during authentication");
    }
    return apiUrl;
  }

  private async postJson<T>(
    path: string,
    body: unknown,
    accessToken?: string,
    expectedApiUrl?: string,
  ): Promise<T> {
    const apiUrl = this.boundApiUrl(expectedApiUrl);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (accessToken) headers["authorization"] = `Bearer ${accessToken}`;
    let response: Response;
    try {
      response = await this.doFetch(`${apiUrl}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      throw new SessionError("network", `Request to ${path} failed`);
    }
    return this.parse<T>(response, path);
  }

  private async parse<T>(response: Response, path: string): Promise<T> {
    if (response.status === 429) {
      throw new SessionError(
        "rate-limited",
        `Auth rate-limited at ${path}`,
        retryAfterSeconds(response.headers.get("retry-after")),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new SessionError("invalid-credentials", `Auth rejected at ${path}`);
    }
    if (!response.ok) {
      throw new SessionError("network", `${path} returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Pre-login KDF bootstrap: the account's registered profile (anti-enumeration:
   * unknown emails still get a salt under the current profile).
   */
  fetchLoginKdf(email: string, expectedApiUrl?: string): Promise<LoginKdfBootstrap> {
    return this.postJson("/api/auth/login/salt", { email }, undefined, expectedApiUrl);
  }

  createSecretKeyTransfer(recipientPublicKey: string, expectedApiUrl: string): Promise<SecretKeyTransferSession> {
    return this.postJson("/api/auth/secret-key-transfers", { recipientPublicKey }, undefined, expectedApiUrl);
  }

  /** 202 while the sender has not approved; 200 delivers the envelope exactly once. */
  async claimSecretKeyTransfer(
    transferId: string,
    pollToken: string,
    expectedApiUrl: string,
  ): Promise<SecretKeyTransferClaim> {
    const path = `/api/auth/secret-key-transfers/${encodeURIComponent(transferId)}/claim`;
    const apiUrl = this.boundApiUrl(expectedApiUrl);
    let response: Response;
    try {
      response = await this.doFetch(`${apiUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pollToken }),
      });
    } catch {
      throw new SessionError("network", "Secret Key transfer claim failed");
    }
    if (response.status === 202) return { status: "pending" };
    if (response.status === 404 || response.status === 410) {
      throw new SessionError("secret-key-transfer-failed", "Secret Key transfer is no longer available");
    }
    const body = await this.parse<{ kemCiphertext: string; ciphertext: string }>(response, path);
    return { status: "delivered", kemCiphertext: body.kemCiphertext, ciphertext: body.ciphertext };
  }

  async cancelSecretKeyTransfer(transferId: string, pollToken: string, expectedApiUrl: string): Promise<void> {
    try {
      const apiUrl = this.boundApiUrl(expectedApiUrl);
      await this.doFetch(`${apiUrl}/api/auth/secret-key-transfers/${encodeURIComponent(transferId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pollToken }),
      });
    } catch {
      /* The session expires server-side on its own. */
    }
  }

  login(
    input: {
      readonly email: string;
      readonly securityVersion: number;
      readonly kdfProfileId: string;
      readonly authCredential: string;
    },
    expectedApiUrl?: string,
  ): Promise<PasswordLoginResponse> {
    return this.postJson("/api/auth/login", input, undefined, expectedApiUrl);
  }

  totpLogin(challengeToken: string, code: string, expectedApiUrl?: string): Promise<AuthResponse> {
    return this.postJson(
      "/api/auth/login/totp",
      { challengeToken, code },
      undefined,
      expectedApiUrl,
    );
  }

  async refresh(refreshToken: string, expectedApiUrl?: string): Promise<RefreshResponse> {
    const response = await this.postJson<unknown>(
      "/api/auth/refresh",
      { refreshToken },
      undefined,
      expectedApiUrl,
    );
    if (typeof response !== "object" || response === null) {
      throw new SessionError("network", "Refresh response failed validation");
    }
    const record = response as Record<string, unknown>;
    const accessToken = record["accessToken"];
    const replacementRefreshToken = record["refreshToken"];
    if (
      typeof accessToken !== "string"
      || typeof replacementRefreshToken !== "string"
      || accessToken.length === 0
      || replacementRefreshToken.length === 0
    ) {
      throw new SessionError("network", "Refresh response failed validation");
    }
    return { accessToken, refreshToken: replacementRefreshToken };
  }

  async logout(refreshToken: string, expectedApiUrl?: string): Promise<void> {
    // Best-effort server-side revocation; local wipe happens regardless.
    try {
      const apiUrl = this.boundApiUrl(expectedApiUrl);
      await this.doFetch(`${apiUrl}/api/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      /* local logout still proceeds */
    }
  }

  async getAccount(accessToken: string, expectedApiUrl?: string): Promise<AccountResponse> {
    const apiUrl = this.boundApiUrl(expectedApiUrl);
    let response: Response;
    try {
      response = await this.doFetch(`${apiUrl}/api/account`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
    } catch {
      throw new SessionError("network", "Account request failed");
    }
    return this.parse<AccountResponse>(response, "/api/account");
  }
}

function retryAfterSeconds(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isInteger(seconds) && seconds > 0) return seconds;

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return null;
  return Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000));
}
