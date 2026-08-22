import { describe, expect, it, vi } from "vitest";

import { AGENT_PAIRING_PROTOCOL } from "@shared/agent/pairing";
import type { AgentInjectionRequest } from "@shared/messaging";

import {
  createAgentPairingRuntimeHandler,
  type AgentPairingCommandDeps,
} from "./pairing-commands";
import { AgentFillMutationBarrier } from "./mutation-barrier";
import { NativePairingDiscoveryError } from "./pairing-errors";
import {
  handleNativeAgentMessage,
  type AgentProviderSession,
} from "./native-provider";

const KEY = `${"a".repeat(42)}A`;
const FINGERPRINT = `${"b".repeat(42)}Q`;
const INTENT_1 = "00000000-0000-4000-8000-000000000001";
const INTENT_2 = "00000000-0000-4000-8000-000000000002";
const BUNDLE = JSON.stringify({
  protocol: AGENT_PAIRING_PROTOCOL,
  hostSigningPublicKey: KEY,
  fingerprint: FINGERPRINT,
});
const OFFER = {
  protocol: AGENT_PAIRING_PROTOCOL,
  hostSigningPublicKey: KEY,
  fingerprint: FINGERPRINT,
} as const;

function deps(overrides: Partial<AgentPairingCommandDeps> = {}): AgentPairingCommandDeps {
  let intent = 0;
  return {
    readVerifiedPairing: vi.fn(async () => null),
    discoverPairing: vi.fn(async () => OFFER),
    deriveFingerprint: vi.fn(async () => FINGERPRINT),
    createIntentToken: vi.fn(() => [INTENT_1, INTENT_2][intent++] ?? crypto.randomUUID()),
    beginMutation: vi.fn(() => ({ drain: Promise.resolve(), release: vi.fn() })),
    savePairingIntent: vi.fn(async () => undefined),
    savePairing: vi.fn(async () => undefined),
    clearPairing: vi.fn(async () => undefined),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    ...overrides,
  };
}

function reconnectGate() {
  let generation = 0;
  let suppressed = false;
  let activePin: "old" | null = "old";
  const beginMutation = vi.fn(() => {
    const ownGeneration = ++generation;
    suppressed = true;
    return {
      drain: Promise.resolve(),
      release: () => {
        if (ownGeneration === generation) suppressed = false;
      },
    };
  });
  const disconnect = vi.fn(() => { activePin = null; });
  const attemptReconnect = vi.fn(() => {
    if (!suppressed) activePin = "old";
  });
  const attemptInject = vi.fn(() => !suppressed && activePin === "old");
  return {
    beginMutation,
    disconnect,
    attemptReconnect,
    attemptInject,
    activePin: () => activePin,
    suppressed: () => suppressed,
  };
}

