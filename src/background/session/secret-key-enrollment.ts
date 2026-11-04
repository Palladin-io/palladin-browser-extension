/**
 * Getting the Secret Key onto a browser that does not have it yet, after the
 * login bootstrap reported an Identity v2 account. Two sources:
 *
 *   - `recipient-shows-qr` device pairing: a fresh X-Wing pairing key lives
 *     only here; a signed-in device scans the QR, compares the SAS and seals
 *     the Account Secret to it. The backend relays ciphertext only.
 *   - manual PSK2 entry from the Emergency Kit, checked against the account.
 *
 * The received secret stays in worker memory until the password login proves
 * it; only then does the session store it in the device wrapper.
 */

import {
  computePairingSas,
  encodePairingQr,
  generatePairingKeyPair,
  openPairingEnvelope,
  pairingRecipientKeyDigest,
  parseSecretKey,
  toBase64Url,
  wipe,
  type PairingKeyPair,
} from "@palladin/crypto";

import type { AuthClient } from "./auth-client";
import { SessionError } from "./types";

/** identity-kdf v3 `devicePairing.session.maximumLifetimeSeconds`. */
const MAXIMUM_TRANSFER_MS = 300_000;
const PENDING_SECRET_TTL_MS = 300_000;

export interface SecretKeyScope {
  readonly accountId: string;
  readonly apiUrl: string;
}

export interface SecretKeyTransferOffer {
  readonly qrPayload: string;
  readonly sas: string;
  /** Epoch milliseconds; never later than the protocol maximum from now. */
  readonly expiresAt: number;
}

export type SecretKeyTransferStatus = "pending" | "ready";

interface ActiveTransfer {
  readonly scope: SecretKeyScope;
  readonly keyPair: PairingKeyPair;
  readonly transferId: string;
  readonly challenge: string;
  readonly pollToken: string;
  readonly expiresAt: number;
}

interface PendingSecret {
  readonly scope: SecretKeyScope;
  readonly secret: Uint8Array;
  readonly expiresAt: number;
}

function transferFailed(): SessionError {
  return new SessionError("secret-key-transfer-failed", "Secret Key transfer failed");
}

export class SecretKeyEnrollment {
  private scope: SecretKeyScope | null = null;
  private transfer: ActiveTransfer | null = null;
  private pending: PendingSecret | null = null;

  constructor(
    private readonly authClient: AuthClient,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The login bootstrap names the account; everything after binds to it. */
  require(scope: SecretKeyScope): void {
    if (this.scope?.accountId === scope.accountId && this.scope.apiUrl === scope.apiUrl) return;
    this.cancel();
    this.scope = { accountId: scope.accountId, apiUrl: scope.apiUrl };
  }

  async startTransfer(): Promise<SecretKeyTransferOffer> {
    const scope = this.requiredScope();
    this.endTransfer();
    const keyPair = await generatePairingKeyPair();
    let adopted = false;
    try {
      const session = await this.authClient.createSecretKeyTransfer(toBase64Url(keyPair.publicKey), scope.apiUrl);
      if (this.scope !== scope) throw transferFailed();
      const now = this.now();
      const serverExpiry = Date.parse(session.expiresAt);
      const expiresAt = Math.min(Number.isFinite(serverExpiry) ? serverExpiry : now, now + MAXIMUM_TRANSFER_MS);
      let offer: SecretKeyTransferOffer;
      try {
        offer = {
          qrPayload: encodePairingQr({
            flow: "recipient-shows-qr",
            transferId: session.transferId,
            recipientPublicKeyDigest: pairingRecipientKeyDigest(keyPair.publicKey),
          }),
          // The SAS commits to this device's own key and the account from the
          // login bootstrap, so a relayed substitute key shows a different code.
          sas: computePairingSas({
            accountId: scope.accountId,
            transferId: session.transferId,
            challenge: session.challenge,
            recipientPublicKey: keyPair.publicKey,
          }),
          expiresAt,
        };
      } catch {
        throw transferFailed();
      }
      this.transfer = {
        scope,
        keyPair,
        transferId: session.transferId,
        challenge: session.challenge,
        pollToken: session.pollToken,
        expiresAt,
      };
      adopted = true;
      return offer;
    } finally {
      if (!adopted) wipe(keyPair.privateKey);
    }
  }

  async pollTransfer(): Promise<SecretKeyTransferStatus> {
    const transfer = this.transfer;
    if (!transfer) throw transferFailed();
    if (this.now() >= transfer.expiresAt) {
      this.endTransfer();
      throw transferFailed();
    }
    let claim;
    try {
      claim = await this.authClient.claimSecretKeyTransfer(
        transfer.transferId,
        transfer.pollToken,
        transfer.scope.apiUrl,
      );
    } catch (error) {
      // A transient network failure keeps the transfer; anything else ends it.
      if (error instanceof SessionError && (error.code === "network" || error.code === "rate-limited")) throw error;
      if (this.transfer === transfer) this.endTransfer();
      throw transferFailed();
    }
    if (this.transfer !== transfer) throw transferFailed();
    if (claim.status === "pending") return "pending";
    this.transfer = null;
    let secret: Uint8Array;
    try {
      secret = await openPairingEnvelope(
        { accountId: transfer.scope.accountId, transferId: transfer.transferId, challenge: transfer.challenge },
        transfer.keyPair,
        { kemCiphertext: claim.kemCiphertext, ciphertext: claim.ciphertext },
      );
    } catch {
      throw transferFailed();
    } finally {
      wipe(transfer.keyPair.privateKey);
    }
    this.setPending(transfer.scope, secret);
    return "ready";
  }

  submitSecretKey(display: string): void {
    const scope = this.requiredScope();
    let secret: Uint8Array;
    try {
      secret = parseSecretKey(scope.accountId, display);
    } catch {
      throw new SessionError("secret-key-invalid", "Secret Key does not match this account");
    }
    this.endTransfer();
    this.setPending(scope, secret);
  }

  /** A copy for one login attempt; the pending secret survives a mistyped password. */
  pendingSecret(scope: SecretKeyScope): Uint8Array | null {
    const pending = this.pending;
    if (!pending) return null;
    if (this.now() >= pending.expiresAt) {
      this.clearPending();
      return null;
    }
    if (pending.scope.accountId !== scope.accountId || pending.scope.apiUrl !== scope.apiUrl) return null;
    return pending.secret.slice();
  }

  cancel(): void {
    this.endTransfer();
    this.clearPending();
    this.scope = null;
  }

  private requiredScope(): SecretKeyScope {
    if (!this.scope) throw transferFailed();
    return this.scope;
  }

  private setPending(scope: SecretKeyScope, secret: Uint8Array): void {
    this.clearPending();
    this.pending = { scope, secret, expiresAt: this.now() + PENDING_SECRET_TTL_MS };
  }

  private clearPending(): void {
    if (this.pending) wipe(this.pending.secret);
    this.pending = null;
  }

  private endTransfer(): void {
    const transfer = this.transfer;
    if (!transfer) return;
    this.transfer = null;
    wipe(transfer.keyPair.privateKey);
    void this.authClient.cancelSecretKeyTransfer(transfer.transferId, transfer.pollToken, transfer.scope.apiUrl);
  }
}
