import { useEffect, useMemo, useState } from "react";

import {
  parseAgentPairingBundle,
  shortenPublicIdentifier,
  type AgentPairingStatus,
} from "@shared/agent/pairing";

import {
  AgentPairingClientError,
  type AgentPairingClient,
} from "../agent/client";
import { Button } from "../components/Button";
import { Spinner } from "../components/Spinner";
import { useI18n, type Translate } from "../i18n";

export interface PairingScreenProps {
  client: AgentPairingClient;
}

export function PairingScreen({ client }: PairingScreenProps): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState<AgentPairingStatus | null>(null);
  const [bundleInput, setBundleInput] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bundle = useMemo(() => parseAgentPairingBundle(bundleInput), [bundleInput]);

  useEffect(() => {
    let active = true;
    void client.getStatus()
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setError(t("pairing.readError"));
      });
    return () => { active = false; };
  }, [client, t]);

  if (status === null && error === null) {
    return (
      <section className="pairing-screen">
        <h2 className="screen-title">{t("pairing.runtime")}</h2>
        <div className="centered pairing-loading">
          <Spinner />
          <span className="muted">{t("pairing.checking")}</span>
        </div>
      </section>
    );
  }

  if (status?.paired) {
    return (
      <section className="pairing-screen">
        <h2 className="screen-title">{t("pairing.runtime")}</h2>
        <p className="screen-subtitle">{t("pairing.pairedSubtitle")}</p>
        <div className="pairing-status-card">
          <span className="pairing-status-label">{t("pairing.pairedFingerprint")}</span>
          <code className="pairing-fingerprint">
            {shortenPublicIdentifier(status.fingerprint)}
          </code>
        </div>
        {error ? <p className="pairing-error" role="alert">{error}</p> : null}
        <Button variant="danger" block loading={busy} onClick={() => void unpair()}>
          {t("pairing.unpair")}
        </Button>
      </section>
    );
  }

  const malformed = bundleInput.length > 0 && bundle === null;
  return (
    <section className="pairing-screen">
      <h2 className="screen-title">{t("pairing.title")}</h2>
      <p className="screen-subtitle">
        {t("pairing.instructionsBefore")} <code>palladin browser install</code>{" "}
        {t("pairing.instructionsAfter")}
      </p>
      <label className="field-label" htmlFor="agent-pairing-bundle">{t("pairing.bundle")}</label>
      <textarea
        id="agent-pairing-bundle"
        className={`pairing-input${malformed ? " field-input--error" : ""}`}
        value={bundleInput}
        rows={4}
        spellCheck={false}
        autoComplete="off"
        placeholder='{"protocol":"palladin.inject-pairing.v1",...}'
        onChange={(event) => {
          setBundleInput(event.target.value);
          setConfirmed(false);
          setError(null);
        }}
      />
      {malformed ? (
        <p className="pairing-error" role="alert">{t("pairing.malformed")}</p>
      ) : null}
      {bundle !== null ? (
        <div className="pairing-confirmation">
          <span className="pairing-status-label">{t("pairing.verifyFingerprint")}</span>
          <code className="pairing-fingerprint">
            {shortenPublicIdentifier(bundle.fingerprint)}
          </code>
          <label className="pairing-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>{t("pairing.confirm")}</span>
          </label>
        </div>
      ) : null}
      {error ? <p className="pairing-error" role="alert">{error}</p> : null}
      <Button
        block
        loading={busy}
        disabled={bundle === null || !confirmed}
        onClick={() => void pair()}
      >
        {t("pairing.action")}
      </Button>
    </section>
  );

  async function pair(): Promise<void> {
    if (bundle === null || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const next = await client.save(bundleInput);
      setStatus(next);
      setBundleInput("");
      setConfirmed(false);
    } catch (cause) {
      setError(pairingError(cause, t));
    } finally {
      setBusy(false);
    }
  }

  async function unpair(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setStatus(await client.clear());
    } catch (cause) {
      setError(cause instanceof AgentPairingClientError
        && cause.code === "mutation-not-committed"
        ? t("pairing.unpairNotCommitted")
        : t("pairing.unpairError"));
    } finally {
      setBusy(false);
    }
  }
}

function pairingError(error: unknown, t: Translate): string {
  if (error instanceof AgentPairingClientError) {
    if (error.code === "fingerprint-mismatch") {
      return t("pairing.fingerprintMismatch");
    }
    if (error.code === "invalid-bundle") return t("pairing.malformed");
    if (error.code === "mutation-not-committed") {
      return t("pairing.notCommitted");
    }
  }
  return t("pairing.error");
}
