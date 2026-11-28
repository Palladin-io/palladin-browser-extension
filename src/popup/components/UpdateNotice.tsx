import { useEffect, useMemo, useState } from 'react'
import { UPDATE_READY_KEY } from '@shared/config/extension-update'
import { useI18n } from '../i18n'
import { PopupIcon } from './PopupIcon'

export interface UpdateNoticeDeps {
  readonly current: string
  readonly readReady: () => Promise<unknown>
  readonly onReadyChanged: (listener: (version: unknown) => void) => () => void
  readonly checkForUpdate: () => void
  readonly applyUpdate: () => void
}

function browserDeps(): UpdateNoticeDeps | null {
  if (typeof chrome === 'undefined' || !chrome.storage?.session || !chrome.storage.onChanged) return null
  return {
    current: chrome.runtime.getManifest?.().version ?? '',
    readReady: async () => (await chrome.storage.session.get(UPDATE_READY_KEY))[UPDATE_READY_KEY],
    onReadyChanged: (listener) => {
      const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === 'session' && UPDATE_READY_KEY in changes) listener(changes[UPDATE_READY_KEY]?.newValue)
      }
      chrome.storage.onChanged.addListener(changed)
      return () => chrome.storage.onChanged.removeListener(changed)
    },
    // Chrome throttles repeated checks; a downloaded update is reported to the worker.
    checkForUpdate: () => { try { void Promise.resolve(chrome.runtime.requestUpdateCheck?.()).catch(() => undefined) } catch { /* Unsupported browser. */ } },
    applyUpdate: () => chrome.runtime.reload(),
  }
}

/** Replaces the version label once a newer version is downloaded. */
export function UpdateNotice({ deps: given, fallback = null }: { deps?: UpdateNoticeDeps; fallback?: React.ReactNode }): React.JSX.Element | null {
  const { t } = useI18n()
  const deps = useMemo(() => given ?? browserDeps(), [given])
  const [ready, setReady] = useState<string | null>(null)
  useEffect(() => {
    if (deps === null) return
    let active = true
    const accept = (value: unknown) => { if (active) setReady(typeof value === 'string' && value !== deps.current ? value : null) }
    void deps.readReady().then(accept).catch(() => undefined)
    const stop = deps.onReadyChanged(accept)
    deps.checkForUpdate()
    return () => { active = false; stop() }
  }, [deps])
  if (ready === null || deps === null) return <>{fallback}</>
  return <span className="vault-footer-update">
    <span aria-hidden="true">|</span>
    <button type="button" className="link-btn" onClick={() => deps?.applyUpdate()}>
      <PopupIcon name="refresh" />
      <span>{t('vault.updateTo', { version: ready })}</span>
    </button>
  </span>
}
