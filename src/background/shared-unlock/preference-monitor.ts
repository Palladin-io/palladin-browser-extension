import type { SharedUnlockCoordinatorRoute } from './browser-coordinator'
import { SharedUnlockApiError, type SharedUnlockApi } from './api'
import type { SharedUnlockPreferenceState } from './preference-state'
import type { SharedUnlockPreferenceScope } from './preference-gate'

export interface SharedUnlockPreferenceMonitorClient {
  nonce(): Promise<string>
  subscribe(changed: () => void): () => void
  capture(): { session: { apiUrl: string; userId: string; accessToken: string; refreshToken: string }; signal: AbortSignal;
    assertCurrent(): void; dispose(): void } | null
}

export function startSharedUnlockPreferenceMonitor(route: SharedUnlockCoordinatorRoute, client: SharedUnlockPreferenceMonitorClient,
  state: SharedUnlockPreferenceState, api: Pick<SharedUnlockApi, 'readPreference'>) {
  let stopped = false, running = false, again = false, nextReadAt = 0
  let reading: AbortController | null = null, sending: AbortController | null = null
  let queuedSave: SharedUnlockPreferenceScope | null = null, retry: ReturnType<typeof setTimeout> | null = null
  const removers: (() => void)[] = []
  let interval: ReturnType<typeof setInterval> | null = null
  const request = () => {
    if (stopped) return
    if (running) { again = true; return }
    if (Date.now() < nextReadAt) {
      retry ??= setTimeout(() => { retry = null; request() }, nextReadAt - Date.now()); return
    }
    void read()
  }
  const bounded = async (controller: AbortController, action: (own: NonNullable<ReturnType<typeof client.capture>>,
    signal: AbortSignal, check: () => void, wait: <T>(promise: Promise<T>) => Promise<T>) => Promise<void>) => {
    const timer = setTimeout(() => controller.abort(), 2000), deadline = Date.now() + 2000
    let own: ReturnType<typeof client.capture> = null
    try {
      route.assertCurrent(); own = client.capture(); if (!own) return
      const captured = own, signal = AbortSignal.any([controller.signal, captured.signal, route.signal])
      const check = () => {
        if (stopped || signal.aborted || Date.now() >= deadline) throw new Error('Shared preference refresh cancelled')
        route.assertCurrent(); captured.assertCurrent()
        if (captured.session.apiUrl !== route.apiUrl) throw new Error('Shared preference environment changed')
      }
      const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        const cancel = () => reject(new Error('Shared preference refresh cancelled'))
        if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true })
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
      })
      check(); await action(captured, signal, check, wait)
    } catch { /* A missing own session or failed read cannot enable sharing. */ }
    finally { clearTimeout(timer); own?.dispose(); controller.abort() }
  }
  const read = async () => {
    running = true; again = false; nextReadAt = Date.now() + 1000
    const controller = new AbortController(); reading = controller
    try {
      await bounded(controller, async (own, signal, check, wait) => {
        const scope = { apiUrl: own.session.apiUrl, accountId: own.session.userId }
        try {
          const preference = await wait(api.readPreference(own.session, signal)); check()
          state.observe(scope, preference)
        } catch (error) {
          check()
          // A rejected own JWT no longer owns this transient observation. A
          // future receiver still needs fresh Identity proof; local pauses stay.
          if (error instanceof SharedUnlockApiError && error.code === 'unauthorized') state.forget(scope)
          throw error
        }
      })
    } finally { if (reading === controller) reading = null; running = false; if (again) request() }
  }
  const announce = (scope: SharedUnlockPreferenceScope) => {
    if (stopped || scope.apiUrl !== route.apiUrl) return
    if (sending) { queuedSave = scope; return }
    const controller = new AbortController(); sending = controller
    void bounded(controller, async (own, _signal, check, wait) => {
      if (own.session.userId !== scope.accountId) return
      const attemptId = await wait(client.nonce()); check()
      await wait(route.verifyCurrent()); check()
      route.sendOperation({ attemptId, payload: { kind: 'preference-invalidated' } })
    }).finally(() => {
      sending = null
      const queued = queuedSave; queuedSave = null
      if (queued) announce(queued)
    })
  }
  const close = () => {
    if (stopped) return
    stopped = true; reading?.abort(); sending?.abort(); queuedSave = null
    if (interval) clearInterval(interval)
    if (retry) clearTimeout(retry)
    for (const remove of removers) remove()
    route.signal.removeEventListener('abort', close)
  }
  try {
    removers.push(client.subscribe(() => { reading?.abort(); request() }))
    removers.push(route.onOperation(message => { if (message.payload.kind === 'preference-invalidated') request() }))
    removers.push(state.subscribeSaved(scope => { announce(scope); if (scope.apiUrl === route.apiUrl) request() }))
    route.signal.addEventListener('abort', close, { once: true })
    interval = setInterval(request, 15_000); request()
  } catch (error) { close(); throw error }
  return { close, refresh: request }
}
