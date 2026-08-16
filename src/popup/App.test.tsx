// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentPairingClient } from "./agent/client";
import type { ServerConfigClient } from "./config/client";
import { PopupSessionError } from "./session/errors";
import type { SessionClient } from "./session/client";

type Fake = { [K in keyof SessionClient]: ReturnType<typeof vi.fn> } & SessionClient;

function makeClient(overrides: Partial<SessionClient> = {}): Fake {
  const base: SessionClient = {
    getStatus: vi.fn(async () => "signed-out" as const),
    getCapabilities: vi.fn(async () => ({ runtimeUnlock: false })),
    login: vi.fn(async () => ({ status: "unlocked" }) as const),
    completeTotp: vi.fn(async () => "unlocked" as const),
    cancelTotp: vi.fn(async () => {}),
    unlock: vi.fn(async () => "unlocked" as const),
    lock: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    ...overrides,
  };
  return base as Fake;
}

function makePairingClient(): AgentPairingClient {
  return {
    getStatus: vi.fn(async () => ({ paired: false as const })),
    save: vi.fn(async () => ({ paired: false as const })),
    clear: vi.fn(async () => ({ paired: false as const })),
  };
}

function makeServerConfigClient(): ServerConfigClient {
  return {
    get: vi.fn(async () => ({ apiUrl: "https://api.palladin.io", changed: false })),
    save: vi.fn(async (apiUrl) => ({ apiUrl, changed: true })),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("popup state machine", () => {
  it("lands on Sign in when signed-out", async () => {
    render(<App client={makeClient()} />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("opens server and Agent runtime settings from any session phase", async () => {
    render(
      <App
        client={makeClient()}
        pairingClient={makePairingClient()}
        serverConfigClient={makeServerConfigClient()}
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Server" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Pair Agent runtime" }))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("signs in and shows the unlocked screen", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Email"), "user@palladin.io");
    await user.type(screen.getByLabelText("Master password"), "correct horse");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: "Your vault" })).toBeInTheDocument();
    expect(client.login).toHaveBeenCalledWith("user@palladin.io", "correct horse");
  });

  it("trims the email but never the master password on submit", async () => {
    const client = makeClient();
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Email"), "  spaced@palladin.io  ");
    await user.type(screen.getByLabelText("Master password"), "  pad  ");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() =>
      expect(client.login).toHaveBeenCalledWith("spaced@palladin.io", "  pad  "),
    );
  });

  it("shows an inline error and stays on Sign in for a wrong password", async () => {
    const client = makeClient({
      login: vi.fn(async () => {
        throw new PopupSessionError("invalid-credentials");
      }),
    });
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Email"), "user@palladin.io");
    await user.type(screen.getByLabelText("Master password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/email or master password/i);
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("walks the TOTP second factor: challenge, then verify, and trims the code", async () => {
    const client = makeClient({
      login: vi.fn(async () => ({ status: "totp-required", challengeToken: "chal" }) as const),
    });
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Email"), "user@palladin.io");
    await user.type(screen.getByLabelText("Master password"), "pw with space ");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await user.type(await screen.findByLabelText("Authentication code"), " 123456 ");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByRole("heading", { name: "Your vault" })).toBeInTheDocument();
    // Code trimmed; the retained password passes through untrimmed.
    expect(client.completeTotp).toHaveBeenCalledWith("chal", "123456", "pw with space ");
  });

  it("drops a pending TOTP password when the server changes", async () => {
    const client = makeClient({
      login: vi.fn(async () => ({ status: "totp-required", challengeToken: "prod-chal" }) as const),
    });
    render(
      <App
        client={client}
        pairingClient={makePairingClient()}
        serverConfigClient={makeServerConfigClient()}
      />,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "user@palladin.io");
    await user.type(screen.getByLabelText("Master password"), "pending password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Enter your code" });

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.clear(await screen.findByLabelText("Server URL"));
    await user.type(screen.getByLabelText("Server URL"), "https://self-host.example.com");
    await user.click(screen.getByRole("button", { name: "Save server" }));
    await waitFor(() => expect(client.getStatus).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText("pending password")).not.toBeInTheDocument();
    expect(client.completeTotp).not.toHaveBeenCalled();
  });

  it("unlocks a locked session with the master password", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => "locked" as const) });
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Master password"), "let me in");
    await user.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByRole("heading", { name: "Your vault" })).toBeInTheDocument();
    expect(client.unlock).toHaveBeenCalledWith("let me in");
  });

  it("hides the biometric button while the runtime can't unlock", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => "locked" as const) });
    render(<App client={client} />);
    await screen.findByRole("button", { name: "Unlock" });
    expect(screen.queryByRole("button", { name: /touch id/i })).not.toBeInTheDocument();
  });

  it("shows the biometric button when the runtime reports it available", async () => {
    const client = makeClient({
      getStatus: vi.fn(async () => "locked" as const),
      getCapabilities: vi.fn(async () => ({ runtimeUnlock: true })),
    });
    render(<App client={client} />);
    expect(await screen.findByRole("button", { name: /touch id/i })).toBeInTheDocument();
  });

  it("locks from the unlocked screen and clears the password field", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => "locked" as const) });
    render(<App client={client} />);
    const user = userEvent.setup();

    // Unlock with a secret, reach the unlocked screen.
    await user.type(await screen.findByLabelText("Master password"), "topsecret");
    await user.click(screen.getByRole("button", { name: "Unlock" }));
    await screen.findByRole("heading", { name: "Your vault" });

    // Lock again — the fresh unlock form must not retain the old secret.
    await user.click(screen.getByRole("button", { name: "Lock" }));
    const field = await screen.findByLabelText("Master password");
    expect(field).toHaveValue("");
    expect(document.body.innerHTML).not.toContain("topsecret");
    expect(client.lock).toHaveBeenCalledOnce();
  });

  it("signs out from the unlocked screen back to Sign in", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => "unlocked" as const) });
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it("surfaces an unavailable worker with a retry", async () => {
    const client = makeClient({
      getStatus: vi
        .fn()
        .mockRejectedValueOnce(new PopupSessionError("network"))
        .mockResolvedValue("signed-out"),
    });
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});
