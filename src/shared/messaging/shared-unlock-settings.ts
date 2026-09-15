import { z } from 'zod'

const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shared-unlock-settings/get') }).strict(),
  z.object({ type: z.literal('shared-unlock-settings/set'), contextId: z.string().uuid(),
    enabled: z.boolean(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
])
export type SharedUnlockSettingsCommand = z.infer<typeof commandSchema>
export type SharedUnlockSettingsError = 'authentication-required' | 'cancelled' | 'conflict' | 'unavailable'
export type SharedUnlockSettingsResult =
  | { readonly ok: true; readonly contextId: string; readonly sharedUnlockEnabled: boolean; readonly revision: number; readonly locallyPaused: boolean }
  | { readonly ok: false; readonly code: SharedUnlockSettingsError; readonly locallyPaused: boolean }

export function isSharedUnlockSettingsCommand(value: unknown): value is SharedUnlockSettingsCommand {
  return commandSchema.safeParse(value).success
}
export const sharedUnlockSettingsChanged = () => ({ type: 'shared-unlock-settings/changed' as const })
export function isSharedUnlockSettingsChanged(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && (value as { type?: unknown }).type === 'shared-unlock-settings/changed'
}
