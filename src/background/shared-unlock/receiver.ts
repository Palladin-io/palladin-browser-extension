import { wipe, type SharedUnlockContext } from "@palladin/crypto";
import { createSharedUnlockReceiverCrypto } from "../../shared/crypto/shared-unlock-receiver";
import type { SessionManager } from "../session/session-manager";
import type { SharedUnlockInstaller } from "../session/shared-unlock-install";
import type { SessionKeys } from "../session/types";
import { SharedUnlockApi, SharedUnlockApiError } from "./api";
import type { SharedUnlockAuthorization, SharedUnlockCommit, SharedUnlockOperation } from "./api-types";

/** Browser/document + selected account and local-link authority, established
 * independently of the operation/envelope. OFF, revoke, navigation and peer
 * loss invalidate the signal and synchronous fence. */
export interface SharedUnlockReceiverRoute {
  readonly apiUrl: string;
  readonly signal: AbortSignal;
  readonly binding: Pick<SharedUnlockContext, "accountId" | "organizationId" | "apiOrigin" | "webOrigin"
    | "extensionId" | "documentBinding" | "webGeneration" | "extensionGeneration" | "linkId" | "linkEpoch" | "preferenceRevision">;
  assertCurrent(): void;
  assertFreshAuthorization?(sequence: number, deadlineMs: number): Promise<void | number>;
}

/** Internal inherited-authority metadata, never a wire ACK. */
export interface SharedUnlockReceived {
  readonly operationId: string;
  readonly authorizationId: string;
  readonly authorizationSequence: number;
}

export interface SharedUnlockAcknowledgement {
  readonly operationId: string;
  readonly webGeneration: string;
  readonly extensionGeneration: string;
}

export type SharedUnlockInstalled = (authorization: SharedUnlockAuthorization, generation: string, assertOwnCurrent: () => void) => void;

