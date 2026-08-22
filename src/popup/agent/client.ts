/** Typed popup client for the extension-owned Agent runtime pairing screen. */

import {
  isCanonicalBase64Url32,
  parseAgentPairingBundleValue,
  type AgentPairingBundle,
  type AgentPairingStatus,
} from "@shared/agent/pairing";

import type {
  AgentPairingCommand,
  AgentPairingCommandResult,
  AgentPairingErrorCode,
} from "../../background/agent/pairing-commands";

export interface AgentPairingClient {
  getStatus(): Promise<AgentPairingStatus>;
  discover(): Promise<AgentPairingBundle>;
  save(pairingBundle: string): Promise<AgentPairingStatus>;
  clear(): Promise<AgentPairingStatus>;
}

export class AgentPairingClientError extends Error {
  constructor(readonly code: AgentPairingErrorCode) {
    super("Agent runtime pairing command failed");
    this.name = "AgentPairingClientError";
  }
}

export type AgentPairingSend = (
  command: AgentPairingCommand,
) => Promise<AgentPairingCommandResult | undefined>;

const chromeSend: AgentPairingSend = (command) =>
  chrome.runtime.sendMessage(command) as Promise<AgentPairingCommandResult | undefined>;

export function createAgentPairingClient(
  send: AgentPairingSend = chromeSend,
): AgentPairingClient {
  return {
    getStatus: () => dispatchStatus(send, { type: "agent-pairing/status" }),
    discover: () => dispatchOffer(send, { type: "agent-pairing/discover" }),
    save: (pairingBundle) => dispatchStatus(send, {
      type: "agent-pairing/save",
      pairingBundle,
      confirmed: true,
    }),
    clear: () => dispatchStatus(send, { type: "agent-pairing/clear" }),
  };
}

async function sendCommand(
  send: AgentPairingSend,
  command: AgentPairingCommand,
): Promise<AgentPairingCommandResult> {
  let raw: AgentPairingCommandResult | undefined;
  try {
    raw = await send(command);
  } catch {
    throw new AgentPairingClientError("unavailable");
  }
  if (!isAgentPairingResult(raw)) throw new AgentPairingClientError("unavailable");
  if (!raw.ok) throw new AgentPairingClientError(raw.code);
  return raw;
}

async function dispatchStatus(
  send: AgentPairingSend,
  command: AgentPairingCommand,
): Promise<AgentPairingStatus> {
  const raw = await sendCommand(send, command);
  if (!("status" in raw)) throw new AgentPairingClientError("unavailable");
  return raw.status;
}

async function dispatchOffer(
  send: AgentPairingSend,
  command: AgentPairingCommand,
): Promise<AgentPairingBundle> {
  const raw = await sendCommand(send, command);
  if (!("offer" in raw)) throw new AgentPairingClientError("unavailable");
  return raw.offer;
}

function isAgentPairingResult(value: unknown): value is AgentPairingCommandResult {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (value.ok) {
    return (exactKeys(value, ["ok", "status"])
      && isAgentPairingStatus(value.status))
      || (exactKeys(value, ["ok", "offer"])
        && parseAgentPairingBundleValue(value.offer) !== null);
  }
  return exactKeys(value, ["ok", "code", "message"])
    && isAgentPairingErrorCode(value.code)
    && typeof value.message === "string";
}

function isAgentPairingStatus(value: unknown): value is AgentPairingStatus {
  if (!isRecord(value) || typeof value.paired !== "boolean") return false;
  if (!value.paired) return exactKeys(value, ["paired"]);
  return exactKeys(value, ["paired", "fingerprint"])
    && isCanonicalBase64Url32(value.fingerprint);
}

function isAgentPairingErrorCode(value: unknown): value is AgentPairingErrorCode {
  return value === "invalid-bundle"
    || value === "fingerprint-mismatch"
    || value === "mutation-not-committed"
    || value === "superseded"
    || value === "unavailable";
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
