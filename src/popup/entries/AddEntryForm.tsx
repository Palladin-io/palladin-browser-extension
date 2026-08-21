import { useState } from "react";

import type {
  ManualCustomFieldInput,
  ManualCustomFieldType,
  ManualEntrySaveInput,
} from "../../background/vault/protocol2/service";
import { Button } from "../components/Button";
import { useI18n, type Translate } from "../i18n";
import type { VaultClient } from "../vault/client";

type EntryType = ManualEntrySaveInput["entryType"];
type Interpreter = Extract<ManualEntrySaveInput, { entryType: "script" }>["interpreter"];
type SaveStatus = "idle" | "saving" | "saved" | "blocked" | "error";

const INITIAL = {
  label: "",
  username: "",
  password: "",
  url: "",
  value: "",
  source: "",
  interpreter: "bash" as Interpreter,
  cardholderName: "",
  cardNumber: "",
  expiryMonth: "",
  expiryYear: "",
  billingAddress: "",
  notes: "",
};

export function AddEntryForm({ client }: { readonly client: VaultClient }): React.JSX.Element {
  const { t } = useI18n();
  const [entryType, setEntryType] = useState<EntryType>("credential");
  const [draft, setDraft] = useState(INITIAL);
  const [customFields, setCustomFields] = useState<ManualCustomFieldInput[]>([]);
  const [status, setStatus] = useState<SaveStatus>("idle");

  function update<K extends keyof typeof INITIAL>(field: K, value: (typeof INITIAL)[K]): void {
    setDraft((current) => ({ ...current, [field]: value }));
    setStatus("idle");
  }

  function changeType(next: EntryType): void {
    setEntryType(next);
    setDraft(INITIAL);
    setCustomFields([]);
    setStatus("idle");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus("saving");
    try {
      const result = await client.saveEntry(toSaveInput(entryType, draft, customFields));
      if (result.status === "blocked") {
        setStatus("blocked");
        return;
      }
      setDraft(INITIAL);
      setCustomFields([]);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  return (
    <form className="entry-form" onSubmit={(event) => void submit(event)}>
      <p className="entry-form-note">{t("entry.note")}</p>
      <label>
        <span className="field-label">{t("entry.type")}</span>
        <select
          className="field-input entry-form-select"
          value={entryType}
          onChange={(event) => changeType(event.target.value as EntryType)}
        >
          <option value="credential">{t("entry.typeCredential")}</option>
          <option value="key">{t("entry.typeKey")}</option>
          <option value="script">{t("entry.typeScript")}</option>
          <option value="creditCard">{t("entry.typeCard")}</option>
        </select>
      </label>

      <EntryField
        label={t("entry.label")}
        value={draft.label}
        onChange={(value) => update("label", value)}
        required
        autoComplete="off"
      />

      {entryType === "credential" ? <>
        <EntryField label={t("entry.username")} value={draft.username} onChange={(value) => update("username", value)} autoComplete="username" maxLength={512} />
        <EntryField label={t("entry.password")} value={draft.password} onChange={(value) => update("password", value)} required autoComplete="new-password" type="password" maxLength={4096} />
        <EntryField label={t("entry.url")} value={draft.url} onChange={(value) => update("url", value)} autoComplete="url" type="url" maxLength={2048} placeholder="https://example.com" />
      </> : null}

      {entryType === "key" ? (
        <EntryTextArea label={t("entry.value")} value={draft.value} onChange={(value) => update("value", value)} required maxLength={16_384} monospace />
      ) : null}

      {entryType === "script" ? <>
        <label>
          <span className="field-label">{t("entry.interpreter")}</span>
          <select className="field-input entry-form-select" value={draft.interpreter} onChange={(event) => update("interpreter", event.target.value as typeof draft.interpreter)}>
            <option value="bash">Bash</option>
            <option value="sh">Shell</option>
            <option value="node">Node.js</option>
            <option value="python">Python</option>
          </select>
        </label>
        <EntryTextArea label={t("entry.source")} value={draft.source} onChange={(value) => update("source", value)} required maxLength={65_536} monospace />
      </> : null}

      {entryType === "creditCard" ? <>
        <EntryField label={t("card.cardholder")} value={draft.cardholderName} onChange={(value) => update("cardholderName", value)} required autoComplete="cc-name" />
        <EntryField label={t("card.number")} value={draft.cardNumber} onChange={(value) => update("cardNumber", value)} required autoComplete="cc-number" inputMode="numeric" pattern="[0-9 -]{8,32}" maxLength={32} />
        <div className="entry-form-expiry">
          <EntryField label={t("card.expiryMonth")} value={draft.expiryMonth} onChange={(value) => update("expiryMonth", value)} required autoComplete="cc-exp-month" inputMode="numeric" pattern="(0[1-9]|1[0-2])" placeholder={t("card.expiryMonthPlaceholder")} />
          <EntryField label={t("card.expiryYear")} value={draft.expiryYear} onChange={(value) => update("expiryYear", value)} required autoComplete="cc-exp-year" inputMode="numeric" pattern="[0-9]{4}" placeholder={t("card.expiryYearPlaceholder")} />
        </div>
        <EntryTextArea label={t("card.billingAddress")} value={draft.billingAddress} onChange={(value) => update("billingAddress", value)} maxLength={2048} autoComplete="billing street-address" />
      </> : null}

      <EntryTextArea label={t("entry.notes")} value={draft.notes} onChange={(value) => update("notes", value)} maxLength={4096} />
      <CustomFieldsEditor fields={customFields} onChange={setCustomFields} />
      <Button type="submit" loading={status === "saving"} disabled={status === "saving"}>
        {t("entry.save")}
      </Button>
      <p className="entry-form-status" role="status">{statusMessage(status, t)}</p>
    </form>
  );
}

function toSaveInput(
  entryType: EntryType,
  draft: typeof INITIAL,
  customFields: readonly ManualCustomFieldInput[],
): ManualEntrySaveInput {
  const common = {
    label: draft.label,
    ...(draft.notes ? { notes: draft.notes } : {}),
    ...(customFields.length > 0 ? { customFields } : {}),
  };
  switch (entryType) {
    case "credential":
      return { entryType, ...common, username: draft.username, password: draft.password, ...(draft.url ? { url: draft.url } : {}) };
    case "key":
      return { entryType, ...common, value: draft.value };
    case "script":
      return { entryType, ...common, source: draft.source, interpreter: draft.interpreter };
    case "creditCard":
      return {
        entryType,
        ...common,
        cardholderName: draft.cardholderName,
        cardNumber: draft.cardNumber,
        expiryMonth: draft.expiryMonth,
        expiryYear: draft.expiryYear,
        ...(draft.billingAddress ? { billingAddress: draft.billingAddress } : {}),
      };
  }
}

function CustomFieldsEditor({
  fields,
  onChange,
}: {
  readonly fields: readonly ManualCustomFieldInput[];
  onChange(next: ManualCustomFieldInput[]): void;
}): React.JSX.Element {
  const { t } = useI18n();

  function update(id: string, patch: Partial<ManualCustomFieldInput>): void {
    onChange(fields.map((field) => field.id === id ? { ...field, ...patch } : field));
  }

  function add(): void {
    if (fields.length >= 20) return;
    onChange([...fields, {
      id: `custom:${crypto.randomUUID()}`,
      label: "",
      type: "text",
      value: "",
    }]);
  }

  function move(from: number, to: number): void {
    if (from === to || to < 0 || to >= fields.length) return;
    const next = [...fields];
    const [field] = next.splice(from, 1);
    if (field === undefined) return;
    next.splice(to, 0, field);
    onChange(next);
  }

  return (
    <section className="entry-custom-fields" aria-labelledby="entry-custom-fields-title">
      <div className="entry-custom-fields-header">
        <h3 id="entry-custom-fields-title">{t("entry.customFields")}</h3>
        <button type="button" className="entry-custom-add" onClick={add} disabled={fields.length >= 20}>
          {t("entry.customAdd")}
        </button>
      </div>
      {fields.map((field, index) => (
        <div className="entry-custom-field" key={field.id}>
          <div className="entry-custom-field-head">
            <select
              className="field-input entry-form-select entry-custom-type"
              value={field.type}
              aria-label={t("entry.customTypeNumber", { number: index + 1 })}
              onChange={(event) => update(field.id, { type: event.target.value as ManualCustomFieldType })}
            >
              <option value="text">{t("entry.customText")}</option>
              <option value="multiline">{t("entry.customMultiline")}</option>
              <option value="concealed">{t("entry.customConcealed")}</option>
            </select>
            <div className="entry-custom-order">
              <button
                type="button"
                aria-label={t("entry.customMoveUpNumber", { number: index + 1 })}
                onClick={() => move(index, index - 1)}
                disabled={index === 0}
              >
                <ReorderIcon direction="up" />
              </button>
              <button
                type="button"
                aria-label={t("entry.customMoveDownNumber", { number: index + 1 })}
                onClick={() => move(index, index + 1)}
                disabled={index === fields.length - 1}
              >
                <ReorderIcon direction="down" />
              </button>
            </div>
            <button
              type="button"
              className="entry-custom-remove"
              aria-label={t("entry.customRemoveNumber", { number: index + 1 })}
              onClick={() => onChange(fields.filter((candidate) => candidate.id !== field.id))}
            >
              ×
            </button>
          </div>
          <input
            className="field-input"
            value={field.label}
            onChange={(event) => update(field.id, { label: event.target.value })}
            aria-label={t("entry.customLabelNumber", { number: index + 1 })}
            placeholder={t("entry.customLabel")}
            maxLength={80}
            required
            autoComplete="off"
          />
          {field.type === "multiline" ? (
            <textarea
              className="field-input entry-form-textarea"
              value={field.value}
              onChange={(event) => update(field.id, { value: event.target.value })}
              aria-label={t("entry.customValueNumber", { number: index + 1 })}
              placeholder={t("entry.customValue")}
              maxLength={16_384}
              autoComplete="off"
            />
          ) : (
            <input
              className="field-input"
              type={field.type === "concealed" ? "password" : "text"}
              value={field.value}
              onChange={(event) => update(field.id, { value: event.target.value })}
              aria-label={t("entry.customValueNumber", { number: index + 1 })}
              placeholder={t("entry.customValue")}
              maxLength={16_384}
              autoComplete="off"
            />
          )}
        </div>
      ))}
    </section>
  );
}

function ReorderIcon({ direction }: { readonly direction: "up" | "down" }): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
      <path
        d={direction === "up" ? "M6 12l4-4 4 4" : "M6 8l4 4 4-4"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface EntryFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly required?: boolean;
  readonly autoComplete: string;
  readonly type?: "text" | "password" | "url";
  readonly inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  readonly pattern?: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
}

function EntryField(props: EntryFieldProps): React.JSX.Element {
  return (
    <label>
      <span className="field-label">{props.label}</span>
      <input
        className="field-input"
        type={props.type ?? "text"}
        maxLength={props.maxLength ?? 256}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        required={props.required}
        autoComplete={props.autoComplete}
        inputMode={props.inputMode}
        pattern={props.pattern}
        placeholder={props.placeholder}
      />
    </label>
  );
}

function EntryTextArea(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly required?: boolean;
  readonly maxLength: number;
  readonly autoComplete?: string;
  readonly monospace?: boolean;
}): React.JSX.Element {
  return (
    <label>
      <span className="field-label">{props.label}</span>
      <textarea
        className={`field-input entry-form-textarea${props.monospace ? " entry-form-textarea--code" : ""}`}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        required={props.required}
        maxLength={props.maxLength}
        autoComplete={props.autoComplete ?? "off"}
      />
    </label>
  );
}

function statusMessage(status: SaveStatus, t: Translate): string {
  if (status === "saved") return t("entry.saved");
  if (status === "blocked") return t("entry.blocked");
  if (status === "error") return t("entry.error");
  return "";
}
