/** Minimal transport boundary shared by canonical Vault Protocol 2 clients. */

export type FetchLike = typeof fetch;

export type VaultClientErrorCode = "unauthorized" | "network";

export class VaultClientError extends Error {
  constructor(
    readonly code: VaultClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VaultClientError";
  }
}
