import { useEffect, useState } from 'react'
import { ONE_CLICK_DISABLED_KEY, ONE_CLICK_MUTED_KEY, parseMutedHosts } from '@shared/config/one-click-preferences'
import { Button } from '../components/Button'
import { LoadingSkeleton } from '../components/LoadingSkeleton'
import { useI18n } from '../i18n'

interface Storage {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

export function OneClickSettings({ storage = chrome.storage.local }: { storage?: Storage }): React.JSX.Element {
  const { t } = useI18n()
  const [state, setState] = useState<{ enabled: boolean; sites: string[] } | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let active = true
    void storage.get([ONE_CLICK_DISABLED_KEY, ONE_CLICK_MUTED_KEY]).then((items) => {
      if (active) setState({ enabled: items[ONE_CLICK_DISABLED_KEY] !== true, sites: parseMutedHosts(items[ONE_CLICK_MUTED_KEY]) })
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [storage])

  async function save(next: { enabled: boolean; sites: string[] }) {
    setError(false)
    try {
      await storage.set({ [ONE_CLICK_DISABLED_KEY]: !next.enabled, [ONE_CLICK_MUTED_KEY]: next.sites })
      setState(next)
    } catch { setError(true) }
  }

  return <div className="one-click-settings">
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
          <span>{site}</span>
          <Button variant="ghost" aria-label={t('oneClickSettings.unmuteSite', { name: site })}
            onClick={() => void save({ ...state, sites: state.sites.filter((item) => item !== site) })}>
            {t('oneClickSettings.enable')}
          </Button>
        </div>)}
    </>}
  </div>
}
