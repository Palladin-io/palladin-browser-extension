/**
 * The current TOTP code for an entry, with a depleting countdown ring.
 *
 * The code is computed in the worker on demand (decrypt → RFC 6238), only when a
 * row is opened — never for every entry at once. We track an absolute expiry
 * deadline and refetch a fresh code when it lapses, so the display stays correct
 * even if the popup was backgrounded. Renders nothing when the entry has no TOTP.
 */

import { useEffect, useRef, useState } from "react";

import type { TotpView } from "../../background/vault/commands";
import type { VaultClient } from "../vault/client";
import { CopyButton } from "./CopyButton";
import { useI18n } from "../i18n";

export interface TotpBadgeProps {
  client: VaultClient;
  vaultId: string;
  entryId: string;
}

interface Live {
  code: string;
  period: number;
  /** Absolute ms deadline when this code rolls over. */
  deadline: number;
}

function toLive(view: TotpView, now: number): Live {
  return { code: view.code, period: view.period, deadline: now + view.expiresIn * 1000 };
}

/** Group a 6-digit code as "123 456" for readability; leave other lengths as-is. */
function formatCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export function TotpBadge({ client, vaultId, entryId }: TotpBadgeProps): React.JSX.Element | null {
  const { t } = useI18n();
  // undefined = still loading; null = no TOTP on this entry.
  const [live, setLive] = useState<Live | null | undefined>(undefined);
  const [remaining, setRemaining] = useState(0);
  const liveRef = useRef<Live | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const view = await client.totp(vaultId, entryId);
        if (!active) return;
        const next = view ? toLive(view, Date.now()) : null;
        liveRef.current = next;
        setLive(next);
      } catch {
        if (active) setLive(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, vaultId, entryId]);

  useEffect(() => {
    if (!live) return;
    let active = true;
    const tick = (): void => {
      const current = liveRef.current;
      if (!current) return;
      const secondsLeft = Math.max(0, Math.ceil((current.deadline - Date.now()) / 1000));
      setRemaining(secondsLeft);
      if (secondsLeft <= 0) {
        void client
          .totp(vaultId, entryId)
          .then((view) => {
            if (!active || !view) return;
            const next = toLive(view, Date.now());
            liveRef.current = next;
            setLive(next);
          })
          .catch(() => undefined);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [live, client, vaultId, entryId]);

  if (live === undefined) {
    return <div className="totp totp--loading">{t("vault.loadingCode")}</div>;
  }
  if (live === null) return null;

  const fraction = live.period > 0 ? Math.min(1, Math.max(0, remaining / live.period)) : 0;
  const radius = 8;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="totp">
      <svg className="totp-ring" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
        <circle className="totp-ring-track" cx="10" cy="10" r={radius} />
        <circle
          className="totp-ring-fill"
          cx="10"
          cy="10"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
        />
      </svg>
      <span className="totp-code">{formatCode(live.code)}</span>
      <span className="totp-secs" aria-label={t("vault.secondsLeft", { count: remaining })}>
        {remaining}s
      </span>
      <CopyButton
        client={client}
        vaultId={vaultId}
        entryId={entryId}
        field="totp"
        label={t("vault.copyCode")}
      />
    </div>
  );
}
