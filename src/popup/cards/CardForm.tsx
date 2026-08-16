import { useState } from "react";

import { Button } from "../components/Button";
import { useI18n, type Translate } from "../i18n";
import type { VaultClient } from "../vault/client";

type SaveStatus = "idle" | "saving" | "saved" | "blocked" | "error";

const INITIAL = {
  label: "",
  cardholderName: "",
  cardNumber: "",
  expiryMonth: "",
  expiryYear: "",
  billingAddress: "",
  notes: "",
};

export function CardForm({ client }: { client: VaultClient }): React.JSX.Element {
  const { t } = useI18n();
  const [card, setCard] = useState(INITIAL);
  const [status, setStatus] = useState<SaveStatus>("idle");

  function update(field: keyof typeof INITIAL, value: string): void {
    setCard((current) => ({ ...current, [field]: value }));
    setStatus("idle");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatus("saving");
    try {
      const result = await client.saveCreditCard({
        label: card.label,
        cardholderName: card.cardholderName,
        cardNumber: card.cardNumber,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        ...(card.billingAddress ? { billingAddress: card.billingAddress } : {}),
        ...(card.notes ? { notes: card.notes } : {}),
      });
      if (result.status === "blocked") {
        setStatus("blocked");
        return;
      }
      setCard(INITIAL);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  return (
    <form className="card-form" onSubmit={(event) => void submit(event)}>
      <p className="card-form-note">
        {t("card.note")}
      </p>
      <CardField label={t("card.label")} value={card.label} onChange={(value) => update("label", value)} required autoComplete="off" />
      <CardField label={t("card.cardholder")} value={card.cardholderName} onChange={(value) => update("cardholderName", value)} required autoComplete="cc-name" />
      <CardField label={t("card.number")} isCardNumber value={card.cardNumber} onChange={(value) => update("cardNumber", value)} required autoComplete="cc-number" inputMode="numeric" pattern="[0-9 -]{8,32}" />
      <div className="card-form-expiry">
        <CardField label={t("card.expiryMonth")} value={card.expiryMonth} onChange={(value) => update("expiryMonth", value)} required autoComplete="cc-exp-month" inputMode="numeric" pattern="(0[1-9]|1[0-2])" placeholder="MM" />
        <CardField label={t("card.expiryYear")} value={card.expiryYear} onChange={(value) => update("expiryYear", value)} required autoComplete="cc-exp-year" inputMode="numeric" pattern="[0-9]{4}" placeholder="YYYY" />
      </div>
      <label>
        <span className="field-label">{t("card.billingAddress")}</span>
        <textarea
          className="field-input card-form-textarea"
          autoComplete="billing street-address"
          maxLength={2048}
          value={card.billingAddress}
          onChange={(event) => update("billingAddress", event.target.value)}
        />
      </label>
      <label>
        <span className="field-label">{t("card.notes")}</span>
        <textarea
          className="field-input card-form-textarea"
          autoComplete="off"
          maxLength={4096}
          value={card.notes}
          onChange={(event) => update("notes", event.target.value)}
        />
      </label>
      <Button type="submit" loading={status === "saving"} disabled={status === "saving"}>
        {t("card.save")}
      </Button>
      <p className="card-form-status" role="status">{statusMessage(status, t)}</p>
    </form>
  );
}

interface CardFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly required?: boolean;
  readonly autoComplete: string;
  readonly inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  readonly pattern?: string;
  readonly placeholder?: string;
  readonly isCardNumber?: boolean;
}

function CardField(props: CardFieldProps): React.JSX.Element {
  return (
    <label>
      <span className="field-label">{props.label}</span>
      <input
        className="field-input"
        type="text"
        maxLength={props.isCardNumber ? 32 : 256}
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

function statusMessage(status: SaveStatus, t: Translate): string {
  if (status === "saved") return t("card.saved");
  if (status === "blocked") return t("card.blocked");
  if (status === "error") return t("card.error");
  return "";
}
