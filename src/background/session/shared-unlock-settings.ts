import type { SessionTokens } from './types'

export interface SharedUnlockSettingsSession {
  readonly signal: AbortSignal
  read(): SessionTokens
  dispose(): void
}
