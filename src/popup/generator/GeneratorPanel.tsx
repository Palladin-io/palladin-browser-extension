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

import { Button } from "../components/Button";
import type { VaultClient } from "../vault/client";

type GeneratorMode = "password" | "passphrase";
type ActionStatus = "idle" | "copied" | "filled" | "no-form" | "blocked" | "error";

export function GeneratorPanel({ client }: { client: VaultClient }): React.JSX.Element {
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

  function regenerate(nextMode = mode): void {
    setStatus("idle");
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
      const result = await client.fillGenerated(value);
      setStatus(result.status === "filled" ? "filled" : result.status === "no-form" ? "no-form" : "blocked");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="generator">
      <div className="generator-mode" role="group" aria-label="Generator type">
        <button type="button" className={mode === "password" ? "generator-mode-active" : ""} onClick={() => changeMode("password")}>Password</button>
        <button type="button" className={mode === "passphrase" ? "generator-mode-active" : ""} onClick={() => changeMode("passphrase")}>Passphrase</button>
      </div>

      <output className="generator-output" aria-label="Generated value">{value}</output>

      {mode === "password" ? (
        <div className="generator-options">
          <label className="generator-range">
            <span>Length <strong>{length}</strong></span>
            <input aria-label="Password length" type="range" min={PASSWORD_MIN_LENGTH} max={PASSWORD_MAX_LENGTH} value={length} onChange={(event) => setLength(Number(event.target.value))} />
          </label>
          <Check label="Numbers" checked={digits} onChange={setDigits} />
          <Check label="Symbols" checked={symbols} onChange={setSymbols} />
        </div>
      ) : (
        <div className="generator-options">
          <label className="generator-range">
            <span>Words <strong>{words}</strong></span>
            <input aria-label="Passphrase words" type="range" min={PASSPHRASE_MIN_WORDS} max={PASSPHRASE_MAX_WORDS} value={words} onChange={(event) => setWords(Number(event.target.value))} />
          </label>
          <label className="generator-select">Separator
            <select value={separator} onChange={(event) => setSeparator(event.target.value as PassphraseSeparator)}>
              <option value="-">Hyphen</option><option value=".">Dot</option><option value="_">Underscore</option><option value=" ">Space</option>
            </select>
          </label>
          <Check label="Capitalize" checked={capitalize} onChange={setCapitalize} />
          <Check label="Add number" checked={includeNumber} onChange={setIncludeNumber} />
        </div>
      )}

      <div className="generator-actions">
        <Button variant="subtle" onClick={() => { setValue(makeValue()); setStatus("idle"); }}>Regenerate</Button>
        <Button variant="subtle" onClick={copy}>Copy</Button>
        <Button onClick={fill}>Fill</Button>
      </div>
      <p className="generator-status" role="status">{statusText(status)}</p>
      <p className="generator-note">Generated only in memory. Copied values clear after 30 seconds.</p>
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }): React.JSX.Element {
  return <label className="generator-check"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>;
}

function statusText(status: ActionStatus): string {
  if (status === "copied") return "Copied - clipboard clears in 30 seconds";
  if (status === "filled") return "Filled in the active page";
  if (status === "no-form") return "No password field found";
  if (status === "blocked") return "Fill is available only on a secure active page";
  if (status === "error") return "Action failed - try again";
  return "";
}
