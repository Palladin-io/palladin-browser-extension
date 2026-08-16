import { useEffect, useState, type FormEvent } from "react";

import { PRODUCTION_API_URL, normalizeServerUrl } from "@shared/config/server";

import { Button } from "../components/Button";
import { FormInput } from "../components/FormInput";
import { useI18n, type Translate } from "../i18n";
import {
  ServerConfigClientError,
  type ServerConfigClient,
} from "../config/client";

export interface ServerSettingsProps {
  client: ServerConfigClient;
  onChanged(): void;
}

export function ServerSettings({ client, onChanged }: ServerSettingsProps): React.JSX.Element {
  const { t } = useI18n();
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
        if (active) setError(t("settings.server.readError"));
      });
    return () => { active = false; };
  }, [client, t]);

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
      setNotice(status.changed ? t("settings.server.updated") : t("settings.server.unchanged"));
      if (status.changed) onChanged();
    } catch (cause) {
      setError(serverError(cause, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="server-settings">
      <h2 className="screen-title">{t("settings.server.title")}</h2>
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
            setError("");
            setNotice("");
          }}
        />
        <p className="settings-warning">
          {t("settings.server.warning")}
        </p>
        {notice ? <p className="settings-notice" role="status">{notice}</p> : null}
        <div className="settings-actions">
          <Button type="button" variant="ghost" onClick={() => setInput(PRODUCTION_API_URL)} disabled={busy}>
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
