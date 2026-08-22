import { useEffect, useState } from "react";

import {
  shortenPublicIdentifier,
  type AgentPairingBundle,
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
  embedded?: boolean;
}

const INSTALL_COMMAND = "palladin browser install";

export function PairingScreen({ client, embedded = false }: PairingScreenProps): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState<AgentPairingStatus | null>(null);
  const [offer, setOffer] = useState<AgentPairingBundle | null>(null);
  const [detecting, setDetecting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    let active = true;
    void client.getStatus()
      .then(async (next) => {
        if (!active) return;
        setStatus(next);
        if (!next.paired) await detect();
      })
      .catch(() => {
        if (!active) return;
        setDetecting(false);
        setError(t("pairing.readError"));
      });
    return () => { active = false; };

    async function detect(): Promise<void> {
      try {
        const discovered = await client.discover();
        if (active) setOffer(discovered);
      } catch {
        if (active) setError(t("pairing.discoveryError"));
      } finally {
        if (active) setDetecting(false);
      }
    }
  }, [client, t]);

  if (status === null && detecting) {
    return (
      <section className="pairing-screen">
        {embedded ? null : <h2 className="screen-title">{t("pairing.runtime")}</h2>}
        <div className="centered pairing-loading">
          <Spinner />
          <span className="muted">{t("pairing.checking")}</span>
        </div>
      </section>
    );
  }

  if (status === null) {
    return (
      <section className="pairing-screen">
        {embedded ? null : <h2 className="screen-title">{t("pairing.runtime")}</h2>}
        <p className="pairing-error" role="alert">{error ?? t("pairing.readError")}</p>
      </section>
    );
  }

  if (status?.paired) {
    return (
      <section className="pairing-screen">
        {embedded ? null : <h2 className="screen-title">{t("pairing.runtime")}</h2>}
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

  return (
    <section className="pairing-screen">
      {embedded ? null : <h2 className="screen-title">{t("pairing.title")}</h2>}
      <p className="screen-subtitle">{t("pairing.instructionsBefore")}</p>
      <div className="pairing-command">
        <code>{INSTALL_COMMAND}</code>
        <Button variant="subtle" onClick={() => void copyInstallCommand()}>
          {copyStatus === "copied"
            ? t("common.copied")
            : copyStatus === "failed"
              ? t("common.failed")
              : t("common.copy")}
        </Button>
      </div>
      <p className="screen-subtitle">{t("pairing.instructionsAfter")}</p>
      {detecting ? (
        <div className="centered pairing-loading">
          <Spinner />
          <span className="muted">{t("pairing.detecting")}</span>
        </div>
      ) : null}
      {offer !== null ? (
        <div className="pairing-confirmation">
          <span className="pairing-status-label">{t("pairing.verifyFingerprint")}</span>
          <code className="pairing-fingerprint">
            {shortenPublicIdentifier(offer.fingerprint)}
          </code>
          <p className="pairing-confirmation-copy">{t("pairing.confirm")}</p>
        </div>
      ) : null}
      {error ? (
        <div className="pairing-feedback">
          <p className="pairing-error" role="alert">{error}</p>
        </div>
      ) : null}
      {offer === null && !detecting ? (
        <Button block loading={busy} onClick={() => void retryDiscovery()}>
          {t("pairing.retryDiscovery")}
        </Button>
      ) : null}
      {offer !== null ? (
        <Button block loading={busy} onClick={() => void pair()}>
          {t("pairing.action")}
        </Button>
      ) : null}
    </section>
  );

  async function copyInstallCommand(): Promise<void> {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  async function retryDiscovery(): Promise<void> {
    setBusy(true);
    setDetecting(true);
    setError(null);
    setOffer(null);
    try {
      setOffer(await client.discover());
    } catch {
      setError(t("pairing.discoveryError"));
    } finally {
      setDetecting(false);
      setBusy(false);
    }
  }

  async function pair(): Promise<void> {
    if (offer === null) return;
    setBusy(true);
    setError(null);
    try {
      const next = await client.save(JSON.stringify(offer));
      setStatus(next);
      setOffer(null);
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
      const next = await client.clear();
      setStatus(next);
      setOffer(null);
      if (!next.paired) {
        setDetecting(true);
        try {
          setOffer(await client.discover());
        } catch {
          setError(t("pairing.discoveryError"));
        } finally {
          setDetecting(false);
        }
      }
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
    if (error.code === "invalid-bundle") return t("pairing.discoveryError");
    if (error.code === "mutation-not-committed") {
      return t("pairing.notCommitted");
    }
  }
  return t("pairing.error");
}
