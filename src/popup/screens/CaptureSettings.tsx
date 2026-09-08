import { useEffect, useState } from 'react'
import type { CaptureSettingsCommand, CaptureSettingsResult } from '@shared/messaging/capture-settings'
import { Button } from '../components/Button'
import { useI18n } from '../i18n'

const sendCommand = (command: CaptureSettingsCommand): Promise<CaptureSettingsResult> => chrome.runtime.sendMessage(command)

export function CaptureSettings({ send = sendCommand }: {
  send?: (command: CaptureSettingsCommand) => Promise<CaptureSettingsResult>
}): React.JSX.Element {
  const { t } = useI18n()
  const [settings, setSettings] = useState<Extract<CaptureSettingsResult, { ok: true }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    void send({ type: 'capture-settings/get' }).then((result) => {
      if (!active) return
      if (result?.ok) setSettings(result)
      else setError(true)
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [send])

  async function change(command: CaptureSettingsCommand) {
    setBusy(true)
    setError(false)
    try {
      const result = await send(command)
      if (result?.ok) setSettings(result)
      else setError(true)
    } catch { setError(true) }
    finally { setBusy(false) }
  }

  return <div className="capture-settings">
    <p className="screen-subtitle">{t('captureSettings.description')}</p>
    {error ? <p className="settings-warning" role="alert">{t('captureSettings.error')}</p> : null}
    {!settings ? <Button variant="subtle" loading={busy} onClick={() => void change({ type: 'capture-settings/get' })}>
      {t('captureSettings.reload')}
    </Button> : <>
      <h3 className="field-label">{t('captureSettings.automatic')}</h3>
      {settings.automaticUpdates.length === 0 ? <p className="screen-subtitle">{t('captureSettings.noAutomatic')}</p> :
        settings.automaticUpdates.map((entry) => <div className="capture-setting-row" key={`${entry.vaultId}:${entry.entryId}`}>
          <span><strong>{entry.label}</strong><small>{entry.vaultLabel}</small></span>
          <Button variant="subtle" disabled={busy} aria-label={t('captureSettings.disableAccount', { name: entry.label })}
            onClick={() => void change({ type: 'capture-settings/disable', vaultId: entry.vaultId, entryId: entry.entryId })}>
            {t('captureSettings.disable')}
          </Button>
        </div>)}
      <h3 className="field-label">{t('captureSettings.muted')}</h3>
      {settings.mutedSites.length === 0 ? <p className="screen-subtitle">{t('captureSettings.noMuted')}</p> :
        settings.mutedSites.map((site) => <div className="capture-setting-row" key={site}>
          <span>{site}</span>
          <Button variant="subtle" disabled={busy} aria-label={t('captureSettings.unmuteSite', { name: site })}
            onClick={() => void change({ type: 'capture-settings/unmute', site })}>{t('captureSettings.unmute')}</Button>
        </div>)}
    </>}
  </div>
}
