import type { SharedUnlockEnvelope } from "@palladin/crypto";
import { createSharedUnlockSourceCrypto } from "../../shared/crypto/shared-unlock-source";
import type { SessionManager } from "../session/session-manager";
import type { SharedUnlockSourceSession } from "../session/shared-unlock-source";
import { unlockDeadline } from "../session/shared-unlock-install";
import { SharedUnlockApi, SharedUnlockApiError } from "./api";
import type { SharedUnlockOperation } from "./api-types";
import { sharedUnlockOperationMessage } from "./operation-message";
import type { SharedUnlockReceiverRoute } from "./receiver";
import type { SharedUnlockSourceAuthority } from "./source-authority";

/** Account/link/preference and browser authority must be established independently
 * of the offered operation. Source generation survives browser Port replacement. */
export type SharedUnlockSourceRoute = SharedUnlockReceiverRoute;

export async function beginSharedUnlockSource(route: SharedUnlockSourceRoute, manager: SessionManager,
  authority: SharedUnlockSourceAuthority, api: SharedUnlockApi) {
  const binding = { ...route.binding };
  const apiUrl = route.apiUrl;
  let own: SharedUnlockSourceSession | null = manager.captureSharedUnlockSource();
  const ownSignal = own.signal;
  const initial = authority.snapshot();
  const root = initial.authorization;
  const abort = new AbortController();
  let crypto: Awaited<ReturnType<typeof createSharedUnlockSourceCrypto>> | null = null;
  let started = false;
  let release = () => {};
  const deadline = Date.now() + 30_000;
  const cancel = () => {
    if (abort.signal.aborted) return;
    release();
    abort.abort();
    own?.dispose();
    own = null;
    crypto?.dispose();
  };
  function reject(): never { throw new SharedUnlockApiError("cancelled"); }
  const assertCurrent = () => {
    if (abort.signal.aborted || route.signal.aborted || !own || !root || Date.now() >= deadline) reject();
    route.assertCurrent();
    const session = own.read();
    const current = authority.snapshot();
    if (session.tokens.apiUrl !== apiUrl || session.tokens.userId !== binding.accountId
      || root.accountId !== binding.accountId || root.organizationId !== binding.organizationId
      || Date.now() >= unlockDeadline(session.limits)
      || current.authorization?.authorizationId !== root.authorizationId || current.authorization.sequence !== root.sequence
      || current.authorization.accountId !== root.accountId || current.authorization.organizationId !== root.organizationId
      || current.authorization.authorizationVersion !== root.authorizationVersion
      || current.authorization.credentialRevision !== root.credentialRevision
      || current.authorization.privateKeyWrapRevision !== root.privateKeyWrapRevision
      || current.sourceGeneration !== binding.extensionGeneration || initial.sourceGeneration !== binding.extensionGeneration
      || current.preference?.sharedUnlockEnabled !== true || current.preference.revision !== binding.preferenceRevision
      || Date.now() >= unlockDeadline(root)) reject();
    if (abort.signal.aborted || route.signal.aborted) reject();
    own.read();
  };
  const timeout = setTimeout(cancel, 30_000);
  route.signal.addEventListener("abort", cancel, { once: true });
  ownSignal.addEventListener("abort", cancel, { once: true });
  release = () => {
    clearTimeout(timeout);
    route.signal.removeEventListener("abort", cancel);
    ownSignal.removeEventListener("abort", cancel);
  };
  const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, rejectWait) => {
    const cancelled = () => rejectWait(new SharedUnlockApiError("cancelled"));
    if (abort.signal.aborted) cancelled();
    else abort.signal.addEventListener("abort", cancelled, { once: true });
    promise.then(resolve, rejectWait).finally(() => abort.signal.removeEventListener("abort", cancelled));
  });
  try { assertCurrent(); crypto = await createSharedUnlockSourceCrypto(assertCurrent); assertCurrent(); }
  catch (error) { cancel(); throw error; }
  const source = crypto;
  return {
    publicKey: source.publicKey,
    cancel,
    async send(input: { readonly recipientPublicKey: string; readonly recipientProofPublicKey: string;
      verifyRecipient(): Promise<void>;
      send(packet: { operation: SharedUnlockOperation; envelope: SharedUnlockEnvelope }): void;
    }) {
      if (started) throw new SharedUnlockApiError("conflict");
      started = true;
      const recipient = { publicKey: input.recipientPublicKey, proofPublicKey: input.recipientProofPublicKey };
      const verifyRecipient = input.verifyRecipient;
      const send = input.send;
      try {
        assertCurrent();
        if (!own || !root) reject();
        const session = own.read();
        const operation = sharedUnlockOperationMessage(await wait(api.createOperation(session.tokens, {
          authorizationId: root.authorizationId, linkId: binding.linkId, linkEpoch: binding.linkEpoch,
          expectedPreferenceRevision: binding.preferenceRevision, recipientOrganizationId: binding.organizationId,
          idleDeadlineMs: session.limits.idleDeadlineMs, absoluteDeadlineMs: session.limits.absoluteDeadlineMs,
          offlineDeadlineMs: session.limits.offlineDeadlineMs, direction: "extension-to-web", apiOrigin: binding.apiOrigin,
          webOrigin: binding.webOrigin, extensionId: binding.extensionId, documentBinding: binding.documentBinding,
          webGeneration: binding.webGeneration, extensionGeneration: binding.extensionGeneration,
          sourcePublicKey: source.publicKey, recipientPublicKey: recipient.publicKey, recipientProofPublicKey: recipient.proofPublicKey,
        }, abort.signal)));
        assertCurrent();
        const context = operation.context;
        if (context.direction !== "extension-to-web" || context.apiOrigin !== new URL(apiUrl).origin
          || context.authorizationVersion !== root.authorizationVersion) reject();
        for (const key of Object.keys(binding) as (keyof typeof binding)[]) if (context[key] !== binding[key]) reject();
        const envelope = await source.seal(operation, recipient, session.keys.masterKey, session.keys.privateKey);
        assertCurrent();
        await wait(verifyRecipient());
        assertCurrent();
        send({ operation, envelope });
        return { operationId: context.operationId, webGeneration: binding.webGeneration,
          extensionGeneration: binding.extensionGeneration };
      } finally { cancel(); }
    },
  };
}
