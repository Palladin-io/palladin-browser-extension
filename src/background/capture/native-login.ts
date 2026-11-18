import { currentCaptureTop } from './document-route-runtime';
import type { CredentialCaptureSource } from './credential-coordinator';
import { activePageTab } from '../active-page-tab';
import { TAB_URL_REQUEST_CHANNEL, isTabUrlResponse } from '@shared/messaging';
import { CREDENTIAL_CAPTURE_CHANNEL } from '@shared/messaging/credential-capture';
import { FEDERATED_SIGNIN_CHANNEL } from '@shared/messaging/federated-signin';
import { isNativeLoginCaptureCommand, type NativeLoginCaptureCommand, type NativeLoginCaptureResult } from '@shared/messaging/native-login-capture';
import { SIGN_IN_PROVIDER_ACCOUNT_DOMAINS } from '@shared/signin/providers';
import { sameSignInAccount } from '@shared/signin/binding';
import { isTrustedExtensionPage, type RuntimeSenderIdentity } from '../trusted-sender';
import { isManualEntrySaveInput } from '../vault/commands';
import { browserDocumentIdForTab } from '../tab-documents';
import { credentialWriter } from '../vault/runtime';
import { federatedSignIn } from '../signin/runtime';
import { credentialCaptureCoordinator } from './credential-runtime';

/** Only extension-owned surfaces can request plaintext or submit reviewed edits. */
export function dispatchNativeLoginCapture(raw: unknown, sender: RuntimeSenderIdentity, runtimeId: string, origin: string): Promise<NativeLoginCaptureResult> | null {
  if (!isTrustedExtensionPage(sender, runtimeId, origin) || !isNativeLoginCaptureCommand(raw, isManualEntrySaveInput)) return null;
  return handle(raw);
}

