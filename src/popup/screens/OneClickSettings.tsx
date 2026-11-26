import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { ONE_CLICK_DISABLED_KEY, ONE_CLICK_MUTED_KEY, parseMutedHosts } from '@shared/config/one-click-preferences'
import type { EntryMetadata } from '../../background/vault/entry-metadata'
import { matchesTab } from '@shared/security/domain'
import { ENTRY_TYPE_CREDENTIAL } from '../../background/vault/entry-metadata'
import { Button } from '../components/Button'
import { EntryIcon } from '../components/EntryIcon'
import { PopupIcon } from '../components/PopupIcon'
import { LoadingSkeleton } from '../components/LoadingSkeleton'
import { useI18n } from '../i18n'

const UNDO_MS = 6000

/** Unlocked Entry metadata, so an ignored site shows the icon of its saved Entry. */
export const OneClickSiteEntries = createContext<readonly EntryMetadata[]>([])

/** Presentation only: an exact-host Entry wins, then any Entry on the same registrable domain. */
function SiteIcon({ site }: { site: string }): React.JSX.Element {
  const url = `https://${site}/`
  const entries = useContext(OneClickSiteEntries).filter((item) => item.icon || item.color)
  const entry = entries.find((item) => matchesTab(url, item.urlDomain))
    ?? entries.find((item) => matchesTab(url, item.urlDomain, { exactSubdomain: false }))
  return <EntryIcon name={site} type={entry?.type ?? ENTRY_TYPE_CREDENTIAL}
    {...(entry?.icon ? { icon: entry.icon } : {})} {...(entry?.color ? { color: entry.color } : {})} />
}

interface Storage {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export function OneClickSettings({ storage = chrome.storage.local }: { storage?: Storage }): React.JSX.Element {
  const { t } = useI18n()
  const [state, setState] = useState<{ enabled: boolean; sites: string[] } | null>(null)
  const [error, setError] = useState(false)
  const [undo, setUndo] = useState<{ site: string; sites: string[] } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(undoTimer.current), [])
  useEffect(() => {
    let active = true
    void storage.get([ONE_CLICK_DISABLED_KEY, ONE_CLICK_MUTED_KEY]).then((items) => {
      if (active) setState({ enabled: items[ONE_CLICK_DISABLED_KEY] !== true, sites: parseMutedHosts(items[ONE_CLICK_MUTED_KEY]) })
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [storage])

  async function save(next: { enabled: boolean; sites: string[] }): Promise<boolean> {
    setError(false)
    try {
      await storage.set({ [ONE_CLICK_DISABLED_KEY]: !next.enabled, [ONE_CLICK_MUTED_KEY]: next.sites })
      setState(next)
      return true
    } catch { setError(true); return false }
  }

  async function unmute(current: { enabled: boolean; sites: string[] }, site: string) {
    if (!await save({ ...current, sites: current.sites.filter((item) => item !== site) })) return
    clearTimeout(undoTimer.current)
    setUndo({ site, sites: current.sites })
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS)
  }

  async function restore(current: { enabled: boolean }, previous: string[]) {
    clearTimeout(undoTimer.current)
    setUndo(null)
    await save({ ...current, sites: previous })
  }

  return <div className="one-click-settings">
    <p className="screen-subtitle">{t('oneClickSettings.description')}</p>
    {error ? <p className="settings-warning" role="alert">{t('oneClickSettings.error')}</p> : null}
    {!state ? (error ? null : <LoadingSkeleton />) : <>
      <div className="shared-unlock-setting-row">
        <h2>{t('oneClickSettings.show')}</h2>
        <button type="button" className="shared-unlock-toggle" role="switch" aria-checked={state.enabled}
          aria-label={t('oneClickSettings.show')} onClick={() => void save({ ...state, enabled: !state.enabled })}>
          <span aria-hidden="true" />
        </button>
      </div>
      <h3 className="field-label">{t('oneClickSettings.muted')}</h3>
      {state.sites.length === 0 ? <p className="screen-subtitle">{t('oneClickSettings.noMuted')}</p> :
        state.sites.map((site) => <div className="settings-check one-click-site" key={site}>
          <SiteIcon site={site} />
          <span className="one-click-site-name">{site}</span>
          <button type="button" className="toolbar-icon" aria-label={t('oneClickSettings.unmuteSite', { name: site })}
            title={t('oneClickSettings.unmuteSite', { name: site })} onClick={() => void unmute(state, site)}>
            <PopupIcon name="delete" />
          </button>
        </div>)}
      <div className="one-click-undo" role="status" aria-live="polite">
        {undo ? <>
          <span>{t('oneClickSettings.unmuted', { name: undo.site })}</span>
          <Button variant="ghost" onClick={() => void restore(state, undo.sites)}>{t('oneClickSettings.undo')}</Button>
        </> : null}
      </div>
    </>}
  </div>
}