export async function beginSharedUnlockReceiver(route: SharedUnlockReceiverRoute,
  manager: SessionManager, api: SharedUnlockApi, onInstalled?: SharedUnlockInstalled) {
  const apiUrl = route.apiUrl;
  const binding = { ...route.binding };
  const abort = new AbortController();
  const deadline = Date.now() + 30_000;
  let closed = false;
  let started = false;
  let installer: SharedUnlockInstaller | null = null;
  let receiver: Awaited<ReturnType<typeof createSharedUnlockReceiverCrypto>> | null = null;
  let keys: SessionKeys | null = null;
  let issued: SharedUnlockCommit | null = null;
  let cleanup: Promise<void> | null = null;
  const reject = () => { throw new SharedUnlockApiError("cancelled"); };
  const assertRouteCurrent = () => {
    if (closed || abort.signal.aborted || route.signal.aborted || Date.now() >= deadline) reject();
    route.assertCurrent();
    if (closed || abort.signal.aborted || route.signal.aborted || Date.now() >= deadline) reject();
  };
  const assertCurrent = () => { assertRouteCurrent(); installer?.assertCurrent(); };
  const assertBinding = (context: SharedUnlockContext) => {
    assertCurrent();
    if (context.direction !== "web-to-extension" || context.apiOrigin !== new URL(apiUrl).origin) reject();
    for (const key of Object.keys(binding) as (keyof typeof binding)[]) if (context[key] !== binding[key]) reject();
  };
  const revoke = () => {
    if (issued && !installer?.completed && !cleanup) cleanup = api.revokeIssuedSession(apiUrl, issued.session.refreshToken);
    return cleanup ?? Promise.resolve();
  };
  let release = () => {};
  const cancel = () => {
    // The install promise can settle after peer loss. Its synchronous completion
    // fact, not continuation order or delivery of ACK, decides session ownership.
    if (closed || installer?.completed) return;
    closed = true;
    release();
    abort.abort();
    installer?.cancel();
    receiver?.dispose();
    if (keys) { wipe(keys.masterKey); wipe(keys.privateKey); }
    void revoke();
  };
  const timeout = setTimeout(cancel, 30_000);
  route.signal.addEventListener("abort", cancel, { once: true });
  release = () => {
    clearTimeout(timeout);
    route.signal.removeEventListener("abort", cancel);
    installer?.signal.removeEventListener("abort", cancel);
  };
  const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, rejectWait) => {
    const cancelled = () => rejectWait(new SharedUnlockApiError("cancelled"));
    if (abort.signal.aborted) cancelled();
    else abort.signal.addEventListener("abort", cancelled, { once: true });
    promise.then(resolve, rejectWait).finally(() => abort.signal.removeEventListener("abort", cancelled));
  });
  try {
    assertRouteCurrent();
    // If cancellation wins while storage reads are pending, the late installer
    // has no keys and is explicitly retired before its handle can escape.
    installer = await wait<SharedUnlockInstaller>(manager.beginSharedUnlockInstall(binding.accountId, apiUrl, assertRouteCurrent)
      .then(value => { if (closed) value.cancel(); return value; }));
    installer.signal.addEventListener("abort", cancel, { once: true });
    assertCurrent();
    receiver = await createSharedUnlockReceiverCrypto(assertCurrent);
    assertCurrent();
  } catch (error) { cancel(); throw error; }
  const cryptoReceiver = receiver;
  return {
    publicKey: cryptoReceiver.publicKey,
    proofPublicKey: cryptoReceiver.proofPublicKey,
    cancel,
    async receive(input: {
      operation: SharedUnlockOperation;
      verifiedSourcePublicKey: string;
      envelope(signal: AbortSignal): Promise<unknown>;
      acknowledge(result: SharedUnlockAcknowledgement): void;
    }): Promise<SharedUnlockReceived> {
      if (started) throw new SharedUnlockApiError("conflict");
      started = true;
      try {
        assertCurrent();
        const offered = { ...input.operation, context: { ...input.operation.context } };
        assertBinding(offered.context);
        const signature = await cryptoReceiver.consumeProof(offered, input.verifiedSourcePublicKey);
        assertCurrent();
        const consumed = await wait(api.consume(apiUrl, offered.context.operationId, signature, abort.signal));
        assertBinding(consumed.context);
        await cryptoReceiver.acceptIdentity(consumed);
        assertCurrent();
        const envelope = await wait(input.envelope(abort.signal));
        assertCurrent();
        keys = await cryptoReceiver.open(envelope);
        assertCurrent();
        const commit = await wait(api.commit(apiUrl, consumed.context.operationId, cryptoReceiver.commitProof(), abort.signal, response => {
          issued = response;
          if (closed) void revoke().then(() => { if (issued === response) issued = null; });
        }));
        assertCurrent();
        await cryptoReceiver.verifyCommit(commit.context);
        assertBinding(commit.context);
        const ownedKeys = keys;
        keys = null; // The installer now owns and wipes on every failure.
        const descriptor = consumed.keyContext;
        // Do not race cancellation against storage rollback: install owns the
        // buffers and must finish its guarded local cleanup before we return.
        await installer!.install({
          tokens: { apiUrl, userId: commit.session.userId,
            accessToken: commit.session.accessToken, refreshToken: commit.session.refreshToken },
          material: { accountId: descriptor.accountId, encryptedPrivateKey: descriptor.encryptedPrivateKey,
            kdf: { securityVersion: descriptor.securityVersion, minimumSecurityVersion: descriptor.minimumSecurityVersion,
              profileId: descriptor.kdfProfileId, kdfSalt: descriptor.kdfSalt } },
          checkpoint: async deadlineMs => {
            const persisted = await wait(route.assertFreshAuthorization?.(commit.authorizationSequence, deadlineMs) ?? Promise.resolve());
            assertCurrent();
            return persisted ?? deadlineMs;
          },
          keys: ownedKeys, limits: { unlockedAtMs: commit.context.unlockedAtMs,
            idleDeadlineMs: commit.context.idleDeadlineMs, absoluteDeadlineMs: commit.context.absoluteDeadlineMs,
            offlineDeadlineMs: commit.context.offlineDeadlineMs },
        });
        const result = { operationId: commit.context.operationId,
          authorizationId: commit.authorizationId, authorizationSequence: commit.authorizationSequence };
        // Verified own receiver root remains usable independently of the Port.

        try {
          onInstalled?.({ authorizationId: commit.authorizationId, sequence: commit.authorizationSequence,
            accountId: binding.accountId, organizationId: binding.organizationId,
            credentialRevision: consumed.keyContext.credentialRevision, privateKeyWrapRevision: consumed.keyContext.privateKeyWrapRevision,
            authorizationVersion: commit.context.authorizationVersion, unlockedAtMs: commit.context.unlockedAtMs,
            idleDeadlineMs: commit.context.idleDeadlineMs, absoluteDeadlineMs: commit.context.absoluteDeadlineMs,
            offlineDeadlineMs: commit.context.offlineDeadlineMs }, binding.extensionGeneration, () => {
            if (manager.getKeys() !== ownedKeys || !manager.getSharedUnlockLimits()) throw new SharedUnlockApiError("cancelled");
          });
        } catch { /* Failed sharing adoption does not revoke a completed own session. */ }
        // Installation already checked the final route and local generation.
        // Closing the peer afterwards cannot revoke this independent session.
        try { input.acknowledge({ operationId: result.operationId,
          webGeneration: binding.webGeneration, extensionGeneration: binding.extensionGeneration }); }
        catch { /* Best effort, no retry/deferred ACK or group action. */ }
        return result;
      } finally {
        if (keys) { wipe(keys.masterKey); wipe(keys.privateKey); keys = null; }
        cryptoReceiver.dispose();
        release();
        if (!installer?.completed) { cancel(); await revoke(); }
        issued = null;
      }
    },
  };
}
