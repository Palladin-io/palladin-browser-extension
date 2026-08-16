/**
 * Thin REST client for the backend auth + account endpoints the service worker
 * needs. It is the same email+password contract the web panel speaks (CVT-251/
 * 252) — the extension keeps a SEPARATE session, but the wire protocol and the
 * double-Argon2id derivation are identical, so a credential proven here is proven
 * the same way it is in the panel.
 *
 * `fetch` is injected so tests exercise the full handshake against a mock without
 * a network. Nothing here derives keys or sees a password: the caller passes an
 * already-derived `authHash` and reads back only ciphertext + salt.
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

export interface TotpRequiredResponse {
  readonly totpRequired: true;
  readonly challengeToken: string;
}

export type PasswordLoginResponse = AuthResponse | TotpRequiredResponse;

export function isTotpRequired(
  response: PasswordLoginResponse,
): response is TotpRequiredResponse {
  return (response as TotpRequiredResponse).totpRequired === true;
}

/** Crypto material returned by `GET /api/account`; only the unlock fields are read. */
export interface AccountResponse {
  readonly userId: string;
  readonly email: string;
  /** base64 16-byte Argon2id salt for master-key derivation. */
  readonly salt?: string;
  /** base64 private key wrapped by the master key (`nonce || ciphertext`). */
  readonly encryptedPrivateKey?: string;
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
    if (response.status === 401 || response.status === 403) {
      throw new SessionError("invalid-credentials", `Auth rejected at ${path}`);
    }
    if (!response.ok) {
      throw new SessionError("network", `${path} returned ${response.status}`);
    }
    return (await response.json()) as T;
  }

  /** Pre-login salt fetch (anti-enumeration: unknown emails still get a salt). */
  fetchLoginSalt(email: string, expectedApiUrl?: string): Promise<{ authSalt: string }> {
    return this.postJson("/api/auth/login/salt", { email }, undefined, expectedApiUrl);
  }

  login(email: string, authHash: string, expectedApiUrl?: string): Promise<PasswordLoginResponse> {
    return this.postJson("/api/auth/login", { email, authHash }, undefined, expectedApiUrl);
  }

  totpLogin(challengeToken: string, code: string, expectedApiUrl?: string): Promise<AuthResponse> {
    return this.postJson(
      "/api/auth/login/totp",
      { challengeToken, code },
      undefined,
      expectedApiUrl,
    );
  }

  refresh(refreshToken: string, expectedApiUrl?: string): Promise<AuthResponse> {
    return this.postJson("/api/auth/refresh", { refreshToken }, undefined, expectedApiUrl);
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
