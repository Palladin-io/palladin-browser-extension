/**
 * Copy one decrypted field to the clipboard on click. The value is revealed
 * (decrypted in the worker) only in response to this explicit user action, then
 * written to the clipboard and dropped — the popup keeps no copy. The worker
 * arms a clipboard wipe when it serves a reveal, so the secret does not linger.
 *
 * The label flips to a transient "Copied" / "Failed" so the click has feedback
 * without a toast system.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { clipboardCopyAvailable } from "@shared/config/build-target";
import type { VaultRevealField } from "../../background/vault/commands";
import type { VaultClient } from "../vault/client";
import { useI18n } from "../i18n";

export interface CopyButtonProps {
  client: VaultClient;
  vaultId: string;
  entryId: string;
  field: VaultRevealField;
  label: string;
}

type CopyState = "idle" | "copied" | "error";

export function CopyButton({
  ...props
}: CopyButtonProps): React.JSX.Element | null {
  return clipboardCopyAvailable ? <EnabledCopyButton {...props} /> : null;
}

function EnabledCopyButton({
  client,
  vaultId,
  entryId,
  field,
  label,
}: CopyButtonProps): React.JSX.Element {
  const { t } = useI18n();
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const flash = useCallback((next: CopyState) => {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1500);
  }, []);

  const copy = useCallback(async () => {
    try {
      const value = await client.reveal(vaultId, entryId, field);
      await navigator.clipboard.writeText(value);
      flash("copied");
    } catch {
      flash("error");
    }
  }, [client, vaultId, entryId, field, flash]);

  const text = state === "copied" ? t("common.copied") : state === "error" ? t("common.failed") : label;
  return (
    <button type="button" className="chip-btn" onClick={() => void copy()}>
      {text}
    </button>
  );
}
