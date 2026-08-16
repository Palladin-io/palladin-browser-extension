import { useEffect, useState, type FormEvent } from "react";

import { PRODUCTION_API_URL, normalizeServerUrl } from "@shared/config/server";

import { Button } from "../components/Button";
import { FormInput } from "../components/FormInput";
import {
  ServerConfigClientError,
  type ServerConfigClient,
} from "../config/client";

export interface ServerSettingsProps {
  client: ServerConfigClient;
  onChanged(): void;
}

export function ServerSettings({ client, onChanged }: ServerSettingsProps): React.JSX.Element {
  const [current, setCurrent] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void client.get()
      .then((status) => {
        if (!active) return;
        setCurrent(status.apiUrl);
        setInput(status.apiUrl);
      })
      .catch(() => {
        if (active) setError("Can't read the current server.");
      });
    return () => { active = false; };
  }, [client]);

  const normalized = normalizeServerUrl(input);
  const canSave = current !== null && normalized !== null && !busy;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const status = await client.save(input.trim());
      setCurrent(status.apiUrl);
      setInput(status.apiUrl);
      setNotice(status.changed ? "Server updated. You were signed out." : "Server is unchanged.");
      if (status.changed) onChanged();
    } catch (cause) {
      setError(serverError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="server-settings">
      <h2 className="screen-title">Server</h2>
      <p className="screen-subtitle">
        Production is the default. HTTPS is required; HTTP is allowed only on localhost.
      </p>
      <form className="server-settings-form" onSubmit={handleSubmit} noValidate>
        <FormInput
          label="Server URL"
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="url"
          value={input}
          placeholder={PRODUCTION_API_URL}
          error={error}
          disabled={current === null || busy}
          onChange={(event) => {
            setInput(event.target.value);
            setError("");
            setNotice("");
          }}
        />
        <p className="settings-warning">
          Changing the server signs you out and clears the local encrypted cache.
        </p>
        {notice ? <p className="settings-notice" role="status">{notice}</p> : null}
        <div className="settings-actions">
          <Button type="button" variant="ghost" onClick={() => setInput(PRODUCTION_API_URL)} disabled={busy}>
            Use production
          </Button>
          <Button type="submit" variant="accent" disabled={!canSave} loading={busy}>
            Save server
          </Button>
        </div>
      </form>
    </section>
  );
}

function serverError(error: unknown): string {
  if (error instanceof ServerConfigClientError) {
    if (error.code === "invalid-server") {
      return "Enter an HTTPS URL or an HTTP localhost URL.";
    }
    if (error.code === "permission-denied") {
      return "Allow access to this server to use it with Palladin.";
    }
  }
  return "Couldn't update the server. Try again.";
}
