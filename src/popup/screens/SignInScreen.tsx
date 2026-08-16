import { useState, type FormEvent } from "react";

import { Button } from "../components/Button";
import { FormInput } from "../components/FormInput";
import { messageForError } from "../session/errors";

/**
 * Signed-out state: email + master password. On submit the worker either
 * unlocks or reports that a TOTP second factor is required (handled a level up
 * by switching to the TOTP screen). The email is trimmed on submit; the master
 * password is passed exactly as typed — trimming it would change the derived key
 * (and diverge from the web panel, which also never trims it).
 */
export interface SignInScreenProps {
  onSignIn(email: string, password: string): Promise<void>;
}

export function SignInScreen({ onSignIn }: SignInScreenProps): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !submitting;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setError("");
    setSubmitting(true);
    try {
      await onSignIn(email.trim(), password);
    } catch (err) {
      setError(messageForError(err, "sign-in"));
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h2 className="screen-title">Sign in</h2>
      <p className="screen-subtitle">Unlock Palladin for you and your agents.</p>
      <form className="form" onSubmit={handleSubmit} noValidate>
        <FormInput
          label="Email"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={submitting}
        />
        <FormInput
          label="Master password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
          disabled={submitting}
        />
        <Button type="submit" variant="accent" block disabled={!canSubmit} loading={submitting}>
          Sign in
        </Button>
      </form>
    </section>
  );
}
