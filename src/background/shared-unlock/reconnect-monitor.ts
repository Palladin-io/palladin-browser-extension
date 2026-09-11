import type { SharedUnlockReconnectStaging } from './reconnect-staging'
import type { SharedUnlockCoordinatorRoute } from './browser-coordinator'
import type { SharedUnlockApi } from './api'
import type { SharedUnlockPreferenceMonitorClient } from './preference-monitor'
import type { SharedUnlockLinkStore } from './link-store'
import type { SharedUnlockOperationMessage } from '../../shared/messaging/shared-unlock-operation'

type Notice = Extract<SharedUnlockOperationMessage['payload'], { kind: 'link-reconnect' | 'link-reconnect-ack' }>

/** A peer invitation identifies an explicit action, never supplies authority.
 * Own Identity and the exact local disconnect fence must independently agree.
 * No JWT means no acknowledgement or clearing; the bounded hint waits in RAM. */
export function startSharedUnlockReconnectMonitor(route: SharedUnlockCoordinatorRoute, client: SharedUnlockPreferenceMonitorClient,
  links: SharedUnlockLinkStore, api: Pick<SharedUnlockApi, 'readLink'>, changed: (accountId: string) => void, staging?: SharedUnlockReconnectStaging) {
  let stopped = false, running = false, again = false, nextAt = 0
  let invitation: Notice | null = null, acknowledgement: Notice | null = null
  let controller: AbortController | null = null, retry: ReturnType<typeof setTimeout> | null = null
  let interval: ReturnType<typeof setInterval> | null = null
  const removers: (() => void)[] = []
  const request = () => {
    if (stopped) return
    if (running) { again = true; return }
    if (Date.now() < nextAt) {
      retry ??= setTimeout(() => { retry = null; request() }, nextAt - Date.now()); return
    }
    void reconcile()
  }
  const reconcile = async () => {
    running = true; again = false; nextAt = Date.now() + 1000
    const abort = new AbortController(); controller = abort
    const deadline = Date.now() + 2000, timer = setTimeout(() => abort.abort(), 2000)
    let own: ReturnType<typeof client.capture> = null
    try {
      route.assertCurrent(); if (invitation) staging?.observe(invitation); own = client.capture(); if (!own) return
      const captured = own, session = own.session
      const signal = AbortSignal.any([abort.signal, captured.signal, route.signal])
      const check = () => {
        if (stopped || signal.aborted || Date.now() >= deadline) throw new Error('Shared reconnect cancelled')
        route.assertCurrent(); captured.assertCurrent()
        if (session.apiUrl !== route.apiUrl) throw new Error('Shared reconnect environment changed')
      }
      const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const cancel = () => reject(new Error('Shared reconnect cancelled'))
        if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true })
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
      })
      const send = async (payload: Notice) => {
        const attemptId = await wait(client.nonce()); check()
        await wait(route.verifyCurrent()); check()
        route.sendOperation({ attemptId, payload })
      }
      check()
      const scope = { apiUrl: route.apiUrl, webOrigin: route.webOrigin, extensionId: route.extensionId, accountId: session.userId }
      await wait(route.verifyCurrent()); check()
      let marker = await wait(links.repair(scope)); check()
      if (!marker) return // A peer cannot choose or create a local pairing.
      const ack = acknowledgement
      if (ack) {
        if (ack.accountId === session.userId && ack.linkId === marker.linkId) {
          await wait(links.acknowledgeReconnectDelivery(scope, marker.linkId, ack.reconnectRevision, check)); check()
        }
        if (acknowledgement === ack) acknowledgement = null
      }
      const incoming = invitation
      if (incoming && incoming.accountId === session.userId && incoming.linkId === marker.linkId && !marker.pending.length) {
        // This compares untrusted browser metadata with the independently stored
        // revocation and a fresh own Identity response, not two peer fields.
        if (!(marker.observed?.state === 'revoked' && marker.observed.revision >= incoming.reconnectRevision)) {
          const current = await wait(api.readLink(session, marker.linkId, signal)); check()
          if (current.linkId === marker.linkId && current.state !== 'revoked' && current.revision >= incoming.reconnectRevision
            && (!marker.observed || marker.observed.revision <= current.revision)) {
            if (marker.disconnectId) {
              await wait(links.acknowledgeReconnect(scope, marker.linkId, marker.disconnectId, current, check)); check()
              changed(session.userId)
            }
            // Reload: a new local closing queued during the GET must defeat ACK,
            // including when the previous invitation was already acknowledged.
            marker = await wait(links.read(scope)); check()
            if (marker && marker.linkId === incoming.linkId && !marker.disconnectId && !marker.pending.length
              && marker.observed?.state !== 'revoked') {
              await send({ ...incoming, kind: 'link-reconnect-ack' })
              if (invitation === incoming) invitation = null
            }
          } else if (current.linkId === marker.linkId && current.state === 'revoked') {
            await wait(links.observe(scope, current)); check()
          }
        }
      }
      marker = await wait(links.read(scope)); check()
      if (marker && marker.reconnectRevision != null && !marker.disconnectId && !marker.pending.length
        && marker.observed?.state !== 'revoked') {
        await send({ kind: 'link-reconnect', accountId: session.userId, linkId: marker.linkId, reconnectRevision: marker.reconnectRevision })
      }
    } catch { /* Offline, stale own auth, storage failure and route loss retain denial/outbox. */ }
    finally {
      clearTimeout(timer); own?.dispose(); abort.abort()
      if (controller === abort) controller = null
      running = false; if (again) request()
    }
  }
  const close = () => {
    if (stopped) return
    stopped = true; staging?.close(); controller?.abort(); invitation = null; acknowledgement = null
    if (retry) clearTimeout(retry)
    if (interval) clearInterval(interval)
    for (const remove of removers) remove()
    route.signal.removeEventListener('abort', close)
  }
  try {
    removers.push(client.subscribe(() => { controller?.abort(); request() }))
    removers.push(links.subscribeReconnect(scope => {
      if (scope.apiUrl === route.apiUrl && scope.webOrigin === route.webOrigin && scope.extensionId === route.extensionId) request()
    }))
    removers.push(route.onOperation(({ payload }) => {
      if (payload.kind === 'link-reconnect') { invitation = payload; request() }
      else if (payload.kind === 'link-reconnect-ack') { acknowledgement = payload; request() }
    }))
    route.signal.addEventListener('abort', close, { once: true })
    interval = setInterval(request, 15_000); request()
  } catch (error) { close(); throw error }
  return { close, refresh: request }
}
