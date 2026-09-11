import type { SharedUnlockPreference } from './api-types'
import type { SharedUnlockPreferenceScope } from './preference-gate'

export interface SharedUnlockPreferenceChange {
  readonly scope: SharedUnlockPreferenceScope
  readonly preference: SharedUnlockPreference | null
}

/** Observations from own authenticated Identity reads only. This RAM denial
 * cache never grants authorization, clears a pause or carries peer input. */
export class SharedUnlockPreferenceState {
  private readonly values = new Map<string, SharedUnlockPreference>()
  private readonly listeners = new Set<(change: SharedUnlockPreferenceChange) => void>()
  private readonly saves = new Set<(scope: SharedUnlockPreferenceScope) => void>()
  observe(scope: SharedUnlockPreferenceScope, preference: SharedUnlockPreference): void {
    const key = this.key(scope), previous = this.values.get(key)
    if (previous && (previous.revision > preference.revision
      || (previous.revision === preference.revision && previous.sharedUnlockEnabled === preference.sharedUnlockEnabled))) return
    const value = { sharedUnlockEnabled: preference.sharedUnlockEnabled, revision: preference.revision }
    this.values.set(key, value)
    for (const listener of [...this.listeners]) {
      try { listener({ scope: { ...scope }, preference: { ...value } }) } catch { /* Observers cannot undo Identity state. */ }
    }
  }
  assertNotDisabled(scope: SharedUnlockPreferenceScope): void {
    if (this.values.get(this.key(scope))?.sharedUnlockEnabled === false) throw new Error('Shared unlock account preference is disabled')
  }
  isDisabled(scope: SharedUnlockPreferenceScope): boolean { return this.values.get(this.key(scope))?.sharedUnlockEnabled === false }
  forget(scope: SharedUnlockPreferenceScope): void {
    if (!this.values.delete(this.key(scope))) return
    for (const listener of [...this.listeners]) { try { listener({ scope: { ...scope }, preference: null }) } catch { /* The expired observation remains removed. */ } }
  }
  clear(): void { this.values.clear() }
  subscribe(listener: (change: SharedUnlockPreferenceChange) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener) }
  }
  saved(scope: SharedUnlockPreferenceScope): void {
    for (const listener of [...this.saves]) { try { listener({ ...scope }) } catch { /* Delivery is best effort. */ } }
  }
  subscribeSaved(listener: (scope: SharedUnlockPreferenceScope) => void): () => void {
    this.saves.add(listener); return () => { this.saves.delete(listener) }
  }
  private key(scope: SharedUnlockPreferenceScope): string { return JSON.stringify([scope.apiUrl, scope.accountId]) }
}
