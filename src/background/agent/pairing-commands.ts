/** Typed, value-free popup command boundary for explicit native-host pairing. */

import {
  parseAgentPairingBundle,
  type AgentPairingStatus,
} from "@shared/agent/pairing";

import type { HostPairingRecord } from "./pairing-store";

export type AgentPairingCommand =
  | { readonly type: "agent-pairing/status" }
  | {
      readonly type: "agent-pairing/save";
      readonly pairingBundle: string;
      readonly confirmed: true;
    }
  | { readonly type: "agent-pairing/clear" };

export type AgentPairingErrorCode =
  | "invalid-bundle"
  | "fingerprint-mismatch"
  | "unavailable";

export type AgentPairingCommandResult =
  | { readonly ok: true; readonly status: AgentPairingStatus }
  | { readonly ok: false; readonly code: AgentPairingErrorCode; readonly message: string };

export interface AgentPairingCommandDeps {
  readVerifiedPairing(): Promise<HostPairingRecord | null>;
  deriveFingerprint(hostSigningPublicKey: string): Promise<string>;
  savePairing(record: HostPairingRecord): Promise<void>;
  clearPairing(): Promise<void>;
  connect(): Promise<void>;
  disconnect(): void;
}

export async function dispatchAgentPairingCommand(
  deps: AgentPairingCommandDeps,
  command: AgentPairingCommand,
): Promise<AgentPairingCommandResult> {
  try {
    switch (command.type) {
      case "agent-pairing/status":
        return { ok: true, status: statusFrom(await deps.readVerifiedPairing()) };
      case "agent-pairing/save": {
        const bundle = parseAgentPairingBundle(command.pairingBundle);
        if (bundle === null) return failure("invalid-bundle");
        const derivedFingerprint = await deps.deriveFingerprint(bundle.hostSigningPublicKey);
        if (derivedFingerprint !== bundle.fingerprint) return failure("fingerprint-mismatch");
        const record: HostPairingRecord = {
          hostSigningPublicKey: bundle.hostSigningPublicKey,
          fingerprint: derivedFingerprint,
        };
        // A re-pair must never leave a channel authenticated by the old pin alive.
        deps.disconnect();
        await deps.savePairing(record);
        await deps.connect();
        return { ok: true, status: statusFrom(record) };
      }
      case "agent-pairing/clear":
        try {
          await deps.clearPairing();
        } finally {
          // Fail closed even if durable storage is temporarily unavailable.
          deps.disconnect();
        }
        return { ok: true, status: { paired: false } };
      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  } catch {
    return failure("unavailable");
  }
}

export async function handleAgentPairingRuntimeMessage(
  deps: AgentPairingCommandDeps,
  raw: unknown,
): Promise<AgentPairingCommandResult | null> {
  if (!isAgentPairingNamespace(raw)) return null;
  const command = parseAgentPairingCommand(raw);
  if (command === null) return failure("invalid-bundle");
  return dispatchAgentPairingCommand(deps, command);
}

function parseAgentPairingCommand(value: Record<string, unknown>): AgentPairingCommand | null {
  switch (value.type) {
    case "agent-pairing/status":
      return hasExactKeys(value, ["type"])
        ? value as unknown as AgentPairingCommand
        : null;
    case "agent-pairing/save":
      return hasExactKeys(value, ["type", "pairingBundle", "confirmed"])
        && typeof value.pairingBundle === "string"
        && value.confirmed === true
        ? value as unknown as AgentPairingCommand
        : null;
    case "agent-pairing/clear":
      return hasExactKeys(value, ["type"])
        ? value as unknown as AgentPairingCommand
        : null;
    default:
      return null;
  }
}

function statusFrom(record: HostPairingRecord | null): AgentPairingStatus {
  return record === null
    ? { paired: false }
    : { paired: true, fingerprint: record.fingerprint };
}

function failure(code: AgentPairingErrorCode): AgentPairingCommandResult {
  const message: Record<AgentPairingErrorCode, string> = {
    "invalid-bundle": "Pairing bundle is invalid",
    "fingerprint-mismatch": "Pairing fingerprint does not match the host public key",
    unavailable: "Agent runtime pairing is unavailable",
  };
  return { ok: false, code, message: message[code] };
}

function isAgentPairingNamespace(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>).type;
  return typeof type === "string" && type.startsWith("agent-pairing/");
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}
