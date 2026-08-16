// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AGENT_PAIRING_PROTOCOL } from "@shared/agent/pairing";

import {
  AgentPairingClientError,
  type AgentPairingClient,
} from "../agent/client";
import { PairingScreen } from "./PairingScreen";

const KEY = "a".repeat(43);
const FINGERPRINT = "12345678" + "b".repeat(29) + "uvwxyz";
const BUNDLE = JSON.stringify({
  protocol: AGENT_PAIRING_PROTOCOL,
  hostSigningPublicKey: KEY,
  fingerprint: FINGERPRINT,
});

function client(overrides: Partial<AgentPairingClient> = {}): AgentPairingClient {
  return {
    getStatus: vi.fn(async () => ({ paired: false as const })),
    save: vi.fn(async () => ({ paired: true as const, fingerprint: FINGERPRINT })),
    clear: vi.fn(async () => ({ paired: false as const })),
    ...overrides,
  };
}

describe("Agent runtime pairing screen", () => {
  it("requires a valid out-of-band bundle and explicit fingerprint confirmation", async () => {
    const pairing = client();
    render(<PairingScreen client={pairing} />);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Pairing bundle");
    await user.type(input, "not-json");
    expect(screen.getByRole("alert")).toHaveTextContent("malformed");
    expect(screen.getByRole("button", { name: "Pair runtime" })).toBeDisabled();

    await user.clear(input);
    fireEvent.change(input, { target: { value: BUNDLE } });
    expect(screen.getByText("12345678…uvwxyz")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pair runtime" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /verified this fingerprint/i }));
    await user.click(screen.getByRole("button", { name: "Pair runtime" }));

    await waitFor(() => expect(pairing.save).toHaveBeenCalledWith(BUNDLE));
    expect(await screen.findByText("Paired fingerprint")).toBeInTheDocument();
    expect(screen.getByText("12345678…uvwxyz")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(FINGERPRINT);
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("surfaces a fingerprint mismatch without echoing bundle values", async () => {
    const pairing = client({
      save: vi.fn(async () => { throw new AgentPairingClientError("fingerprint-mismatch"); }),
    });
    render(<PairingScreen client={pairing} />);
    const user = userEvent.setup();

    fireEvent.change(await screen.findByLabelText("Pairing bundle"), {
      target: { value: BUNDLE },
    });
    await user.click(screen.getByRole("checkbox", { name: /verified this fingerprint/i }));
    await user.click(screen.getByRole("button", { name: "Pair runtime" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Fingerprint mismatch");
    expect(screen.getByRole("alert").textContent).not.toContain(KEY);
    expect(screen.getByRole("alert").textContent).not.toContain(FINGERPRINT);
  });

  it("loads a persisted pin and unpairs it explicitly", async () => {
    const pairing = client({
      getStatus: vi.fn(async () => ({ paired: true as const, fingerprint: FINGERPRINT })),
    });
    render(<PairingScreen client={pairing} />);
    const user = userEvent.setup();

    expect(await screen.findByText("12345678…uvwxyz")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unpair runtime" }));
    await waitFor(() => expect(pairing.clear).toHaveBeenCalledOnce());
    expect(await screen.findByLabelText("Pairing bundle")).toBeInTheDocument();
  });
});
