import type { SharedUnlockLinkSettingsCommand, SharedUnlockLinkSettingsResult } from '../../shared/messaging/shared-unlock-link-settings'
import type { SharedUnlockSettingsSession } from '../session/shared-unlock-settings'
import type { SessionTokens } from '../session/types'
import { SharedUnlockApiError, type SharedUnlockApi } from './api'
import { flushSharedUnlockClosings } from './closing'
import type { SharedUnlockLinkScope, SharedUnlockLinkMarker, SharedUnlockLinkStore } from './link-store'

interface Context {
  id: string; source: SharedUnlockSettingsSession; scope: SharedUnlockLinkScope | null; marker: SharedUnlockLinkMarker | null
}
export class SharedUnlockLinkSettings {
  private context: Context | null = null
  private acting = false
  constructor(
    private readonly capture: () => SharedUnlockSettingsSession,
    private readonly lock: (source: SharedUnlockSettingsSession) => Promise<SharedUnlockSettingsSession>,
    private readonly scopeFor: (session: SessionTokens) => SharedUnlockLinkScope | null,
    private readonly links: SharedUnlockLinkStore,
    private readonly api: SharedUnlockApi,
    private readonly changed: () => void,
  ) {}

  private ownContext(): Context {
    if (this.context) {
      try { this.context.source.read(); return this.context }
      catch { this.context.source.dispose(); this.context = null }
    }
    const source = this.capture()
    try {
      const context = { id: crypto.randomUUID(), source, scope: this.scopeFor(source.read()), marker: null }
      this.context = context
      source.signal.addEventListener('abort', () => { if (this.context === context) this.context = null }, { once: true })
      return context
    } catch (error) { source.dispose(); throw error }
  }

  async dispatch(command: SharedUnlockLinkSettingsCommand): Promise<SharedUnlockLinkSettingsResult> {
    if (this.acting) return { ok: false, code: 'cancelled' }
    let context: Context, session: SessionTokens
    try {
      if (command.type === 'shared-unlock-link/get') context = this.ownContext()
      else {
        if (!this.context || this.context.id !== command.contextId) return { ok: false, code: 'cancelled' }
        context = this.context
      }
      session = context.source.read()
    } catch { return { ok: false, code: 'authentication-required' } }
    const scope = context.scope, selected = context.marker
    const mutating = command.type !== 'shared-unlock-link/get'
    if (mutating && (!scope || !selected)) return { ok: false, code: 'unavailable' }
    if (mutating) this.acting = true
    const abort = new AbortController(), deadline = Date.now() + 10_000
    const timer = setTimeout(() => abort.abort(), 10_000)
    let source = context.source
    const check = () => {
      if (abort.signal.aborted || Date.now() >= deadline || source.read() !== session) throw new SharedUnlockApiError('cancelled')
      const current = this.scopeFor(session)
      if (current?.apiUrl !== scope?.apiUrl || current?.accountId !== scope?.accountId
        || current?.webOrigin !== scope?.webOrigin || current?.extensionId !== scope?.extensionId) throw new SharedUnlockApiError('cancelled')
    }
    const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const cancel = () => reject(new SharedUnlockApiError('cancelled'))
      if (abort.signal.aborted) cancel(); else abort.signal.addEventListener('abort', cancel, { once: true })
      promise.then(resolve, reject).finally(() => abort.signal.removeEventListener('abort', cancel))
    })
    const lockOwn = async () => {
      check()
      const locking = this.lock(source)
      void locking.then(lease => { if (abort.signal.aborted) lease.dispose() }, () => {})
      source = await wait(locking); check()
    }
    try {
      check()
      if (!mutating) {
        const marker = scope ? await wait(this.links.repair(scope)) : null; check()
        // Polling must not retarget a confirmation opened before a new disconnect.
        if (marker?.linkId !== context.marker?.linkId || marker?.disconnectId !== context.marker?.disconnectId) context.id = crypto.randomUUID()
        context.marker = marker
        return { ok: true, contextId: context.id, state: !scope ? 'unavailable' : !marker ? 'missing'
          : marker.disconnectId || marker.observed?.state === 'revoked' ? 'disconnected' : 'connected' }
      }
      if (!scope || !selected) throw new SharedUnlockApiError('cancelled')
      if (command.type === 'shared-unlock-link/disconnect') {
        const pending = this.links.beginClosing(scope, selected.linkId, 'disconnect', 0, null)
        void pending.catch(() => {})
        await lockOwn()
        await wait(pending); check()
        await wait(flushSharedUnlockClosings(scope, session, this.links, this.api, abort.signal, check)); check()
        return { ok: true, contextId: context.id, state: 'disconnected' }
      }
      const marker = await wait(this.links.repair(scope)); check()
      const disconnectId = selected.disconnectId
      if (!disconnectId || marker?.linkId !== selected.linkId || marker.disconnectId !== disconnectId) throw new SharedUnlockApiError('cancelled')
      await wait(flushSharedUnlockClosings(scope, session, this.links, this.api, abort.signal, check)); check()
      const current = await wait(this.links.read(scope)); check()
      if (!current || current.disconnectId !== disconnectId || current.pending.length) throw new SharedUnlockApiError('cancelled')
      const link = await wait(this.api.readLink(session, selected.linkId, abort.signal)); check()
      const receipt = link.state === 'revoked'
        ? await wait(this.api.reconnect(session, selected.linkId, link.revision, abort.signal)) : link
      check()
      await wait(this.links.acknowledgeReconnect(scope, selected.linkId, disconnectId, receipt, check, true)); check()
      await lockOwn()
      return { ok: true, contextId: context.id, state: 'connected' }
    } catch (error) {
      const unauthorized = error instanceof SharedUnlockApiError && error.code === 'unauthorized'
      if (unauthorized) source.dispose()
      return { ok: false, code: unauthorized ? 'authentication-required'
        : error instanceof SharedUnlockApiError && error.code === 'conflict' ? 'conflict'
        : abort.signal.aborted || source.signal.aborted ? 'cancelled' : 'unavailable' }
    } finally {
      abort.abort(); clearTimeout(timer)
      if (source !== context.source) source.dispose()
      if (mutating) { this.acting = false; try { this.changed() } catch { /* The durable decision survives UI delivery failure. */ } }
    }
  }
}
