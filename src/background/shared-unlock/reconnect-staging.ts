import type { SharedUnlockCoordinatorRoute, SharedUnlockSelectedBinding } from './browser-coordinator'
import type { SharedUnlockApi } from './api'
import type { SharedUnlockLinkMarker, SharedUnlockLinkScope, SharedUnlockLinkStore } from './link-store'

export interface SharedUnlockReconnectNotice { readonly accountId: string; readonly linkId: string; readonly reconnectRevision: number }
interface OwnSession { readonly apiUrl: string; readonly userId: string; readonly accessToken: string; readonly refreshToken: string }

/** A route-bound hint permits only a pending receiver proof exchange. The local
 * revocation remains until that receiver's own Identity confirms the exact link. */
export class SharedUnlockReconnectStaging {
  private notice: SharedUnlockReconnectNotice | null = null
  private closed = false
  private readonly route: SharedUnlockCoordinatorRoute
  private readonly changed: (accountId: string) => void
  constructor(route: SharedUnlockCoordinatorRoute, changed: (accountId: string) => void) { this.route = route; this.changed = changed }

  observe(notice: SharedUnlockReconnectNotice): void {
    if (this.closed) return
    this.route.assertCurrent()
    const before = this.notice
    if (before?.accountId === notice.accountId && before.linkId === notice.linkId && before.reconnectRevision >= notice.reconnectRevision) return
    this.notice = { accountId: notice.accountId, linkId: notice.linkId, reconnectRevision: notice.reconnectRevision }
    if (before && before.accountId !== notice.accountId) this.changed(before.accountId)
    this.changed(notice.accountId)
  }
  close(): void { this.closed = true; this.notice = null }

  canStage(marker: SharedUnlockLinkMarker, linkEpoch?: number): boolean {
    const hint = this.notice, observed = marker.observed
    return !this.closed && !this.route.signal.aborted && !!hint && !!marker.disconnectId && !marker.pending.length && !!observed
      && marker.apiUrl === this.route.apiUrl && marker.webOrigin === this.route.webOrigin && marker.extensionId === this.route.extensionId
      && marker.accountId === hint.accountId && marker.linkId === hint.linkId
      && (observed.state !== 'revoked' || hint.reconnectRevision > observed.revision)
      && (linkEpoch === undefined || (observed.state === 'revoked' ? linkEpoch > observed.epoch : linkEpoch >= observed.epoch))
  }

  capture(marker: SharedUnlockLinkMarker, binding: SharedUnlockSelectedBinding, links: SharedUnlockLinkStore, api: Pick<SharedUnlockApi, 'readLink'>) {
    const hint = marker.disconnectId ? this.notice : null, disconnectId = marker.disconnectId
    const scope: SharedUnlockLinkScope = { apiUrl: marker.apiUrl, webOrigin: marker.webOrigin, extensionId: marker.extensionId, accountId: marker.accountId }
    const linkId = marker.linkId, linkEpoch = binding.linkEpoch
    if (marker.apiUrl !== this.route.apiUrl || marker.webOrigin !== this.route.webOrigin || marker.extensionId !== this.route.extensionId
      || binding.apiOrigin !== new URL(this.route.apiUrl).origin || binding.webOrigin !== this.route.webOrigin
      || binding.extensionId !== this.route.extensionId || binding.documentBinding !== this.route.documentBinding
      || marker.pending.length || marker.accountId !== binding.accountId || linkId !== binding.linkId
      || ((disconnectId || marker.observed?.state === 'revoked') && !this.canStage(marker, linkEpoch))) throw new Error('Shared reconnect staging unavailable')
    const assertCurrent = () => {
      this.route.assertCurrent()
      if (this.closed || this.route.signal.aborted || (hint && this.notice !== hint)) throw new Error('Shared reconnect staging changed')
    }
    return {
      assertCurrent,
      confirm: async (session: OwnSession, authorizationSequence: number, ownSignal: AbortSignal, assertOwnCurrent: () => void): Promise<void> => {
        const abort = new AbortController(), deadline = Date.now() + 2000, timer = setTimeout(() => abort.abort(), 2000)
        const signal = AbortSignal.any([abort.signal, ownSignal, this.route.signal])
        const check = () => {
          assertCurrent(); assertOwnCurrent()
          if (signal.aborted || Date.now() >= deadline || session.apiUrl !== scope.apiUrl || session.userId !== scope.accountId) throw new Error('Own reconnect confirmation cancelled')
        }
        const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
          const cancel = () => reject(new Error('Own reconnect confirmation cancelled'))
          if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true })
          promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
        })
        try {
          check()
          let current = await wait(links.read(scope)); check()
          if (!current || current.linkId !== linkId || current.pending.length
            || (current.disconnectId !== null && current.disconnectId !== disconnectId)) throw new Error('Local link changed before install')
          if (hint && current.disconnectId && !this.canStage(current, linkEpoch)) throw new Error('Newer local disconnect')
          const authoritative = await wait(api.readLink(session, linkId, signal)); check()
          // This fresh own Identity read fences closing after the cryptographic
          // commit, including normal/tokenless receivers without a reconnect hint.
          if (authoritative.linkId !== linkId || authoritative.epoch !== linkEpoch || authoritative.state !== 'active'
            || (hint && authoritative.revision < hint.reconnectRevision)
            || authoritative.lastInvalidationSequence >= authorizationSequence) throw new Error('Own Identity rejected receiver installation')
          if (hint && current.disconnectId) {
            await wait(links.acknowledgeReconnect(scope, linkId, current.disconnectId, authoritative, check)); check()
          }
          current = await wait(links.read(scope)); check()
          if (!current || current.linkId !== linkId || current.pending.length || current.disconnectId
            || current.observed?.state === 'revoked' || (current.observed && current.observed.epoch > linkEpoch)) throw new Error('Local link is unavailable for installation')
        } finally { clearTimeout(timer); abort.abort() }
      },
    }
  }
}
