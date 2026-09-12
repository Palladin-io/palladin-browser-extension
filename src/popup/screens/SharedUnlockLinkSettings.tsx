import { useEffect, useRef, useState } from 'react'
import type { SharedUnlockLinkSettingsCommand, SharedUnlockLinkSettingsResult } from '../../shared/messaging/shared-unlock-link-settings'
import { Button } from '../components/Button'
import { useI18n } from '../i18n'
import { subscribeSharedUnlockSettingsChanges } from './SharedUnlockSettings'

const sendCommand = (command: SharedUnlockLinkSettingsCommand): Promise<SharedUnlockLinkSettingsResult> => chrome.runtime.sendMessage(command)
type Saved = Extract<SharedUnlockLinkSettingsResult, { ok: true }>
export function SharedUnlockLinkSettings({ send = sendCommand, subscribe = subscribeSharedUnlockSettingsChanges }: {
  send?: typeof sendCommand; subscribe?: typeof subscribeSharedUnlockSettingsChanges
}): React.JSX.Element {
  const { t } = useI18n()
  const [saved, setSaved] = useState<Saved | null>(null), [error, setError] = useState(false), [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<Saved | null>(null)
  const version = useRef(0), running = useRef(false), reload = useRef<() => void>(() => {})
  const restoreFocus = useRef(false)
  const trigger = useRef<HTMLDivElement>(null), cancel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (confirm) cancel.current?.querySelector('button')?.focus()
    else if (restoreFocus.current) { restoreFocus.current = false; trigger.current?.querySelector('button')?.focus() }
  }, [confirm])
  useEffect(() => {
    let active = true
    const load = () => {
      if (!active || running.current) return
      const request = ++version.current
      void send({ type: 'shared-unlock-link/get' }).then(result => {
        if (!active || request !== version.current) return
        setSaved(result.ok ? result : null)
        if (!result.ok) setError(true)
        setConfirm(previous => previous && result.ok && previous.contextId === result.contextId && previous.state === result.state ? previous : null)
      }).catch(() => { if (active && request === version.current) { setSaved(null); setError(true); setConfirm(null) } })
    }
    reload.current = load
    const remove = subscribe(sessionChanged => {
      if (sessionChanged) { version.current++; setSaved(null); setConfirm(null) }
      load()
    })
    const timer = setInterval(load, 15_000); window.addEventListener('focus', load); load()
    return () => { active = false; version.current++; reload.current = () => {}; clearInterval(timer); window.removeEventListener('focus', load); remove() }
  }, [send, subscribe])
  const dismiss = () => { restoreFocus.current = true; setConfirm(null) }
  const apply = async () => {
    if (!confirm || running.current) return
    const captured = confirm, request = ++version.current
    running.current = true; setBusy(true); setError(false)
    try {
      const result = await send({ type: captured.state === 'disconnected' ? 'shared-unlock-link/reconnect' : 'shared-unlock-link/disconnect', contextId: captured.contextId })
      if (version.current === request && !result.ok) setError(true)
    } catch { if (version.current === request) setError(true) }
    finally { running.current = false; setBusy(false); setConfirm(null); reload.current() }
  }
  return <section className="capture-settings" aria-label={t('sharedUnlockLink.title')} aria-busy={busy}>
    <p className="screen-subtitle">{t('sharedUnlockLink.description')}</p>
    <p role="status" className="settings-warning">{t(!saved ? 'sharedUnlockLink.authenticate'
      : saved.state === 'connected' ? 'sharedUnlockLink.connected' : saved.state === 'disconnected' ? 'sharedUnlockLink.disconnected'
        : saved.state === 'missing' ? 'sharedUnlockLink.missing' : 'sharedUnlockLink.unavailable')}</p>
    {error && <p role="alert" className="settings-warning">{t('sharedUnlockLink.error')}</p>}
    {!confirm && saved && (saved.state === 'connected' || saved.state === 'disconnected') && <div ref={trigger}>
      <Button variant="subtle" disabled={busy} onClick={() => { setError(false); setConfirm(saved) }}>
        {t(saved.state === 'disconnected' ? 'sharedUnlockLink.reconnect' : 'sharedUnlockLink.disconnect')}
      </Button>
    </div>}
    {confirm && <div role="group" aria-label={t('sharedUnlockLink.confirm')} onKeyDown={event => { if (event.key === 'Escape' && !busy) dismiss() }}>
      <p className="settings-warning">{t(confirm.state === 'disconnected' ? 'sharedUnlockLink.confirmReconnect' : 'sharedUnlockLink.confirmDisconnect')}</p>
      <div className="settings-actions" ref={cancel}>
        <Button variant="ghost" disabled={busy} onClick={dismiss}>{t('sharedUnlockLink.cancel')}</Button>
        <Button variant="danger" loading={busy} onClick={() => void apply()}>{t('sharedUnlockLink.confirm')}</Button>
      </div>
    </div>}
    {error && !confirm && <Button variant="subtle" disabled={busy} onClick={() => { setError(false); reload.current() }}>{t('sharedUnlockSettings.retry')}</Button>}
  </section>
}
