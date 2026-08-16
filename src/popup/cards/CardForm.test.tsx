// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { VaultClient } from "../vault/client";
import { CardForm } from "./CardForm";

describe("CardForm", () => {
  it("saves only the reviewed card fields and clears the sensitive form", async () => {
    const saveCreditCard = vi.fn(async () => ({ status: "saved" }) as const);
    const client = { saveCreditCard } as unknown as VaultClient;
    render(<CardForm client={client} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Card label"), "Personal card");
    await user.type(screen.getByLabelText("Cardholder name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Card number"), "4111 1111 1111 1111");
    await user.type(screen.getByLabelText("Expiry month"), "08");
    await user.type(screen.getByLabelText("Expiry year"), "2030");
    await user.type(screen.getByLabelText("Billing address"), "12 Computing Lane");
    await user.type(screen.getByLabelText("Notes"), "Primary");
    await user.click(screen.getByRole("button", { name: "Save card" }));

    await waitFor(() => expect(saveCreditCard).toHaveBeenCalledWith({
      label: "Personal card",
      cardholderName: "Ada Lovelace",
      cardNumber: "4111 1111 1111 1111",
      expiryMonth: "08",
      expiryYear: "2030",
      billingAddress: "12 Computing Lane",
      notes: "Primary",
    }));
    expect(screen.getByText("Card saved securely")).toBeInTheDocument();
    expect(screen.getByLabelText("Card number")).toHaveValue("");
    expect(screen.queryByLabelText(/security|verification|pin/i)).not.toBeInTheDocument();
  });
});
