import { parseConnection, type Connection } from "@shared/config/connection";
import { useEffect, useState, type FormEvent } from "react";

import { PRODUCTION_API_URL, PRODUCTION_PANEL_URL } from "@shared/config/server";

import { Button } from "../components/Button";
import { FormInput } from "../components/FormInput";
import { useI18n, type Translate } from "../i18n";
import {
  ServerConfigClientError, createConnectionClient, type ConnectionClient,
} from "../config/client";

export interface ServerSettingsProps {
  connectionsClient?: ConnectionClient;
  onChanged(): void;
  embedded?: boolean;
}

const defaultConnectionsClient = createConnectionClient();

export function ServerSettings({
  connectionsClient = defaultConnectionsClient,
  onChanged,
  embedded = false,
}: ServerSettingsProps): React.JSX.Element {
  const { t } = useI18n();
  const [current, setCurrent] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [webUrl, setWebUrl] = useState("");
  const [allowHttp, setAllowHttp] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [saved, setSaved] = useState<readonly Connection[]>([]);
  const loadConnection = (connection: Connection) => {
    setInput(connection.apiUrl); setWebUrl(connection.webUrl);
    setAllowHttp(connection.allowHttp); setEnabled(connection.sharedUnlockEnabled);
    setError("");
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void connectionsClient.get()
      .then((status) => {
        if (!active) return;
        setCurrent(status.apiUrl);
        setInput(status.apiUrl);
        setSaved(status.state.connections);
        const selected = status.state.connections.find(item => item.apiUrl === status.state.activeApiUrl);
        if (selected) loadConnection(selected);
      })
      .catch(() => {
        if (active) setError(t("settings.server.readError"));
      });
    return () => { active = false; };
  }, [connectionsClient, t]);

  const draft = { name: webUrl.trim().slice(0, 80), apiUrl: input, webUrl, allowHttp, sharedUnlockEnabled: enabled };
  const normalized = parseConnection(draft);
  const canSave = current !== null && normalized !== null && !busy;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError("");
    try {
      const status = await connectionsClient.save(draft);
      setCurrent(status.apiUrl);
      setInput(status.apiUrl);
      setSaved(status.state.connections);
      if (status.changed) onChanged();
    } catch (cause) {
      setError(serverError(cause, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="server-settings">
      {embedded ? null : <h2 className="screen-title">{t("settings.server.title")}</h2>}
      <p className="screen-subtitle">{t("settings.server.subtitle")}</p>
      <form className="server-settings-form" onSubmit={handleSubmit} noValidate>
        <FormInput
          label={t("settings.server.url")}
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
            setAllowHttp(false);
            setError("");
          }}
        />
        <FormInput label={t("settings.server.panelUrl")} type="url" value={webUrl} disabled={current === null || busy}
          onChange={event => { setWebUrl(event.target.value); setAllowHttp(false); }} />
        <label className="field-label"><input type="checkbox" checked={enabled} disabled={busy}
          onChange={event => setEnabled(event.target.checked)} /> {t("settings.server.sharedUnlock")}</label>
        <label className="field-label"><input type="checkbox" checked={allowHttp} disabled={busy}
          onChange={event => setAllowHttp(event.target.checked)} /> {t("settings.server.allowHttp")}</label>
        {(input.trim().startsWith("http:") || webUrl.trim().startsWith("http:")) &&
          <p className="settings-warning" role="note">{t("settings.server.httpWarning")}</p>}
        <p className="settings-warning">
          {t("settings.server.warning")}
        </p>
        <div className="settings-actions">
          <Button type="button" variant="ghost" onClick={() => { loadConnection(saved.find(item => item.apiUrl === PRODUCTION_API_URL && item.webUrl === PRODUCTION_PANEL_URL) ?? { name: PRODUCTION_PANEL_URL, apiUrl: PRODUCTION_API_URL, webUrl: PRODUCTION_PANEL_URL, allowHttp: false, sharedUnlockEnabled: true }); }} disabled={busy}>
            {t("settings.server.production")}
          </Button>
          <Button type="submit" variant="accent" disabled={!canSave} loading={busy}>
            {t("settings.server.save")}
          </Button>
        </div>
      </form>
    </section>
  );
}

function serverError(error: unknown, t: Translate): string {
  if (error instanceof ServerConfigClientError) {
    if (error.code === "invalid-server") {
      return t("settings.server.invalid");
    }
    if (error.code === "permission-denied") {
      return t("settings.server.permission");
    }
  }
  return t("settings.server.updateError");
}
