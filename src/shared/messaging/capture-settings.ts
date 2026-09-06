export type CaptureSettingsCommand =
  | { readonly type: 'capture-settings/get' }
  | { readonly type: 'capture-settings/unmute'; readonly site: string }
  | { readonly type: 'capture-settings/disable'; readonly vaultId: string; readonly entryId: string }

export type CaptureSettingsResult =
  | { readonly ok: false }
  | { readonly ok: true; readonly mutedSites: readonly string[]; readonly automaticUpdates: readonly {
      readonly vaultId: string; readonly entryId: string; readonly label: string; readonly vaultLabel: string; readonly origin: string;
    }[] }

export function isCaptureSettingsCommand(value: unknown): value is CaptureSettingsCommand {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  switch (raw.type) {
    case 'capture-settings/get': return Object.keys(raw).length === 1
    case 'capture-settings/unmute': return Object.keys(raw).length === 2
      && typeof raw.site === 'string' && /^[a-z0-9.-]{1,253}$/.test(raw.site)
    case 'capture-settings/disable': return Object.keys(raw).length === 3
      && typeof raw.vaultId === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(raw.vaultId)
      && typeof raw.entryId === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(raw.entryId)
    default: return false
  }
}
