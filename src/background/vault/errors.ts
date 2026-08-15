/** Value-free errors exposed by the canonical Vault data boundary. */

export type VaultDataErrorCode =
  | "locked"
  | "not-authenticated"
  | "decrypt-failed"
  | "network";

export class VaultDataError extends Error {
  constructor(
    readonly code: VaultDataErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultDataError";
  }
}
