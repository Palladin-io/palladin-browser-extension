/**
 * The popup's typed door to the worker's vault command surface — a sibling of
 * the session client. Each method is one {@link VaultCommand} over
 * `chrome.runtime` messaging; a successful reply is unwrapped to its payload, an
 * `ok:false` reply becomes a typed {@link VaultClientError} the screens localise.
 * `send` is injectable so the whole surface is testable without a live `chrome`.
 *
 * SECURITY: a revealed value crosses this channel (popup and worker share the
 * extension origin, isolated from any page) only in response to an explicit user
 * action — a copy click. It is used transiently by the popup and never persisted.
 */

import type {
  FillResult,
  TotpView,
  VaultCommand,
  VaultCommandErrorCode,
  VaultCommandResult,
  VaultListView,
  VaultRevealField,
} from "../../background/vault/commands";

export class VaultClientError extends Error {
  constructor(readonly code: VaultCommandErrorCode) {
    super(`Vault command failed: ${code}`);
    this.name = "VaultClientError";
  }
}

export interface VaultClient {
  list(): Promise<VaultListView>;
  sync(): Promise<VaultListView>;
  reveal(vaultId: string, entryId: string, field: VaultRevealField): Promise<string>;
  totp(vaultId: string, entryId: string): Promise<TotpView | null>;
  fill(vaultId: string, entryId: string): Promise<FillResult>;
}

export type VaultSend = (command: VaultCommand) => Promise<VaultCommandResult | undefined>;

const chromeSend: VaultSend = async (command) => {
  // Guarded so the popup can mount in a context without `chrome` (unit tests):
  // a missing channel surfaces as a network error the caller already handles.
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return undefined;
  return chrome.runtime.sendMessage(command) as Promise<VaultCommandResult | undefined>;
};

async function dispatch(send: VaultSend, command: VaultCommand): Promise<VaultCommandResult> {
  const result = await send(command);
  if (!result || typeof result !== "object" || !("ok" in result)) {
    throw new VaultClientError("network");
  }
  if (!result.ok) throw new VaultClientError(result.code);
  return result;
}

export function createVaultClient(send: VaultSend = chromeSend): VaultClient {
  return {
    async list() {
      const result = await dispatch(send, { type: "vault/list" });
      if (!("list" in result)) throw new VaultClientError("network");
      return result.list;
    },
    async sync() {
      const result = await dispatch(send, { type: "vault/sync" });
      if (!("list" in result)) throw new VaultClientError("network");
      return result.list;
    },
    async reveal(vaultId, entryId, field) {
      const result = await dispatch(send, { type: "vault/reveal", vaultId, entryId, field });
      if (!("reveal" in result)) throw new VaultClientError("network");
      return result.reveal.value;
    },
    async totp(vaultId, entryId) {
      const result = await dispatch(send, { type: "vault/totp", vaultId, entryId });
      if (!("totp" in result)) throw new VaultClientError("network");
      return result.totp;
    },
    async fill(vaultId, entryId) {
      const result = await dispatch(send, { type: "vault/fill", vaultId, entryId });
      if (!("fill" in result)) throw new VaultClientError("network");
      return result.fill;
    },
  };
}
