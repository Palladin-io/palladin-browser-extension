import { useState } from "react";

import { Button } from "../components/Button";
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
        Save cardholder, card number, expiry, and billing details in your encrypted vault.
      </p>
      <CardField label="Card label" value={card.label} onChange={(value) => update("label", value)} required autoComplete="off" />
      <CardField label="Cardholder name" value={card.cardholderName} onChange={(value) => update("cardholderName", value)} required autoComplete="cc-name" />
      <CardField label="Card number" value={card.cardNumber} onChange={(value) => update("cardNumber", value)} required autoComplete="cc-number" inputMode="numeric" pattern="[0-9 -]{8,32}" />
      <div className="card-form-expiry">
        <CardField label="Expiry month" value={card.expiryMonth} onChange={(value) => update("expiryMonth", value)} required autoComplete="cc-exp-month" inputMode="numeric" pattern="(0[1-9]|1[0-2])" placeholder="MM" />
        <CardField label="Expiry year" value={card.expiryYear} onChange={(value) => update("expiryYear", value)} required autoComplete="cc-exp-year" inputMode="numeric" pattern="[0-9]{4}" placeholder="YYYY" />
      </div>
      <label>
        <span className="field-label">Billing address</span>
        <textarea
          className="field-input card-form-textarea"
          autoComplete="billing street-address"
          maxLength={2048}
          value={card.billingAddress}
          onChange={(event) => update("billingAddress", event.target.value)}
        />
      </label>
      <label>
        <span className="field-label">Notes</span>
        <textarea
          className="field-input card-form-textarea"
          autoComplete="off"
          maxLength={4096}
          value={card.notes}
          onChange={(event) => update("notes", event.target.value)}
        />
      </label>
      <Button type="submit" loading={status === "saving"} disabled={status === "saving"}>
        Save card
      </Button>
      <p className="card-form-status" role="status">{statusMessage(status)}</p>
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
}

function CardField(props: CardFieldProps): React.JSX.Element {
  return (
    <label>
      <span className="field-label">{props.label}</span>
      <input
        className="field-input"
        type="text"
        maxLength={props.label === "Card number" ? 32 : 256}
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

function statusMessage(status: SaveStatus): string {
  if (status === "saved") return "Card saved securely";
  if (status === "blocked") return "Save needs grant refresh in the web panel";
  if (status === "error") return "Could not save this card";
  return "";
}
