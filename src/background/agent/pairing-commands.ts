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
  | "superseded"
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

export type AgentPairingRuntimeHandler = (
  raw: unknown,
) => Promise<AgentPairingCommandResult | null>;

/**
 * Create the single FIFO command processor owned by the service worker.
 *
 * A clear or replacement-pair intent disconnects synchronously, before any
 * storage await. Its generation also cancels an older save that may be suspended
 * in fingerprint derivation or persistence, while the FIFO preserves final
 * durable ordering.
 */
export function createAgentPairingRuntimeHandler(
  deps: AgentPairingCommandDeps,
): AgentPairingRuntimeHandler {
  let tail: Promise<void> = Promise.resolve();
  let intentGeneration = 0;

  return (raw) => {
    if (!isAgentPairingNamespace(raw)) return Promise.resolve(null);
    const command = parseAgentPairingCommand(raw);
    if (command === null) return Promise.resolve(failure("invalid-bundle"));

    const mutatesPairing = command.type !== "agent-pairing/status";
    const commandGeneration = mutatesPairing
      ? ++intentGeneration
      : intentGeneration;
    if (mutatesPairing) {
      try {
        deps.disconnect();
      } catch {
        return Promise.resolve(failure("unavailable"));
      }
    }

    const result = tail.then(() => dispatchAgentPairingCommand(
      deps,
      command,
      () => commandGeneration === intentGeneration,
    ));
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

async function dispatchAgentPairingCommand(
  deps: AgentPairingCommandDeps,
  command: AgentPairingCommand,
  isCurrent: () => boolean,
): Promise<AgentPairingCommandResult> {
  try {
    switch (command.type) {
      case "agent-pairing/status":
        return { ok: true, status: statusFrom(await deps.readVerifiedPairing()) };
      case "agent-pairing/save": {
        const bundle = parseAgentPairingBundle(command.pairingBundle);
        if (bundle === null) return failure("invalid-bundle");
        const derivedFingerprint = await deps.deriveFingerprint(bundle.hostSigningPublicKey);
        if (!isCurrent()) return failure("superseded");
        if (derivedFingerprint !== bundle.fingerprint) return failure("fingerprint-mismatch");
        const record: HostPairingRecord = {
          hostSigningPublicKey: bundle.hostSigningPublicKey,
          fingerprint: derivedFingerprint,
        };
        await deps.savePairing(record);
        if (!isCurrent()) return failure("superseded");
        await deps.connect();
        if (!isCurrent()) {
          deps.disconnect();
          return failure("superseded");
        }
        return { ok: true, status: statusFrom(record) };
      }
      case "agent-pairing/clear":
        await deps.clearPairing();
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
    superseded: "Pairing command was superseded",
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