async function handle(command: NativeLoginCaptureCommand): Promise<NativeLoginCaptureResult> {
  try {
    const tab = await activePageTab();
    if (tab?.id === undefined || tab.incognito) return { status: 'stale' };
    const browserDocumentId = browserDocumentIdForTab(tab.id);
    if (browserDocumentId === null) {
      const source=await currentCaptureTop(tab.id);
      return source ? handleSource(command,source) : {status:'stale'};
    }
    const response = await chrome.tabs.sendMessage(tab.id, { channel: TAB_URL_REQUEST_CHANNEL }, { documentId: browserDocumentId });
    if (!isTabUrlResponse(response) || browserDocumentIdForTab(tab.id) !== browserDocumentId) return { status: 'stale' };
    const source = { tabId: tab.id, browserDocumentId, documentId: response.documentId, url: response.url };
    return handleSource(command, source);
  } catch { return { status: 'unavailable' }; }
}
async function handleSource(command: NativeLoginCaptureCommand, source: CredentialCaptureSource, authorized: () => Promise<boolean> = async () => true): Promise<NativeLoginCaptureResult> {
  try {
    if (command.type === 'check') {
      const credential = await credentialCaptureCoordinator.dispatch({ channel: CREDENTIAL_CAPTURE_CHANNEL, documentId: source.documentId, type: 'get' }, source);
      if (credential.status === 'prompt' && credential.prompt?.state === 'ready' && credential.prompt.id === command.promptId) return { status: 'availability', available: true };
      const federated = await federatedSignIn.dispatch({ channel: FEDERATED_SIGNIN_CHANNEL, documentId: source.documentId, type: 'get' }, source);
      return { status: 'availability', available: federated.status === 'prompt' && federated.prompt?.state === 'ready' && federated.prompt.id === command.promptId };
    }
    if (command.type === 'get') {
      const credential = await credentialCaptureCoordinator.nativeReview(source, command.targetId);
      if (credential) return { status: 'review', sourceTabId: source.tabId, review: { kind: 'credential', ...credential } };
      const icon = await credentialWriter.captureIcon(source.url).catch(() => undefined);
      let federated = await federatedSignIn.dispatch({ channel: FEDERATED_SIGNIN_CHANNEL, documentId: source.documentId, type: 'get' }, source);
      const providerIcon = federated.status === 'prompt' && federated.prompt ? await credentialWriter.captureIcon(
        `https://${SIGN_IN_PROVIDER_ACCOUNT_DOMAINS[federated.prompt.provider][0]}`).catch(() => undefined) : undefined;
      if (federated.status === 'prompt' && federated.prompt) federated = await federatedSignIn.dispatch({ channel: FEDERATED_SIGNIN_CHANNEL, documentId: source.documentId, type: 'get' }, source);
      return { status: 'review', sourceTabId: source.tabId, review: federated.status === 'prompt' && federated.prompt?.state === 'ready'
        ? { kind: 'federated', prompt: federated.prompt, ...(icon ? { icon } : {}), ...(providerIcon ? { providerIcon } : {}) } : null };
    }
    if (command.type === 'save') return credentialCaptureCoordinator.nativeSave(source, command.promptId, command.targetId, command.autoUpdate, command.entry, authorized);
    if (command.type === 'confirm') {
      const result = await federatedSignIn.dispatch({ channel: FEDERATED_SIGNIN_CHANNEL, documentId: source.documentId, type: 'get' }, source);
      if (result.status !== 'prompt' || result.prompt?.id !== command.promptId) return { status: 'stale' };
      const target = result.prompt.targets.find(target => target.id === command.targetId);
      const account = result.prompt.accounts.find(account => account.id === command.accountId);
      if (!target || !account || command.entryName !== undefined && target.action !== 'create' || target.current && (target.current.provider !== result.prompt.provider
        || !sameSignInAccount(target.current.account, account.source === 'none' ? null : account.label)) && !command.replace) return { status: 'stale' };
      return federatedSignIn.dispatch({ channel: FEDERATED_SIGNIN_CHANNEL, documentId: source.documentId, type: 'confirm',
        promptId: command.promptId, targetId: command.targetId, accountId: command.accountId, locale: command.locale }, source, command.entryName?.trim(), authorized);
    }
    if (command.type === 'choose-username') return credentialCaptureCoordinator.dispatch({ ...command,
      channel: CREDENTIAL_CAPTURE_CHANNEL, documentId: source.documentId }, source);
    return command.kind === 'credential'
      ? credentialCaptureCoordinator.dispatch({ channel: CREDENTIAL_CAPTURE_CHANNEL, documentId: source.documentId, type: command.type, promptId: command.promptId }, source, authorized)
      : federatedSignIn.dispatch({ channel: FEDERATED_SIGNIN_CHANNEL, documentId: source.documentId, type: command.type, promptId: command.promptId }, source, undefined, authorized);
  } catch { return { status: 'unavailable' }; }
}

export async function matchesLoginCapture(source: CredentialCaptureSource, captureId: string): Promise<boolean> {
  const result = await handleSource({ channel: 'palladin.native-login-capture', type: 'check', promptId: captureId }, source);
  return result.status === 'availability' && result.available;
}

/** Source and operation authority are supplied by the separate capture capability boundary. */
export async function handleScopedLoginCapture(command: NativeLoginCaptureCommand, source: CredentialCaptureSource,
  captureId: string, authorized: () => Promise<boolean>): Promise<NativeLoginCaptureResult> {
  if ('promptId' in command && command.promptId !== captureId || !await authorized() || !await matchesLoginCapture(source, captureId)
    || !await authorized()) return { status: 'stale' };
  const result = await handleSource(command, source, authorized);
  if (!await authorized()) return { status: 'stale' };
  if (result.status === 'review' && result.review?.prompt.id !== captureId) return { status: 'stale' };
  if (result.status === 'prompt' && result.prompt?.id !== captureId) return { status: 'stale' };
  return result;
}
