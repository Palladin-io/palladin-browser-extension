import { useState, type FormEvent } from "react";

import { Button } from "../components/Button";
import { FormInput } from "../components/FormInput";
import { messageForError } from "../session/errors";

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
  /** From the worker's capability probe; gates the biometric button. */
  biometricAvailable: boolean;
  /** Wired in E2; unused while `biometricAvailable` is false. */
  onBiometricUnlock?: () => void;
}

export function UnlockScreen({
  onUnlock,
  biometricAvailable,
  onBiometricUnlock,
}: UnlockScreenProps): React.JSX.Element {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = password.length > 0 && !submitting;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setError("");
    setSubmitting(true);
    try {
      await onUnlock(password);
    } catch (err) {
      setError(messageForError(err, "unlock"));
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h2 className="screen-title">Unlock</h2>
      <p className="screen-subtitle">Enter your master password to unlock your vault.</p>
      <form className="form" onSubmit={handleSubmit} noValidate>
        <FormInput
          label="Master password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
          disabled={submitting}
        />
        <Button type="submit" variant="accent" block disabled={!canSubmit} loading={submitting}>
          Unlock
        </Button>
        {biometricAvailable ? (
          <Button
            type="button"
            variant="subtle"
            block
            onClick={onBiometricUnlock}
            disabled={submitting}
          >
            Unlock with Touch ID
          </Button>
        ) : null}
      </form>
    </section>
  );
}
