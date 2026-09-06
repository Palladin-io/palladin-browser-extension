import { TAB_URL_REQUEST_CHANNEL, isTabUrlResponse } from '@shared/messaging'
import type { CredentialCaptureSource } from './credential-coordinator'

export async function isLiveCredentialDocument(
  source: CredentialCaptureSource,
  browserDocumentId: (tabId: number) => string | null,
  send: (tabId: number, message: { channel: typeof TAB_URL_REQUEST_CHANNEL },
    options: { documentId: string }) => Promise<unknown>,
): Promise<boolean> {
  if (browserDocumentId(source.tabId) !== source.browserDocumentId) return false
  try {
    // tabs.get redacts page URLs without extra permissions; address the isolated document instead.
    const response = await send(source.tabId, { channel: TAB_URL_REQUEST_CHANNEL }, { documentId: source.browserDocumentId })
    return browserDocumentId(source.tabId) === source.browserDocumentId
      && isTabUrlResponse(response) && response.documentId === source.documentId
      && new URL(response.url).protocol === 'https:' && new URL(response.url).origin === new URL(source.url).origin
  } catch { return false }
}
