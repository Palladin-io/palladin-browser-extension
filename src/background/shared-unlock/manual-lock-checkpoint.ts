import type { SharedUnlockApi } from './api'
import type { SessionTokens } from '../session/types'
import type { SharedUnlockLinkScope, SharedUnlockLinkStore } from './link-store'

/** A closing acknowledgement for one verified own manual key generation, not
 * an unlock root. Only the authenticated own session-state read supplies it;
 * persisted link observations and peer messages cannot authorize this exception. */
export interface SharedUnlockManualLockCheckpoint {
  readonly linkId: string
  readonly lastInvalidationSequence: number
}

export async function readManualLockCheckpoint(scope: SharedUnlockLinkScope, session: SessionTokens,
  store: SharedUnlockLinkStore, api: SharedUnlockApi, signal: AbortSignal, check: () => void,
): Promise<SharedUnlockManualLockCheckpoint[]> {
  check()
  const marker = await store.read(scope)
  check()
  if (!marker) return []
  const state = await api.readSessionState(session, marker.linkId, signal)
  check()
  return state.action === 'lock' && state.link
    ? [{ linkId: state.link.linkId, lastInvalidationSequence: state.link.lastInvalidationSequence }] : []
}
