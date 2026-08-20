import { useState, type FormEvent } from "react";

import { Button } from "../components/Button";
import { FormInput } from "../components/FormInput";
import { messageForError } from "../session/errors";
import { useI18n } from "../i18n";

/**
 * Locked state (still authenticated): re-derive keys from the master password,
 * no re-login. The password is passed exactly as typed (no trim).
 *
 * The biometric button is the E2 slot: shown only when the paired runtime
 * reports it can unlock via Touch ID / Windows Hello. Today the worker always
 * reports `runtimeUnlock: false`, so it stays hidden — no dead-end affordance.
 */
export interface UnlockScreenProps {
  onUnlock(password: string): Promise<void>;
  onSignOut(): Promise<void>;
  /** From the worker's capability probe; gates the biometric button. */
  biometricAvailable: boolean;
  /** Wired in E2; unused while `biometricAvailable` is false. */
  onBiometricUnlock?: () => void;
}

export function UnlockScreen({
  onUnlock,
  onSignOut,
  biometricAvailable,
  onBiometricUnlock,
}: UnlockScreenProps): React.JSX.Element {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"unlock" | "sign-out" | null>(null);

  const canSubmit = password.length > 0 && busy === null;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setError("");
    setBusy("unlock");
    try {
      await onUnlock(password);
    } catch (err) {
      setError(messageForError(err, "unlock", t));
      setBusy(null);
    }
  }

  async function handleSignOut(): Promise<void> {
    setPassword("");
    setError("");
    setBusy("sign-out");
    try {
      await onSignOut();
    } catch {
      // Logout is locally authoritative in the worker. If the command channel
      // itself failed, keep the screen retryable without restoring plaintext.
      setBusy(null);
    }
  }

  return (
    <section>
      <h2 className="screen-title">{t("auth.unlock.title")}</h2>
      <p className="screen-subtitle">{t("auth.unlock.subtitle")}</p>
      <form className="form" onSubmit={handleSubmit} noValidate>
        <FormInput
          label={t("auth.masterPassword")}
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
          disabled={busy !== null}
        />
        <Button type="submit" variant="accent" block disabled={!canSubmit} loading={busy === "unlock"}>
          {t("auth.unlock.action")}
        </Button>
        {biometricAvailable ? (
          <Button
            type="button"
            variant="subtle"
            block
            onClick={onBiometricUnlock}
            disabled={busy !== null}
          >
            {t("auth.unlock.biometric")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          block
          onClick={() => void handleSignOut()}
          disabled={busy !== null}
          loading={busy === "sign-out"}
        >
          {t("vault.signOut")}
        </Button>
      </form>
    </section>
  );
}
