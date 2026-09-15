import { z } from 'zod'

const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('shared-unlock-link/get') }).strict(),
  z.object({ type: z.literal('shared-unlock-link/disconnect'), contextId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('shared-unlock-link/reconnect'), contextId: z.string().uuid() }).strict(),
])
export type SharedUnlockLinkSettingsCommand = z.infer<typeof commandSchema>
export type SharedUnlockLocalLinkState = 'missing' | 'connected' | 'disconnected' | 'unavailable'
export type SharedUnlockLinkSettingsResult =
  | { readonly ok: true; readonly contextId: string; readonly state: SharedUnlockLocalLinkState }
  | { readonly ok: false; readonly code: 'authentication-required' | 'cancelled' | 'conflict' | 'unavailable' }
export function isSharedUnlockLinkSettingsCommand(value: unknown): value is SharedUnlockLinkSettingsCommand {
  return commandSchema.safeParse(value).success
}
