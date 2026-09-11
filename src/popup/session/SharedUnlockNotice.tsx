import { useEffect, useState } from 'react';
import { SHARED_UNLOCK_NOTICE_PORT, isSharedUnlockNotice } from '../../shared/messaging/shared-unlock-notice';
import { useI18n } from '../i18n';

/** No replay on mount. Only the selected live private Port receives completion. */
export function SharedUnlockNotice({ unlocked }: { unlocked: boolean }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
    let alive = true;
    let port: chrome.runtime.Port | null = null;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { clearTimeout(expiry); setShown(false); };
    const visible = () => {
      if (document.visibilityState !== 'visible') clear();
      try { port?.postMessage({ type: 'visibility', visible: document.visibilityState === 'visible' }); } catch { clear(); }
    };
    const connect = () => {
      if (!alive) return;
      try {
        const next = chrome.runtime.connect({ name: SHARED_UNLOCK_NOTICE_PORT });
        port = next;
        next.onMessage.addListener((raw: unknown) => {
          if (!alive || port !== next || !isSharedUnlockNotice(raw)) return;
          if (raw.type === 'clear') { clear(); return; }
          const age = Date.now() - raw.occurredAt;
          if (document.visibilityState !== 'visible' || age < 0 || age >= 2000) return;
          clearTimeout(expiry); setShown(true);
          expiry = setTimeout(clear, 4000 - age);
        });
        next.onDisconnect.addListener(() => {
          if (!alive || port !== next) return;
          port = null; clear();
          try { if (chrome.runtime.id) reconnect = setTimeout(connect, 1000); }
          catch { /* An invalidated extension page cannot reconnect to a replacement. */ }
        });
        visible();
      } catch { clear(); /* Invalidated extension context cannot receive a new completion. */ }
    };
    document.addEventListener('visibilitychange', visible);
    connect();
    return () => {
      alive = false;
      clearTimeout(expiry); clearTimeout(reconnect);
      document.removeEventListener('visibilitychange', visible);
      try { port?.disconnect(); } catch { /* Worker or extension already closed. */ }
    };
  }, []);
  useEffect(() => { if (!unlocked) setShown(false); }, [unlocked]);
  return <div className="shared-unlock-notice" role="status" aria-live="polite" aria-atomic="true">
    {shown && unlocked ? t('unlock.sharedUnlockCompleted') : null}
  </div>;
}
