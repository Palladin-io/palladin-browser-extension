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
import type { AgentPairingMutationLease } from "./mutation-barrier";

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
  | "mutation-not-committed"
  | "superseded"
  | "unavailable";

export type AgentPairingCommandResult =
  | { readonly ok: true; readonly status: AgentPairingStatus }
  | { readonly ok: false; readonly code: AgentPairingErrorCode; readonly message: string };

export interface AgentPairingCommandDeps {
  readVerifiedPairing(): Promise<HostPairingRecord | null>;
  deriveFingerprint(hostSigningPublicKey: string): Promise<string>;
  createIntentToken(): HostPairingIntentToken;
  beginMutation(): AgentPairingMutationLease;
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
 * still suspended. The runtime lease drains already-admitted Agent fills before
 * active-record commit or success. The operation FIFO preserves final ordering.
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
    let mutationLease: AgentPairingMutationLease | null = null;
    const releaseMutationOnce = () => {
      const lease = mutationLease;
      if (lease === null) return;
      mutationLease = null;
      lease.release();
    };
    if (intentToken !== null) {
      try {
        // Runtime reconnect suppression must be live before the first teardown;
        // otherwise an already-queued alarm can reopen the old pin mid-await.
        mutationLease = deps.beginMutation();
        deps.disconnect();
      } catch {
        releaseMutationOnce();
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
          // The intent did not commit, so remove the still-valid old active pin
          // as a best-effort fallback. If storage is wholly unavailable, keep
          // this runtime suppressed; a restart cannot be claimed fail-closed.
          let fallbackCleared = false;
          try {
            await mutationLease?.drain;
            await deps.clearPairing();
            fallbackCleared = true;
          } catch {
            // The value-free result below reports that durable state is unknown.
          }
          disconnectIgnoringErrors(deps);
          if (fallbackCleared) {
            releaseMutationOnce();
            if (command.type === "agent-pairing/clear") {
              return { ok: true as const, status: { paired: false as const } };
            }
          }
          return failure("mutation-not-committed");
        }
        try {
          // Linearization point: no active fill admitted by the old pin can
          // still perform page work after this barrier resolves.
          await mutationLease?.drain;
        } catch {
          disconnectIgnoringErrors(deps);
          releaseMutationOnce();
          return failure("unavailable");
        }
        if (commandGeneration !== intentGeneration) {
          disconnectIgnoringErrors(deps);
          releaseMutationOnce();
          return failure("superseded");
        }
      }
      return dispatchAgentPairingCommand(
        deps,
        command,
        () => commandGeneration === intentGeneration,
        intentToken,
        releaseMutationOnce,
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
  releaseMutation: () => void,
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
        // A connection attempt already executing before mutation suppression
        // may have observed the old pin. Tear it down again after the
        // replacement is durable, then connect only from the verified record.
        deps.disconnect();
        // The durable active record is now bound to the current intent. Release
        // suppression immediately before the one permitted explicit connect.
        releaseMutation();
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
      releaseMutation();
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
    "mutation-not-committed": "Pairing change was not committed; retry before restarting the extension",
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
