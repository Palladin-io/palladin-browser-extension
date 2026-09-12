import type { SharedUnlockSettingsCommand, SharedUnlockSettingsResult } from '../../shared/messaging/shared-unlock-settings'
import type { SharedUnlockSettingsSession } from '../session/shared-unlock-settings'
import type { SessionTokens } from '../session/types'
import { SharedUnlockApiError, type SharedUnlockApi } from './api'
import type { SharedUnlockPreference } from './api-types'
import type { SharedUnlockPreferenceGate } from './preference-gate'

interface SettingsContext { readonly id: string; readonly source: SharedUnlockSettingsSession }

export class SharedUnlockSettings {
  private context: SettingsContext | null = null
  constructor(
    private readonly capture: () => SharedUnlockSettingsSession,
    private readonly api: Pick<SharedUnlockApi, 'readPreference' | 'setPreference'>,
    private readonly gate: SharedUnlockPreferenceGate,
    private readonly accept: (session: SessionTokens, preference: SharedUnlockPreference) => void,
    private readonly changed: () => void,
    private readonly committed: (scope: { apiUrl: string; accountId: string }) => void = () => {},
  ) {}

  private ownContext(): SettingsContext {
    if (this.context) {
      try { this.context.source.read(); return this.context }
      catch { this.context.source.dispose(); this.context = null }
    }
    const source = this.capture()
    try { source.read() } catch (error) { source.dispose(); throw error }
    const context = { id: crypto.randomUUID(), source }
    this.context = context
    source.signal.addEventListener('abort', () => {
      if (this.context === context) this.context = null
    }, { once: true })
    return context
  }

  async dispatch(command: SharedUnlockSettingsCommand): Promise<SharedUnlockSettingsResult> {
    let context: SettingsContext
    let session: SessionTokens
    try {
      if (command.type === 'shared-unlock-settings/set') {
        if (!this.context || this.context.id !== command.contextId) return { ok: false, code: 'cancelled', locallyPaused: false }
        context = this.context; context.source.read()
      } else context = this.ownContext()
      session = context.source.read()
    } catch { return { ok: false, code: 'authentication-required', locallyPaused: false } }

    const scope = { apiUrl: session.apiUrl, accountId: session.userId }
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, context.source.signal])
    const deadline = Date.now() + 10_000, timer = setTimeout(() => abort.abort(), 10_000)
    let locallyPaused = false
    const check = () => {
      if (signal.aborted || Date.now() >= deadline || this.context !== context
        || context.source.read() !== session) throw new SharedUnlockApiError('cancelled')
    }
    const wait = <T>(promise: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const cancel = () => reject(new SharedUnlockApiError('cancelled'))
      if (signal.aborted) cancel()
      else signal.addEventListener('abort', cancel, { once: true })
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
    })
    try {
      check()
      let preference: SharedUnlockPreference
      if (command.type === 'shared-unlock-settings/set') {
        const pause = this.gate.pause(scope); locallyPaused = true
        this.notify()
        await wait(pause.persisted); check()
        preference = await wait(this.api.setPreference(session, command.enabled, command.revision, signal)); check()
        this.accept(session, preference); check()
        this.committed(scope); check()
        await wait(this.gate.complete(scope, pause.id, check)); check()
        locallyPaused = false
      } else {
        preference = await wait(this.api.readPreference(session, signal)); check()
        this.accept(session, preference); check()
        locallyPaused = !await wait(this.gate.isAllowed(scope)); check()
      }
      return { ok: true, contextId: context.id, sharedUnlockEnabled: preference.sharedUnlockEnabled, revision: preference.revision, locallyPaused }
    } catch (error) {
      const unauthorized = error instanceof SharedUnlockApiError && error.code === 'unauthorized'
      if (unauthorized) context.source.dispose()
      const code = unauthorized ? 'authentication-required'
        : error instanceof SharedUnlockApiError && error.code === 'conflict' ? 'conflict'
        : signal.aborted || this.context !== context ? 'cancelled' : 'unavailable'
      return { ok: false, code, locallyPaused }
    } finally {
      clearTimeout(timer); abort.abort()
      if (command.type === 'shared-unlock-settings/set') this.notify()
    }
  }

  private notify(): void { try { this.changed() } catch { /* UI delivery cannot undo the local pause or the account write. */ } }
}
