import {
  PASSPHRASE_DEFAULT_WORDS,
  PASSPHRASE_MAX_WORDS,
  PASSPHRASE_MIN_WORDS,
  PASSWORD_DEFAULT_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  generatePassphrase,
  generatePassword,
  type PassphraseSeparator,
} from "@palladin/crypto";
import { useCallback, useState } from "react";

import { clipboardCopyAvailable } from "@shared/config/build-target";
import type { CaptureGeneratedFillResult, CaptureSaveResult } from "@shared/messaging/capture";

import { Button } from "../components/Button";
import { useI18n, type Translate } from "../i18n";
import type { VaultClient } from "../vault/client";

type GeneratorMode = "password" | "passphrase";
type ActionStatus = "idle" | "copied" | "filled" | "saved" | "no-form" | "blocked" | "error";

export interface CaptureGeneratorContext {
  readonly site: string;
  fill(value: string): Promise<CaptureGeneratedFillResult>;
  save(value: string): Promise<CaptureSaveResult>;
}

export function GeneratorPanel({
  client,
  capture,
}: {
  client: VaultClient;
  capture?: CaptureGeneratorContext;
}): React.JSX.Element {
  const { t } = useI18n();
  const [mode, setMode] = useState<GeneratorMode>("password");
  const [length, setLength] = useState(PASSWORD_DEFAULT_LENGTH);
  const [digits, setDigits] = useState(true);
  const [symbols, setSymbols] = useState(true);
  const [words, setWords] = useState(PASSPHRASE_DEFAULT_WORDS);
  const [separator, setSeparator] = useState<PassphraseSeparator>("-");
  const [capitalize, setCapitalize] = useState(false);
  const [includeNumber, setIncludeNumber] = useState(true);
  const makeValue = useCallback(
    () =>
      mode === "password"
        ? generatePassword({ length, digits, symbols })
        : generatePassphrase({ words, separator, capitalize, includeNumber }),
    [capitalize, digits, includeNumber, length, mode, separator, symbols, words],
  );
  const [value, setValue] = useState(() =>
    generatePassword({ length: PASSWORD_DEFAULT_LENGTH, digits: true, symbols: true }),
  );
  const [status, setStatus] = useState<ActionStatus>("idle");
  const [saveReady, setSaveReady] = useState(false);

  function regenerate(nextMode = mode): void {
    setStatus("idle");
    setSaveReady(false);
    setValue(
      nextMode === "password"
        ? generatePassword({ length, digits, symbols })
        : generatePassphrase({ words, separator, capitalize, includeNumber }),
    );
  }

  function changeMode(nextMode: GeneratorMode): void {
    setMode(nextMode);
    regenerate(nextMode);
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      await client.armClipboardClear();
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  }

  async function fill(): Promise<void> {
    try {
      if (capture) {
        const result = await capture.fill(value);
        setStatus(result.status === "filled" ? "filled" : result.status === "no-form" ? "no-form" : "blocked");
        setSaveReady(result.status === "filled" && result.saveAvailable);
        return;
      }
      const result = await client.fillGenerated(value);
      setStatus(result.status === "filled" ? "filled" : result.status === "no-form" ? "no-form" : "blocked");
      setSaveReady(false);
    } catch {
      setStatus("error");
    }
  }

  async function save(): Promise<void> {
    if (!capture || !saveReady) return;
    try {
      const result = await capture.save(value);
      setStatus(result.status === "saved" ? "saved" : "blocked");
      if (result.status === "saved") setSaveReady(false);
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="generator">
      <div className="generator-mode" role="group" aria-label={t("generator.type")}>
        <button type="button" className={mode === "password" ? "generator-mode-active" : ""} onClick={() => changeMode("password")}>{t("generator.password")}</button>
        <button type="button" className={mode === "passphrase" ? "generator-mode-active" : ""} onClick={() => changeMode("passphrase")}>{t("generator.passphrase")}</button>
      </div>

      <output className="generator-output" aria-label={t("generator.generatedValue")}>{value}</output>

      {mode === "password" ? (
        <div className="generator-options">
          <label className="generator-range">
            <span>{t("generator.length")} <strong>{length}</strong></span>
            <input aria-label={t("generator.passwordLength")} type="range" min={PASSWORD_MIN_LENGTH} max={PASSWORD_MAX_LENGTH} value={length} onChange={(event) => setLength(Number(event.target.value))} />
          </label>
          <Check label={t("generator.numbers")} checked={digits} onChange={setDigits} />
          <Check label={t("generator.symbols")} checked={symbols} onChange={setSymbols} />
        </div>
      ) : (
        <div className="generator-options">
          <label className="generator-range">
            <span>{t("generator.words")} <strong>{words}</strong></span>
            <input aria-label={t("generator.passphraseWords")} type="range" min={PASSPHRASE_MIN_WORDS} max={PASSPHRASE_MAX_WORDS} value={words} onChange={(event) => setWords(Number(event.target.value))} />
          </label>
          <label className="generator-select">{t("generator.separator")}
            <select value={separator} onChange={(event) => setSeparator(event.target.value as PassphraseSeparator)}>
              <option value="-">{t("generator.hyphen")}</option><option value=".">{t("generator.dot")}</option><option value="_">{t("generator.underscore")}</option><option value=" ">{t("generator.space")}</option>
            </select>
          </label>
          <Check label={t("generator.capitalize")} checked={capitalize} onChange={setCapitalize} />
          <Check label={t("generator.addNumber")} checked={includeNumber} onChange={setIncludeNumber} />
        </div>
      )}

      <div className="generator-actions">
        <Button variant="subtle" onClick={() => { setValue(makeValue()); setStatus("idle"); setSaveReady(false); }}>{t("generator.regenerate")}</Button>
        {clipboardCopyAvailable ? <Button variant="subtle" onClick={copy}>{t("common.copy")}</Button> : null}
        <Button onClick={fill}>{t("common.fill")}</Button>
        {capture && saveReady ? <Button onClick={save}>{t("generator.saveToPalladin")}</Button> : null}
      </div>
      <p className="generator-status" role="status">{statusText(status, t)}</p>
      <p className="generator-note">
        {capture
          ? t("generator.captureNote", { site: capture.site })
          : t("generator.memoryNote")}
      </p>
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }): React.JSX.Element {
  return <label className="generator-check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function statusText(status: ActionStatus, t: Translate): string {
  if (status === "copied") return t("generator.copied");
  if (status === "filled") return t("generator.filled");
  if (status === "saved") return t("generator.saved");
  if (status === "no-form") return t("generator.noForm");
  if (status === "blocked") return t("generator.blocked");
  if (status === "error") return t("generator.error");
  return "";
}