describe("Agent pairing popup commands", () => {
  it("discovers a public offer without mutating or disconnecting pairing state", async () => {
    const effects = deps();
    const handle = createAgentPairingRuntimeHandler(effects);

    await expect(handle({ type: "agent-pairing/discover" }))
      .resolves.toEqual({ ok: true, offer: OFFER });
    expect(effects.discoverPairing).toHaveBeenCalledOnce();
    expect(effects.beginMutation).not.toHaveBeenCalled();
    expect(effects.savePairingIntent).not.toHaveBeenCalled();
    expect(effects.savePairing).not.toHaveBeenCalled();
    expect(effects.disconnect).not.toHaveBeenCalled();
  });

  it("preserves a value-free native discovery failure code", async () => {
    const effects = deps({
      discoverPairing: vi.fn(async () => {
        throw new NativePairingDiscoveryError("host-not-found");
      }),
    });
    const handle = createAgentPairingRuntimeHandler(effects);

    await expect(handle({ type: "agent-pairing/discover" })).resolves.toEqual({
      ok: false,
      code: "native-host-not-found",
      message: "The native messaging host is not registered",
    });
  });

  it("persists the verified public pin bound to its durable intent, then connects", async () => {
    const effects = deps();
    const handle = createAgentPairingRuntimeHandler(effects);
    await expect(handle({
      type: "agent-pairing/save",
      pairingBundle: BUNDLE,
      confirmed: true,
    })).resolves.toEqual({ ok: true, status: { paired: true, fingerprint: FINGERPRINT } });

    expect(effects.savePairing).toHaveBeenCalledWith({
      hostSigningPublicKey: KEY,
      fingerprint: FINGERPRINT,
      intentToken: INTENT_1,
    });
    expect(effects.savePairingIntent).toHaveBeenCalledWith(INTENT_1);
    expect(vi.mocked(effects.beginMutation).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(effects.disconnect).mock.invocationCallOrder[0]!);
    expect(vi.mocked(effects.savePairingIntent).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(effects.deriveFingerprint).mock.invocationCallOrder[0]!);
    expect(effects.disconnect).toHaveBeenCalledTimes(2);
    expect(effects.connect).toHaveBeenCalledOnce();
  });

  it("drops an old-pin alarm reconnect before connecting the durable replacement", async () => {
    let releaseDerive: ((fingerprint: string) => void) | undefined;
    let durablePin: "old" | "new" = "old";
    let activePin: "old" | "new" | null = "old";
    const deriveFingerprint = vi.fn(() => new Promise<string>((resolve) => {
      releaseDerive = resolve;
    }));
    const disconnect = vi.fn(() => { activePin = null; });
    const savePairing = vi.fn(async () => { durablePin = "new"; });
    const connect = vi.fn(async () => {
      if (activePin === null) activePin = durablePin;
    });
    const effects = deps({ deriveFingerprint, disconnect, savePairing, connect });
    const handle = createAgentPairingRuntimeHandler(effects);

    const pairing = handle({
      type: "agent-pairing/save",
      pairingBundle: BUNDLE,
      confirmed: true,
    });
    await vi.waitFor(() => expect(deriveFingerprint).toHaveBeenCalledOnce());
    // Simulate an alarm event already queued before alarms.clear completing.
    activePin = "old";
    releaseDerive?.(FINGERPRINT);

    await expect(pairing).resolves.toEqual({
      ok: true,
      status: { paired: true, fingerprint: FINGERPRINT },
    });
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(savePairing).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(activePin).toBe("new");
  });

  it("rejects a mismatched fingerprint and tears down an alarm reconnect", async () => {
    let releaseDerive: ((fingerprint: string) => void) | undefined;
    const gate = reconnectGate();
    const deriveFingerprint = vi.fn(() => new Promise<string>((resolve) => {
      releaseDerive = resolve;
    }));
    const effects = deps({
      deriveFingerprint,
      beginMutation: gate.beginMutation,
      disconnect: gate.disconnect,
    });
    const handle = createAgentPairingRuntimeHandler(effects);
    const pairing = handle({
      type: "agent-pairing/save",
      pairingBundle: BUNDLE,
      confirmed: true,
    });
    await vi.waitFor(() => expect(deriveFingerprint).toHaveBeenCalledOnce());
    gate.attemptReconnect();
    expect(gate.activePin()).toBeNull();
    expect(gate.attemptInject()).toBe(false);
    expect(gate.suppressed()).toBe(true);
    releaseDerive?.(`${"c".repeat(42)}g`);
    const result = await pairing;

    expect(result).toEqual({
      ok: false,
      code: "fingerprint-mismatch",
      message: "Pairing fingerprint does not match the host public key",
    });
    expect(effects.savePairing).not.toHaveBeenCalled();
    expect(effects.connect).not.toHaveBeenCalled();
    expect(effects.disconnect).toHaveBeenCalledTimes(2);
    expect(gate.activePin()).toBeNull();
    expect(gate.suppressed()).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("rejects malformed commands and bundles with value-free errors", async () => {
    const effects = deps();
    const handle = createAgentPairingRuntimeHandler(effects);
    const malformed = await handle({
      type: "agent-pairing/save",
      pairingBundle: `${BUNDLE}private-value`,
      confirmed: true,
      extra: true,
    });
    expect(malformed).toEqual({
      ok: false,
      code: "invalid-bundle",
      message: "Pairing bundle is invalid",
    });
    expect(JSON.stringify(malformed)).not.toContain("private-value");
    expect(effects.deriveFingerprint).not.toHaveBeenCalled();
    expect(effects.savePairing).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation at the worker boundary", async () => {
    const effects = deps();
    const handle = createAgentPairingRuntimeHandler(effects);
    const result = await handle({
      type: "agent-pairing/save",
      pairingBundle: BUNDLE,
      confirmed: false,
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-bundle" });
    expect(effects.savePairing).not.toHaveBeenCalled();
  });

  it("disconnects before durable clear and drops an old-pin alarm reconnect afterward", async () => {
    let releaseClear: (() => void) | undefined;
    let activePin: "old" | null = "old";
    const clearPairing = vi.fn(() => new Promise<void>((resolve) => {
      releaseClear = resolve;
    }));
    const disconnect = vi.fn(() => { activePin = null; });
    const effects = deps({ clearPairing, disconnect });
    const handle = createAgentPairingRuntimeHandler(effects);

    const clearing = handle({ type: "agent-pairing/clear" });
    expect(effects.disconnect).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(clearPairing).toHaveBeenCalledOnce());
    // Simulate an alarm event queued before alarms.clear completed.
    activePin = "old";
    releaseClear?.();
    await expect(clearing).resolves.toEqual({ ok: true, status: { paired: false } });
    expect(effects.disconnect).toHaveBeenCalledTimes(2);
    expect(activePin).toBeNull();
  });

  it("always stays disconnected when durable clear fails", async () => {
    const effects = deps();
    const handle = createAgentPairingRuntimeHandler(effects);
    await expect(handle({ type: "agent-pairing/clear" }))
      .resolves.toEqual({ ok: true, status: { paired: false } });
    expect(effects.clearPairing).toHaveBeenCalledOnce();
    expect(effects.disconnect).toHaveBeenCalledTimes(2);

    let rejectClear: ((reason?: unknown) => void) | undefined;
    const gate = reconnectGate();
    const clearPairing = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectClear = reject;
    }));
    const failing = deps({
      clearPairing,
      beginMutation: gate.beginMutation,
      disconnect: gate.disconnect,
    });
    const handleFailing = createAgentPairingRuntimeHandler(failing);
    const failedClear = handleFailing({ type: "agent-pairing/clear" });
    await vi.waitFor(() => expect(clearPairing).toHaveBeenCalledOnce());
    gate.attemptReconnect();
    expect(gate.activePin()).toBeNull();
    expect(gate.attemptInject()).toBe(false);
    expect(gate.suppressed()).toBe(true);
    rejectClear?.(new Error("storage"));

    await expect(failedClear)
      .resolves.toMatchObject({ ok: false, code: "unavailable" });
    expect(failing.disconnect).toHaveBeenCalledTimes(2);
    expect(gate.activePin()).toBeNull();
    expect(gate.suppressed()).toBe(false);
  });

  it("completes Clear through active-pin removal when the intent write fails", async () => {
    let rejectIntent: ((reason?: unknown) => void) | undefined;
    let storedActivePin = true;
    const gate = reconnectGate();
    const savePairingIntent = vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectIntent = reject;
    }));
    const effects = deps({
      savePairingIntent,
      beginMutation: gate.beginMutation,
      disconnect: gate.disconnect,
      clearPairing: vi.fn(async () => { storedActivePin = false; }),
    });
    const handle = createAgentPairingRuntimeHandler(effects);

    const clearing = handle({ type: "agent-pairing/clear" });
    expect(gate.disconnect).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(savePairingIntent).toHaveBeenCalledOnce());
    gate.attemptReconnect();
    expect(gate.activePin()).toBeNull();
    expect(gate.attemptInject()).toBe(false);
    rejectIntent?.(new Error(`storage ${KEY}`));
    const result = await clearing;

    expect(result).toEqual({ ok: true, status: { paired: false } });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(effects.clearPairing).toHaveBeenCalledOnce();
    expect(effects.disconnect).toHaveBeenCalledTimes(2);
    expect(gate.activePin()).toBeNull();
    expect(gate.suppressed()).toBe(false);
    expect(storedActivePin).toBe(false);
  });

  it("fails Pair but leaves storage unpaired when fallback active-pin removal succeeds", async () => {
    let storedActivePin = true;
    const gate = reconnectGate();
    const effects = deps({
      beginMutation: gate.beginMutation,
      disconnect: gate.disconnect,
      savePairingIntent: vi.fn(async () => { throw new Error("intent storage"); }),
      clearPairing: vi.fn(async () => { storedActivePin = false; }),
    });
    const handle = createAgentPairingRuntimeHandler(effects);

    const result = await handle({
      type: "agent-pairing/save",
      pairingBundle: BUNDLE,
      confirmed: true,
    });

    expect(result).toEqual({
      ok: false,
      code: "mutation-not-committed",
      message: "Pairing change was not committed; retry before restarting the extension",
    });
    expect(effects.clearPairing).toHaveBeenCalledOnce();
    expect(effects.savePairing).not.toHaveBeenCalled();
    expect(effects.connect).not.toHaveBeenCalled();
    expect(storedActivePin).toBe(false);
    expect(gate.suppressed()).toBe(false);
  });

  it("fails clearly and stays suppressed when intent and fallback clear both fail", async () => {
    const gate = reconnectGate();
    const effects = deps({
      beginMutation: gate.beginMutation,
      disconnect: gate.disconnect,
      savePairingIntent: vi.fn(async () => { throw new Error("intent storage"); }),
      clearPairing: vi.fn(async () => { throw new Error("active storage"); }),
    });
    const handle = createAgentPairingRuntimeHandler(effects);

    const result = await handle({ type: "agent-pairing/clear" });

    expect(result).toEqual({
      ok: false,
      code: "mutation-not-committed",
      message: "Pairing change was not committed; retry before restarting the extension",
    });
    expect(effects.clearPairing).toHaveBeenCalledOnce();
    expect(effects.disconnect).toHaveBeenCalledTimes(2);
    expect(gate.suppressed()).toBe(true);
    gate.attemptReconnect();
    expect(gate.activePin()).toBeNull();
    expect(gate.attemptInject()).toBe(false);
  });

  it("drains an already-dispatched Inject before Clear commits and succeeds", async () => {
    const barrier = new AgentFillMutationBarrier();
    let releaseStep: (() => void) | undefined;
    let clearCompleted = false;
    let rejectedOldWrites = 0;
    const page = {
      id: 7,
      page: { url: "https://login.example.com", documentId: "d".repeat(32) },
    };
    const sendStep = vi.fn(() => new Promise<{ readonly ok: true }>((resolve) => {
      releaseStep = () => resolve({ ok: true });
    }));
    const request: AgentInjectionRequest = {
      protocol: "palladin.inject-provider.v1",
      type: "inject",
      transactionId: "tx-linearized-clear",
      grantId: "grant-1",
      entryId: "entry-1",
      expectedDomain: "login.example.com",
      form: {
        version: 1,
        steps: [{
          fields: [{
            entryFieldId: "credential.password",
            selector: "#password",
            control: "password",
          }],
          submit: { action: "click", selector: "#submit" },
        }],
      },
      values: [{
        entryFieldId: "credential.password",
        value: "synthetic-password-value",
      }],
    };
    const session: AgentProviderSession = {
      prepared: { tabId: 7, documentId: "d".repeat(32) },
    };
    const fill = barrier.admit(() => handleNativeAgentMessage(
      {
        getActivePage: vi.fn(async () => page),
        sendStep,
        probeTransition: vi.fn(async () => ({ status: "ready" } as const)),
      },
      { consume: vi.fn(async () => true) },
      session,
      request,
    ));
    expect(fill).not.toBeNull();
    await vi.waitFor(() => expect(sendStep).toHaveBeenCalledOnce());

    const clearPairing = vi.fn(async () => { clearCompleted = true; });
    const effects = deps({
      beginMutation: vi.fn(() => barrier.beginMutation()),
      clearPairing,
    });
    const handle = createAgentPairingRuntimeHandler(effects);
    let commandResolved = false;
    const clearing = handle({ type: "agent-pairing/clear" }).then((result) => {
      commandResolved = true;
      return result;
    });
    await vi.waitFor(() => expect(effects.savePairingIntent).toHaveBeenCalledOnce());

    expect(barrier.isBlocked).toBe(true);
    expect(clearPairing).not.toHaveBeenCalled();
    expect(commandResolved).toBe(false);
    const rejectedOldFill = barrier.admit(async () => { rejectedOldWrites += 1; });
    expect(rejectedOldFill).toBeNull();

    releaseStep?.();
    await expect(fill).resolves.toMatchObject({ outcome: "injected" });
    expect(request.values[0]?.value).toBe("");
    await expect(clearing).resolves.toEqual({ ok: true, status: { paired: false } });
    expect(clearCompleted).toBe(true);
    expect(rejectedOldWrites).toBe(0);
    expect(barrier.isBlocked).toBe(false);
  });

  it("lets a later clear cancel a save suspended in fingerprint derivation", async () => {
    let releaseDerive: ((fingerprint: string) => void) | undefined;
    const deriveFingerprint = vi.fn(() => new Promise<string>((resolve) => {
      releaseDerive = resolve;
    }));
    const effects = deps({ deriveFingerprint });
    const handle = createAgentPairingRuntimeHandler(effects);

    const pairing = handle({
      type: "agent-pairing/save",
      pairingBundle: BUNDLE,
      confirmed: true,
    });
    await vi.waitFor(() => expect(deriveFingerprint).toHaveBeenCalledOnce());
    const clearing = handle({ type: "agent-pairing/clear" });
    expect(effects.disconnect).toHaveBeenCalledTimes(2);

    releaseDerive?.(FINGERPRINT);
    await expect(pairing).resolves.toMatchObject({ ok: false, code: "superseded" });
    await expect(clearing).resolves.toEqual({ ok: true, status: { paired: false } });
    expect(effects.savePairing).not.toHaveBeenCalled();
    expect(effects.connect).not.toHaveBeenCalled();
    expect(effects.clearPairing).toHaveBeenCalledOnce();
  });

  it("compensates a stale pin written while a later clear is waiting in the FIFO", async () => {
    let releaseSave: (() => void) | undefined;
    let releaseCompensatingClear: (() => void) | undefined;
    let persistedIntent: string | null = null;
    let stored: { readonly intentToken: string } | null = null;
    const savePairingIntent = vi.fn(async (intentToken: string) => {
      persistedIntent = intentToken;
    });
    const savePairing = vi.fn((record: { readonly intentToken: string }) => new Promise<void>((resolve) => {
      releaseSave = () => {
        stored = record;
        resolve();
      };
    }));
    const clearPairing = vi.fn(() => {
      if (clearPairing.mock.calls.length === 1) {
        return new Promise<void>((resolve) => {
          releaseCompensatingClear = () => {
            stored = null;
            resolve();
          };
        });
      }
      stored = null;
      return Promise.resolve();
    });
    const effects = deps({ savePairingIntent, savePairing, clearPairing });
    const handle = createAgentPairingRuntimeHandler(effects);

    const pairing = handle({
      type: "agent-pairing/save",
      pairingBundle: BUNDLE,
      confirmed: true,
    });
    await vi.waitFor(() => expect(savePairing).toHaveBeenCalledOnce());
    const clearing = handle({ type: "agent-pairing/clear" });
    await vi.waitFor(() => expect(savePairingIntent).toHaveBeenCalledTimes(2));
    expect(persistedIntent).toBe(INTENT_2);
    releaseSave?.();
    await vi.waitFor(() => expect(clearPairing).toHaveBeenCalledOnce());

    // Simulate a worker restart after the stale active record lands but before
    // best-effort cleanup. The durable intent mismatch keeps it fail-closed.
    const restartRecord = stored as unknown as { readonly intentToken: string } | null;
    expect(restartRecord?.intentToken).toBe(INTENT_1);
    expect(restartRecord?.intentToken === persistedIntent).toBe(false);

    releaseCompensatingClear?.();

    await expect(pairing).resolves.toMatchObject({ ok: false, code: "superseded" });
    await expect(clearing).resolves.toEqual({ ok: true, status: { paired: false } });
    expect(effects.connect).not.toHaveBeenCalled();
    expect(clearPairing).toHaveBeenCalledTimes(2);
    expect(stored).toBeNull();
  });

  it("reports only verified persisted status", async () => {
    const record = { hostSigningPublicKey: KEY, fingerprint: FINGERPRINT, intentToken: INTENT_1 };
    const effects = deps({ readVerifiedPairing: vi.fn(async () => record) });
    const handle = createAgentPairingRuntimeHandler(effects);
    await expect(handle({ type: "agent-pairing/status" }))
      .resolves.toEqual({ ok: true, status: { paired: true, fingerprint: FINGERPRINT } });
  });
});
