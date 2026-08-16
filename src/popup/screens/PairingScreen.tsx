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

export interface PairingScreenProps {
  client: AgentPairingClient;
}

export function PairingScreen({ client }: PairingScreenProps): React.JSX.Element {
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
        if (active) setError("Can't read Agent runtime pairing status.");
      });
    return () => { active = false; };
  }, [client]);

  if (status === null && error === null) {
    return (
      <section className="pairing-screen">
        <h2 className="screen-title">Agent runtime</h2>
        <div className="centered pairing-loading">
          <Spinner />
          <span className="muted">Checking pairing status…</span>
        </div>
      </section>
    );
  }

  if (status?.paired) {
    return (
      <section className="pairing-screen">
        <h2 className="screen-title">Agent runtime</h2>
        <p className="screen-subtitle">
          This extension accepts Agent fill requests only from the pinned local runtime.
        </p>
        <div className="pairing-status-card">
          <span className="pairing-status-label">Paired fingerprint</span>
          <code className="pairing-fingerprint">
            {shortenPublicIdentifier(status.fingerprint)}
          </code>
        </div>
        {error ? <p className="pairing-error" role="alert">{error}</p> : null}
        <Button variant="danger" block loading={busy} onClick={() => void unpair()}>
          Unpair runtime
        </Button>
      </section>
    );
  }

  const malformed = bundleInput.length > 0 && bundle === null;
  return (
    <section className="pairing-screen">
      <h2 className="screen-title">Pair Agent runtime</h2>
      <p className="screen-subtitle">
        Run <code>palladin browser install</code> in a trusted terminal, then paste its
        one-line pairing bundle here. Native Messaging cannot create or replace this pin.
      </p>
      <label className="field-label" htmlFor="agent-pairing-bundle">Pairing bundle</label>
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
        <p className="pairing-error" role="alert">Pairing bundle is malformed.</p>
      ) : null}
      {bundle !== null ? (
        <div className="pairing-confirmation">
          <span className="pairing-status-label">Fingerprint to verify</span>
          <code className="pairing-fingerprint">
            {shortenPublicIdentifier(bundle.fingerprint)}
          </code>
          <label className="pairing-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>I verified this fingerprint in the Palladin Runtime terminal.</span>
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
        Pair runtime
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
      setError(pairingError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function unpair(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setStatus(await client.clear());
    } catch {
      setError("Couldn't unpair the Agent runtime. Try again.");
    } finally {
      setBusy(false);
    }
  }
}

function pairingError(error: unknown): string {
  if (error instanceof AgentPairingClientError) {
    if (error.code === "fingerprint-mismatch") {
      return "Fingerprint mismatch. Generate a new pairing bundle and verify it again.";
    }
    if (error.code === "invalid-bundle") return "Pairing bundle is malformed.";
  }
  return "Couldn't pair the Agent runtime. Try again.";
}
