/** Typed, value-free popup command boundary for explicit native-host pairing. */

import {
  parseAgentPairingBundle,
  type AgentPairingStatus,
} from "@shared/agent/pairing";

import {
  isHostPairingIntentToken,
  type HostPairingIntentToken,
  type HostPairingRecord,
} from "./pairing-store";

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
  createIntentToken(): HostPairingIntentToken;
  savePairingIntent(intentToken: HostPairingIntentToken): Promise<void>;
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
 * storage await. Intent writes have their own FIFO so a later command can
 * durably invalidate an older active-record write while that older operation is
 * still suspended. The operation FIFO preserves the final cleanup/write order.
 */
export function createAgentPairingRuntimeHandler(
  deps: AgentPairingCommandDeps,
): AgentPairingRuntimeHandler {
  let tail: Promise<void> = Promise.resolve();
  let intentTail: Promise<void> = Promise.resolve();
  let intentGeneration = 0;

  return (raw) => {
    if (!isAgentPairingNamespace(raw)) return Promise.resolve(null);
    const command = parseAgentPairingCommand(raw);
    if (command === null) return Promise.resolve(failure("invalid-bundle"));

    const mutatesPairing = command.type !== "agent-pairing/status";
    let intentToken: HostPairingIntentToken | null = null;
    if (mutatesPairing) {
      try {
        intentToken = deps.createIntentToken();
        if (!isHostPairingIntentToken(intentToken)) return Promise.resolve(failure("unavailable"));
      } catch {
        return Promise.resolve(failure("unavailable"));
      }
    }
    const commandGeneration = mutatesPairing ? ++intentGeneration : intentGeneration;
    let intentReady: Promise<void> | null = null;
    if (intentToken !== null) {
      try {
        deps.disconnect();
      } catch {
        return Promise.resolve(failure("unavailable"));
      }
      const token = intentToken;
      intentReady = intentTail.then(() => deps.savePairingIntent(token));
      intentTail = intentReady.then(() => undefined, () => undefined);
    }

    const result = tail.then(async () => {
      if (intentReady !== null) {
        try {
          await intentReady;
        } catch {
          disconnectIgnoringErrors(deps);
          return failure("unavailable");
        }
        if (commandGeneration !== intentGeneration) {
          disconnectIgnoringErrors(deps);
          return failure("superseded");
        }
      }
      return dispatchAgentPairingCommand(
        deps,
        command,
        () => commandGeneration === intentGeneration,
        intentToken,
      );
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

async function dispatchAgentPairingCommand(
  deps: AgentPairingCommandDeps,
  command: AgentPairingCommand,
  isCurrent: () => boolean,
  intentToken: HostPairingIntentToken | null,
): Promise<AgentPairingCommandResult> {
  let keepVerifiedConnection = false;
  try {
    switch (command.type) {
      case "agent-pairing/status":
        return { ok: true, status: statusFrom(await deps.readVerifiedPairing()) };
      case "agent-pairing/save": {
        if (intentToken === null) return failure("unavailable");
        const bundle = parseAgentPairingBundle(command.pairingBundle);
        if (bundle === null) return failure("invalid-bundle");
        const derivedFingerprint = await deps.deriveFingerprint(bundle.hostSigningPublicKey);
        if (!isCurrent()) return failure("superseded");
        if (derivedFingerprint !== bundle.fingerprint) return failure("fingerprint-mismatch");
        const record: HostPairingRecord = {
          hostSigningPublicKey: bundle.hostSigningPublicKey,
          fingerprint: derivedFingerprint,
          intentToken,
        };
        await deps.savePairing(record);
        if (!isCurrent()) {
          // A later clear/re-pair intent may arrive while storage.set is in
          // flight. Remove the now-stale pin before yielding the FIFO so a
          // worker restart cannot resurrect it in that window.
          await deps.clearPairing();
          return failure("superseded");
        }
        // An alarm that was already queued before the first disconnect may
        // have re-opened the old persisted pin while derivation/storage was in
        // flight. Tear it down again after the replacement is durable, then
        // connect only from the newly verified record.
        deps.disconnect();
        await deps.connect();
        if (!isCurrent()) {
          await deps.clearPairing();
          return failure("superseded");
        }
        keepVerifiedConnection = true;
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
  } finally {
    // A reconnect alarm already queued before the initial teardown can open an
    // old pin during any awaited intent/derive/storage operation. Only a fully
    // verified Pair happy path may retain its new connection; clear, error, and
    // superseded outcomes all tear down again before resolving.
    if (command.type !== "agent-pairing/status" && !keepVerifiedConnection) {
      disconnectIgnoringErrors(deps);
    }
  }
}

function disconnectIgnoringErrors(deps: AgentPairingCommandDeps): void {
  try {
    deps.disconnect();
  } catch {
    // The caller still receives a value-free failure; no internal value leaks.
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
