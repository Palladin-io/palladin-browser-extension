import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { SecretKeyTransferOffer } from "../../background/session/secret-key-enrollment";
import { Button } from "../components/Button";
import { FormInput } from "../components/FormInput";
import { Spinner } from "../components/Spinner";
import { useI18n } from "../i18n";
import type { SessionClient } from "../session/client";
import { messageForError } from "../session/errors";
import { QrCode } from "./QrCode";

const POLL_INTERVAL_MS = 2_000;

export type SecretKeyActions = Pick<
  SessionClient,
  "startSecretKeyTransfer" | "pollSecretKeyTransfer" | "submitSecretKey" | "cancelSecretKey"
>;

export interface SecretKeyStepProps {
  actions: SecretKeyActions;
  /** The worker now holds the Secret Key; finish the sign-in that asked for it. */
  onReady(): Promise<void>;
  onBack(): void;
}

/**
 * New browser without the Secret Key: show a one-time pairing QR for a signed-in
 * device, or accept the PSK2 text from the Emergency Kit. Only the worker sees
 * the Secret Key; this surface handles the QR, the SAS and typed input.
 */
export function SecretKeyStep({ actions, onReady, onBack }: SecretKeyStepProps): React.JSX.Element {
  const [mode, setMode] = useState<"transfer" | "manual">("transfer");
  const back = useCallback(() => {
    void actions.cancelSecretKey().catch(() => undefined);
    onBack();
  }, [actions, onBack]);
  return mode === "transfer"
    ? <TransferMode actions={actions} onReady={onReady} onBack={back} onManual={() => setMode("manual")} />
    : <ManualMode actions={actions} onReady={onReady} onBack={back} onTransfer={() => setMode("transfer")} />;
}

function TransferMode({ actions, onReady, onBack, onManual }: Omit<SecretKeyStepProps, "onBack"> & {
  onBack(): void;
  onManual(): void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [offer, setOffer] = useState<SecretKeyTransferOffer | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setOffer(null);
    setError("");
    const fail = (err: unknown) => {
      if (!active) return;
      setOffer(null);
      setError(messageForError(err, "secret-key", t));
    };
    const poll = async (expiresAt: number) => {
      if (!active) return;
      if (Date.now() >= expiresAt) {
        setOffer(null);
        setError(t("auth.secretKey.transfer.expired"));
        return;
      }
      try {
        const status = await actions.pollSecretKeyTransfer();
        if (!active) return;
        if (status === "ready") {
          await onReadyRef.current();
          return;
        }
      } catch (err) {
        if (!(err instanceof Error) || !("code" in err) || err.code !== "network") return fail(err);
      }
      timer = setTimeout(() => void poll(expiresAt), POLL_INTERVAL_MS);
    };
    void (async () => {
      try {
        const started = await actions.startSecretKeyTransfer();
        if (!active) return;
        setOffer(started);
        timer = setTimeout(() => void poll(started.expiresAt), POLL_INTERVAL_MS);
      } catch (err) {
        fail(err);
      }
    })();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [actions, attempt, t]);

  useEffect(() => {
    if (!offer) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [offer]);

  const remaining = offer ? Math.max(0, Math.ceil((offer.expiresAt - now) / 1_000)) : 0;
  const countdown = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;

  return (
    <section className="auth-form-panel">
      <h2 className="screen-title">{t("auth.secretKey.transfer.title")}</h2>
      <p className="screen-subtitle">{t("auth.secretKey.transfer.subtitle")}</p>
      {offer ? (
        <div className="secret-key-transfer">
          <QrCode payload={offer.qrPayload} label={t("auth.secretKey.transfer.qrLabel")} />
          <div className="secret-key-sas">
            <span>{t("auth.secretKey.transfer.sasLabel")}</span>
            <strong data-testid="secret-key-sas">{offer.sas}</strong>
          </div>
          <div className="secret-key-status">
            <span><Spinner />{t("auth.secretKey.transfer.waiting")}</span>
            <span>{t("auth.secretKey.transfer.expiresIn", { time: countdown })}</span>
          </div>
        </div>
      ) : error ? (
        <div className="form">
          <p className="field-feedback" role="alert">{error}</p>
          <Button variant="subtle" block onClick={() => setAttempt((n) => n + 1)}>
            {t("common.tryAgain")}
          </Button>
        </div>
      ) : (
        <div className="centered"><Spinner /></div>
      )}
      <div className="form secret-key-actions">
        <Button variant="subtle" block onClick={onManual}>{t("auth.secretKey.transfer.manual")}</Button>
        <Button variant="ghost" block onClick={onBack}>{t("common.back")}</Button>
      </div>
    </section>
  );
}

function ManualMode({ actions, onReady, onBack, onTransfer }: Omit<SecretKeyStepProps, "onBack"> & {
  onBack(): void;
  onTransfer(): void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [secretKey, setSecretKey] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = secretKey.trim().length > 0 && !submitting;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setError("");
    setSubmitting(true);
    try {
      await actions.submitSecretKey(secretKey.trim());
    } catch (err) {
      setError(messageForError(err, "secret-key", t));
      setSubmitting(false);
      return;
    }
    await onReady();
  }

  return (
    <section className="auth-form-panel">
      <h2 className="screen-title">{t("auth.secretKey.manual.title")}</h2>
      <p className="screen-subtitle">{t("auth.secretKey.manual.subtitle")}</p>
      <form className="form" onSubmit={handleSubmit} noValidate>
        <FormInput
          label={t("auth.secretKey.manual.label")}
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          autoFocus
          placeholder="PSK2-"
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          error={error}
          disabled={submitting}
        />
        <p className="secret-key-hint">{t("auth.secretKey.manual.hint")}</p>
        <p className="secret-key-hint">{t("auth.secretKey.manual.remember")}</p>
        <Button type="submit" variant="accent" block disabled={!canSubmit} loading={submitting}>
          {t("auth.secretKey.manual.action")}
        </Button>
        <Button type="button" variant="subtle" block onClick={onTransfer} disabled={submitting}>
          {t("auth.secretKey.manual.transfer")}
        </Button>
        <Button type="button" variant="ghost" block onClick={onBack} disabled={submitting}>
          {t("common.back")}
        </Button>
      </form>
    </section>
  );
}
