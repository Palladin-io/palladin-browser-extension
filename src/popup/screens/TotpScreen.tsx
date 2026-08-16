import { useState, type FormEvent } from "react";

import { Button } from "../components/Button";
import { FormInput } from "../components/FormInput";
import { messageForError } from "../session/errors";
import { useI18n } from "../i18n";

/**
 * Second factor: a 6-digit authenticator (or recovery) code for the pending
 * login challenge. The code is trimmed on submit, mirroring the web panel and
 * the worker's own `code.trim()`. "Back" abandons the challenge and returns to
 * sign-in, dropping the retained password.
 */
export interface TotpScreenProps {
  onSubmitTotp(code: string): Promise<void>;
  onBack(): void;
}

export function TotpScreen({ onSubmitTotp, onBack }: TotpScreenProps): React.JSX.Element {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = code.trim().length > 0 && !submitting;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setError("");
    setSubmitting(true);
    try {
      await onSubmitTotp(code.trim());
    } catch (err) {
      setError(messageForError(err, "totp", t));
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h2 className="screen-title">{t("auth.totp.title")}</h2>
      <p className="screen-subtitle">{t("auth.totp.subtitle")}</p>
      <form className="form" onSubmit={handleSubmit} noValidate>
        <FormInput
          label={t("auth.totp.code")}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={error}
          disabled={submitting}
        />
        <Button type="submit" variant="accent" block disabled={!canSubmit} loading={submitting}>
          {t("auth.totp.verify")}
        </Button>
        <Button type="button" variant="ghost" block onClick={onBack} disabled={submitting}>
          {t("common.back")}
        </Button>
      </form>
    </section>
  );
}
