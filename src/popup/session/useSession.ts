/**
 * The popup's session state machine. It owns the coarse {@link SessionPhase}
 * and the small amount of state that must survive a screen transition — the
 * popup copy of a pending TOTP challenge. The password-derived key stays only
 * in the service worker's host-bound pending context.
 * The service worker independently owns and host-binds the authoritative
 * challenge context. Screens call
 * the returned actions and handle their own inline errors and busy state; the
 * actions here re-throw so a screen can localise the failure and stay put.
 *
 * SECURITY: the popup never retains the password after the login command.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionCapabilities } from "../../background/session/capabilities";
import type { SessionStatus } from "../../background/session/types";
import type { SessionClient } from "./client";

export type SessionPhase =
  | "loading"
  | "signed-out"
  | "totp"
  | "locked"
  | "unlocked"
  | "unavailable";

interface PendingTotp {
  readonly challengeToken: string;
}

export interface UseSession {
  phase: SessionPhase;
  capabilities: SessionCapabilities | null;
  /** Begin login. Resolves once the worker has either unlocked or asked for TOTP. */
  signIn(email: string, password: string): Promise<void>;
  /** Finish the second factor for the pending challenge. */
  submitTotp(code: string): Promise<void>;
  /** Abandon the pending TOTP challenge and drop the retained password. */
  cancelTotp(): void;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  signOut(): Promise<void>;
  /** Re-read status after an initial load failure (worker asleep). */
  retryInit(): void;
  /** Apply a value-free worker lifecycle event to every open extension surface. */
  synchronize(status: SessionStatus): void;
}

function phaseFor(status: SessionStatus): SessionPhase {
  return status;
}

export function useSession(client: SessionClient): UseSession {
  const [phase, setPhase] = useState<SessionPhase>("loading");
  const [capabilities, setCapabilities] = useState<SessionCapabilities | null>(null);
  const pendingTotp = useRef<PendingTotp | null>(null);
  // Worker events and newer user actions supersede every in-flight UI result.
  // A slow initial status read must never undo a later committed unlock/lock.
  const revision = useRef(0);
  const [initNonce, setInitNonce] = useState(0);

  useEffect(() => {
    let active = true;
    const ownRevision = ++revision.current;
    setPhase("loading");
    void (async () => {
      try {
        const [status, caps] = await Promise.all([
          client.getStatus(),
          client.getCapabilities().catch(() => null),
        ]);
        if (!active || revision.current !== ownRevision) return;
        setCapabilities(caps);
        setPhase(phaseFor(status));
      } catch {
        if (active && revision.current === ownRevision) setPhase("unavailable");
      }
    })();
    return () => {
      active = false;
      if (revision.current === ownRevision) revision.current += 1;
    };
  }, [client, initNonce]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const ownRevision = ++revision.current;
      const result = await client.login(email, password);
      if (revision.current !== ownRevision) return;
      if (result.status === "totp-required") {
        pendingTotp.current = { challengeToken: result.challengeToken };
        setPhase("totp");
        return;
      }
      setPhase("unlocked");
    },
    [client],
  );

  const submitTotp = useCallback(
    async (code: string) => {
      const ownRevision = ++revision.current;
      const pending = pendingTotp.current;
      if (!pending) {
        setPhase("signed-out");
        return;
      }
      const status = await client.completeTotp(pending.challengeToken, code);
      if (revision.current !== ownRevision) return;
      pendingTotp.current = null;
      setPhase(phaseFor(status));
    },
    [client],
  );

  const cancelTotp = useCallback(() => {
    revision.current += 1;
    void client.cancelTotp();
    pendingTotp.current = null;
    setPhase("signed-out");
  }, [client]);

  const unlock = useCallback(
    async (password: string) => {
      const ownRevision = ++revision.current;
      const status = await client.unlock(password);
      if (revision.current !== ownRevision) return;
      setPhase(phaseFor(status));
    },
    [client],
  );

  const lock = useCallback(async () => {
    const ownRevision = ++revision.current;
    await client.lock();
    if (revision.current !== ownRevision) return;
    setPhase("locked");
  }, [client]);

  const signOut = useCallback(async () => {
    const ownRevision = ++revision.current;
    await client.logout();
    if (revision.current !== ownRevision) return;
    pendingTotp.current = null;
    setPhase("signed-out");
  }, [client]);

  const retryInit = useCallback(() => {
    revision.current += 1;
    pendingTotp.current = null;
    setInitNonce((n) => n + 1);
  }, []);

  const synchronize = useCallback((status: SessionStatus) => {
    revision.current += 1;
    pendingTotp.current = null;
    setPhase(phaseFor(status));
  }, []);

  return {
    phase,
    capabilities,
    signIn,
    submitTotp,
    cancelTotp,
    unlock,
    lock,
    signOut,
    retryInit,
    synchronize,
  };
}
