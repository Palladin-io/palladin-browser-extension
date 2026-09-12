import { useEffect, useRef, useState } from 'react'
import { isSurfaceStateEvent } from '../../shared/messaging/surface-state'
import { isSharedUnlockSettingsChanged, type SharedUnlockSettingsCommand,
  type SharedUnlockSettingsResult, type SharedUnlockSettingsError } from '../../shared/messaging/shared-unlock-settings'
import { Button } from '../components/Button'
import { useI18n } from '../i18n'

const sendCommand = (command: SharedUnlockSettingsCommand): Promise<SharedUnlockSettingsResult> => chrome.runtime.sendMessage(command)
export const subscribeSharedUnlockSettingsChanges = (changed: (sessionChanged: boolean) => void) => {
  const listener = (raw: unknown) => {
    if (isSharedUnlockSettingsChanged(raw)) changed(false)
    else if (isSurfaceStateEvent(raw) && raw.type === 'surface/session-changed') changed(true)
  }
  chrome.runtime.onMessage.addListener(listener)
  return () => chrome.runtime.onMessage.removeListener(listener)
}

export function SharedUnlockSettings({ send = sendCommand, subscribe = subscribeSharedUnlockSettingsChanges }: {
  send?: typeof sendCommand; subscribe?: typeof subscribeSharedUnlockSettingsChanges
}): React.JSX.Element {
  const { t } = useI18n()
  const [settings, setSettings] = useState<Extract<SharedUnlockSettingsResult, { ok: true }> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ code: SharedUnlockSettingsError; locallyPaused: boolean } | null>(null)
  const version = useRef(0), busyRef = useRef(false), currentContext = useRef<string | null>(null)
  const lastChoice = useRef<boolean | null>(null), reload = useRef<() => void>(() => {})
  useEffect(() => {
    let active = true
    const load = () => {
      if (busyRef.current || !active) return
      const selected = ++version.current
      void send({ type: 'shared-unlock-settings/get' }).then(result => {
        if (!active || selected !== version.current) return
        if (result.ok) {
          if (currentContext.current !== result.contextId) {
            currentContext.current = result.contextId; lastChoice.current = null; setError(null)
          } else if (lastChoice.current === null) setError(null)
          setSettings(result)
        } else {
          if (result.code === 'authentication-required' || result.code === 'cancelled') {
            setSettings(null); currentContext.current = null; lastChoice.current = null
          }
          setError(result)
        }
      }).catch(() => { if (active && selected === version.current) setError({ code: 'unavailable', locallyPaused: false }) })
    }
    reload.current = load
    const unsubscribe = subscribe(sessionChanged => {
      if (sessionChanged) {
        version.current++; busyRef.current = false; currentContext.current = null; lastChoice.current = null
        setSettings(null); setError(null); setBusy(false)
      }
      load()
    })
    const timer = setInterval(load, 15_000)
    window.addEventListener('focus', load); load()
    return () => { active = false; version.current++; reload.current = () => {}; clearInterval(timer); window.removeEventListener('focus', load); unsubscribe() }
  }, [send, subscribe])

  async function change(enabled: boolean) {
    if (!settings || busyRef.current) return
    const selected = ++version.current
    busyRef.current = true; lastChoice.current = enabled; setBusy(true); setError(null)
    try {
      const result = await send({ type: 'shared-unlock-settings/set', contextId: settings.contextId,
        revision: settings.revision, enabled })
      if (selected !== version.current) return
      if (result.ok) { setSettings(result); lastChoice.current = null }
      else {
        setError(result)
        if (result.code === 'cancelled' || result.code === 'authentication-required') {
          setSettings(null); currentContext.current = null; lastChoice.current = null
        }
      }
    } catch { if (selected === version.current) setError({ code: 'unavailable', locallyPaused: true }) }
    finally {
      if (selected === version.current) { busyRef.current = false; setBusy(false); reload.current() }
    }
  }
  const paused = settings?.locallyPaused || error?.locallyPaused
  const authenticationRequired = error?.code === 'authentication-required' || error?.code === 'cancelled'
  return <div className="capture-settings" aria-busy={busy}>
    <p className="screen-subtitle">{t('sharedUnlockSettings.description')}</p>
    <p className="screen-subtitle">{t('sharedUnlockSettings.behavior')}</p>
    <p className="screen-subtitle">{t('sharedUnlockSettings.offEffect')}</p>
    {settings && <div className="capture-setting-row">
      <span>{t('sharedUnlockSettings.title')}</span>
      <Button variant="subtle" role="switch" aria-checked={settings.sharedUnlockEnabled}
        aria-label={t('sharedUnlockSettings.title')} disabled={busy} onClick={() => void change(!settings.sharedUnlockEnabled)}>
        {t(settings.sharedUnlockEnabled ? 'sharedUnlockSettings.on' : 'sharedUnlockSettings.off')}
      </Button>
    </div>}
    <p role={error ? 'alert' : 'status'} className="settings-warning">
      {busy ? t('sharedUnlockSettings.saving')
        : authenticationRequired ? t('sharedUnlockSettings.authenticate')
          : error ? t(error.code === 'conflict' ? 'sharedUnlockSettings.conflict' : paused ? 'sharedUnlockSettings.saveFailed' : 'sharedUnlockSettings.loadFailed')
            : paused ? t('sharedUnlockSettings.paused')
              : !settings ? t('sharedUnlockSettings.loading')
                : t(settings.sharedUnlockEnabled ? 'sharedUnlockSettings.enabled' : 'sharedUnlockSettings.disabled')}
    </p>
    {(error || paused) && <Button variant="subtle" disabled={busy} onClick={() => {
      if (settings && paused) void change(lastChoice.current ?? settings.sharedUnlockEnabled)
      else reload.current()
    }}>{t('sharedUnlockSettings.retry')}</Button>}
  </div>
}
