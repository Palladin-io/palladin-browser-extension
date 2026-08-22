// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AGENT_PAIRING_PROTOCOL } from "@shared/agent/pairing";

import {
  AgentPairingClientError,
  type AgentPairingClient,
} from "../agent/client";
import { PairingScreen } from "./PairingScreen";

const KEY = `${"a".repeat(42)}A`;
const FINGERPRINT = "12345678" + "b".repeat(29) + "uvwxyw";
const OFFER = {
  protocol: AGENT_PAIRING_PROTOCOL,
  hostSigningPublicKey: KEY,
  fingerprint: FINGERPRINT,
} as const;
const BUNDLE = JSON.stringify(OFFER);

function client(overrides: Partial<AgentPairingClient> = {}): AgentPairingClient {
  return {
    getStatus: vi.fn(async () => ({ paired: false as const })),
    discover: vi.fn(async () => OFFER),
    save: vi.fn(async () => ({ paired: true as const, fingerprint: FINGERPRINT })),
    clear: vi.fn(async () => ({ paired: false as const })),
    ...overrides,
  };
}

describe("Agent runtime pairing screen", () => {
  it("detects the local runtime and pairs with one explicit trust click", async () => {
    const pairing = client();
    render(<PairingScreen client={pairing} />);
    const user = userEvent.setup();

    expect(await screen.findByText("12345678…uvwxyw")).toBeInTheDocument();
    expect(pairing.discover).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain(FINGERPRINT);
    expect(document.body.textContent).not.toContain(KEY);

    await user.click(screen.getByRole("button", { name: "Trust and pair" }));

    await waitFor(() => expect(pairing.save).toHaveBeenCalledWith(BUNDLE));
    expect(await screen.findByText("Paired fingerprint")).toBeInTheDocument();
    expect(screen.getByText("12345678…uvwxyw")).toBeInTheDocument();
  });

  it("retries automatic discovery when the host was initially unavailable", async () => {
    const discover = vi.fn()
      .mockRejectedValueOnce(new Error("not installed"))
      .mockResolvedValueOnce(OFFER);
    const pairing = client({ discover });
    render(<PairingScreen client={pairing} />);
    const user = userEvent.setup();

    expect(await screen.findByRole("alert")).toHaveTextContent("wasn't detected");
    await user.click(screen.getByRole("button", { name: "Detect runtime again" }));

    expect(await screen.findByText("12345678…uvwxyw")).toBeInTheDocument();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("copies the install command from the pairing instructions", async () => {
    const pairing = client({ discover: vi.fn(async () => { throw new Error("not installed"); }) });
    render(<PairingScreen client={pairing} />);
    const user = userEvent.setup();

    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(await navigator.clipboard.readText()).toBe("palladin browser install");
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("surfaces a fingerprint mismatch without echoing public-key values", async () => {
    const pairing = client({
      save: vi.fn(async () => { throw new AgentPairingClientError("fingerprint-mismatch"); }),
    });
    render(<PairingScreen client={pairing} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Trust and pair" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Fingerprint mismatch");
    expect(screen.getByRole("alert").textContent).not.toContain(KEY);
    expect(screen.getByRole("alert").textContent).not.toContain(FINGERPRINT);
  });

  it("instructs retry before restart when Pair was not committed", async () => {
    const pairing = client({
      save: vi.fn(async () => {
        throw new AgentPairingClientError("mutation-not-committed");
      }),
    });
    render(<PairingScreen client={pairing} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Trust and pair" }));

    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Retry before restarting the extension");
  });

  it("loads a persisted pin and unpairs it explicitly", async () => {
    const pairing = client({
      getStatus: vi.fn(async () => ({ paired: true as const, fingerprint: FINGERPRINT })),
    });
    render(<PairingScreen client={pairing} />);
    const user = userEvent.setup();

    expect(await screen.findByText("12345678…uvwxyw")).toBeInTheDocument();
    expect(pairing.discover).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Unpair runtime" }));
    await waitFor(() => expect(pairing.clear).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "Trust and pair" })).toBeInTheDocument();
  });

  it("warns when unpairing was not durably committed", async () => {
    const pairing = client({
      getStatus: vi.fn(async () => ({ paired: true as const, fingerprint: FINGERPRINT })),
      clear: vi.fn(async () => {
        throw new AgentPairingClientError("mutation-not-committed");
      }),
    });
    render(<PairingScreen client={pairing} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Unpair runtime" }));

    expect(await screen.findByRole("alert"))
      .toHaveTextContent("Retry before restarting the extension");
    expect(screen.getByText("12345678…uvwxyw")).toBeInTheDocument();
  });
});
