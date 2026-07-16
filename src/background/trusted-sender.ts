export interface RuntimeSenderIdentity {
  readonly id?: string | undefined;
  readonly url?: string | undefined;
  readonly tab?: unknown | undefined;
}

/** Only extension-owned pages may invoke popup/offscreen command dispatchers. */
export function isTrustedExtensionPage(
  sender: RuntimeSenderIdentity,
  runtimeId: string,
  extensionOrigin: string,
): boolean {
  return (
    sender.id === runtimeId &&
    sender.tab === undefined &&
    sender.url?.startsWith(extensionOrigin) === true
  );
}
