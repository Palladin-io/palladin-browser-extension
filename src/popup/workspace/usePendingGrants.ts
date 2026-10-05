import { useEffect, useState } from 'react';
import type { WorkspaceClient } from './client';

export function usePendingGrants(client: WorkspaceClient): {
  badge: string | null;
  revision: number;
} {
  const [badge, setBadge] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let pending = false;
    let repeat = false;
    let previousSummary: string | null = null;
    async function refresh(invalidate = false) {
      if (pending) {
        repeat = true;
        return;
      }
      pending = true;
      try {
        const summary = await client.send({ type: 'workspace/grant-summary' });
        if (active) {
          setBadge(
            summary.pending > 99
              ? '99+'
              : summary.pending > 0
                ? String(summary.pending)
                : null,
          );
          const nextSummary = JSON.stringify(summary);
          if (invalidate || nextSummary !== previousSummary) setRevision((value) => value + 1);
          previousSummary = nextSummary;
        }
      } catch {
        /* Existing Vault actions remain available when grant access is unavailable. */
      } finally {
        pending = false;
        if (active && repeat) {
          repeat = false;
          void refresh(true);
        }
      }
    }
    const listener = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'workspace/changed'
      )
        void refresh(true);
    };
    const messages =
      typeof chrome === 'undefined' ? undefined : chrome.runtime?.onMessage;
    messages?.addListener(listener);
    const timer = setInterval(() => void refresh(), 30_000);
    void refresh();
    return () => {
      active = false;
      clearInterval(timer);
      messages?.removeListener(listener);
    };
  }, [client]);
  return { badge, revision };
}
