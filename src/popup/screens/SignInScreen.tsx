import { useState, type FormEvent } from "react";

import { Button } from "../components/Button";
import { FormInput } from "../components/FormInput";
import { messageForError, PopupSessionError } from "../session/errors";
import { useI18n } from "../i18n";
import { SecretKeyStep, type SecretKeyActions } from "../secret-key/SecretKeyStep";
import type { SignInOutcome } from "../session/useSession";

/**
 * Signed-out state: email + master password. On submit the worker either
 * unlocks or reports that a TOTP second factor is required (handled a level up
 * by switching to the TOTP screen). The email is trimmed on submit; the master
 * password is passed exactly as typed — trimming it would change the derived key
 * (and diverge from the web panel, which also never trims it).
 *
 * An Identity v2 account on a browser without its Secret Key switches to the
 * Secret Key step; once the worker holds the key, the same typed credentials
 * finish the sign-in. Leaving the step drops the password.
 */
export interface SignInScreenProps {
  onSignIn(email: string, password: string): Promise<SignInOutcome>;
  onCreateAccount(): Promise<void>;
  secretKey: SecretKeyActions;
}

export function SignInScreen({ onSignIn, onCreateAccount, secretKey }: SignInScreenProps): React.JSX.Element {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState<"form" | "secret-key">("form");
  const [offerSecretKey, setOfferSecretKey] = useState(false);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  async function signIn(): Promise<void> {
    setError("");
    setOfferSecretKey(false);
    setSubmitting(true);
    try {
      if (await onSignIn(email.trim(), password) === "secret-key-required") {
        setStep("secret-key");
        setSubmitting(false);
      }
    } catch (err) {
      setStep("form");
      setError(messageForError(err, "sign-in", t));
      // A wrong password and a stale Secret Key look the same to the server.
      setOfferSecretKey(err instanceof PopupSessionError && err.code === "invalid-credentials");
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    await signIn();
  }

  if (step === "secret-key") {
    return (
      <SecretKeyStep
        actions={secretKey}
        onReady={signIn}
        onBack={() => {
          setPassword("");
          setStep("form");
        }}
      />
    );
  }

  return (
    <section className="auth-form-panel">
      <h2 className="screen-title">{t("auth.signIn.title")}</h2>
      <form className="form" onSubmit={handleSubmit} noValidate>
        <FormInput
          label={t("auth.email")}
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
        />
        <FormInput
          label={t("auth.masterPassword")}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
          disabled={submitting}
        />
        <Button type="submit" variant="accent" block disabled={!canSubmit} loading={submitting}>
          {t("auth.signIn.action")}
        </Button>
        {offerSecretKey ? (
          <button className="link-btn" type="button" onClick={() => setStep("secret-key")}>
            {t("auth.secretKey.replace")}
          </button>
        ) : null}
      </form>
      <div className="auth-registration">
        <span>{t("auth.signIn.noAccount")}</span>
        <button className="link-btn" type="button" onClick={() => void onCreateAccount()}>
          {t("auth.signIn.createAccount")}
        </button>
      </div>
    </section>
  );
}
