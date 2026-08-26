// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentPairingClient } from "./agent/client";
import type { ServerConfigClient } from "./config/client";
import type { PasswordManagerOnboardingClient } from "./onboarding/client";
import { PopupSessionError } from "./session/errors";
import type { SessionClient } from "./session/client";
import { sessionChanged } from "@shared/messaging";
import { AGENT_PAIRING_PROTOCOL } from "@shared/agent/pairing";

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
    discover: vi.fn(async () => ({
      protocol: AGENT_PAIRING_PROTOCOL,
      hostSigningPublicKey: `${"a".repeat(42)}A`,
      fingerprint: `${"b".repeat(42)}Q`,
    })),
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

function makeOnboardingClient(
  status: "pending" | "completed" = "completed",
): PasswordManagerOnboardingClient {
  return {
    getStatus: vi.fn(async () => status),
    complete: vi.fn(async () => undefined),
    openPasswordSettings: vi.fn(async () => undefined),
    openExtensionManager: vi.fn(async () => undefined),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("popup state machine", () => {
  it("lands on Sign in when signed-out", async () => {
    render(<App client={makeClient()} />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("keeps account creation on the sign-in surface", async () => {
    const onCreateAccount = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<App client={makeClient()} onCreateAccount={onCreateAccount} />);

    expect(await screen.findByText("New to Palladin?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(onCreateAccount).toHaveBeenCalledOnce();
  });

  it("opens compact settings sections and expands one section at a time", async () => {
    render(
      <App
        client={makeClient()}
        pairingClient={makePairingClient()}
        serverConfigClient={makeServerConfigClient()}
        onboardingClient={makeOnboardingClient()}
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const appearance = screen.getByRole("button", { name: "Appearance" });
    const server = screen.getByRole("button", { name: "Server URL" });
    const pairing = screen.getByRole("button", { name: "Pair Agent" });
    expect(appearance).toHaveAttribute("aria-expanded", "false");
    expect(server).toHaveAttribute("aria-expanded", "false");
    expect(pairing).toHaveAttribute("aria-expanded", "false");

    await user.click(appearance);
    expect(await screen.findByLabelText("Language")).toBeInTheDocument();
    expect(appearance).toHaveAttribute("aria-expanded", "true");

    await user.click(server);
    expect(await screen.findByLabelText("Server URL")).toBeInTheDocument();
    expect(appearance).toHaveAttribute("aria-expanded", "false");
    expect(server).toHaveAttribute("aria-expanded", "true");

    await user.click(pairing);
    expect(await screen.findByRole("button", { name: "Trust and pair" })).toBeInTheDocument();
    expect(server).toHaveAttribute("aria-expanded", "false");
    expect(pairing).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows password-manager guidance once before the session UI", async () => {
    const onboarding = makeOnboardingClient("pending");
    render(<App client={makeClient()} onboardingClient={onboarding} />);
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "One password manager works best" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue to Palladin" }));

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(onboarding.complete).toHaveBeenCalledOnce();
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
    // Code is trimmed; the popup does not retain or resend the master password.
    expect(client.completeTotp).toHaveBeenCalledWith("chal", "123456");
  });

  it("shows a rate-limit error and keeps the TOTP challenge retryable", async () => {
    const completeTotp = vi.fn()
      .mockRejectedValueOnce(new PopupSessionError("rate-limited"))
      .mockResolvedValueOnce("unlocked" as const);
    const client = makeClient({
      login: vi.fn(async () => ({ status: "totp-required", challengeToken: "chal" }) as const),
      completeTotp,
    });
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Email"), "user@palladin.io");
    await user.type(screen.getByLabelText("Master password"), "password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(await screen.findByLabelText("Authentication code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many attempts");
    await user.clear(screen.getByLabelText("Authentication code"));
    await user.type(screen.getByLabelText("Authentication code"), "654321");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByRole("heading", { name: "Your vault" })).toBeInTheDocument();
    expect(completeTotp).toHaveBeenNthCalledWith(1, "chal", "123456");
    expect(completeTotp).toHaveBeenNthCalledWith(2, "chal", "654321");
  });

  it("drops a pending TOTP challenge when the server changes", async () => {
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
    await user.click(screen.getByRole("button", { name: "Server URL" }));
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

  it("signs out directly from a locked session without unlocking", async () => {
    const client = makeClient({ getStatus: vi.fn(async () => "locked" as const) });
    render(<App client={client} />);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("Master password"), "do not retain");
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(client.logout).toHaveBeenCalledOnce();
    expect(document.body.innerHTML).not.toContain("do not retain");
    expect(client.unlock).not.toHaveBeenCalled();
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

  it("keeps a persistent side panel in sync with value-free worker lifecycle events", async () => {
    let messageListener: ((raw: unknown) => void) | undefined;
    const removeListener = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: (raw: unknown) => void) => {
            messageListener = listener;
          }),
          removeListener,
        },
      },
      tabs: {
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    try {
      const { unmount } = render(
        <App
          surface="side-panel"
          client={makeClient({ getStatus: vi.fn(async () => "unlocked" as const) })}
        />,
      );
      expect(await screen.findByRole("heading", { name: "Your vault" })).toBeInTheDocument();

      act(() => messageListener?.(sessionChanged("locked")));
      expect(await screen.findByRole("heading", { name: "Unlock" })).toBeInTheDocument();
      unmount();
      expect(removeListener).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshes the side-panel projection only for the active tab", async () => {
    let tabUpdated: ((
      tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab,
    ) => void) | undefined;
    const sendMessage = vi.fn(async (raw: unknown) => {
      if (raw !== null && typeof raw === "object" && "type" in raw) {
        const type = (raw as { readonly type?: unknown }).type;
        if (type === "vault/list" || type === "vault/sync") {
          return {
            ok: true as const,
            list: { site: null, forSite: [], all: [] },
          };
        }
      }
      return undefined;
    });
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage,
        onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      tabs: {
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
        onUpdated: {
          addListener: vi.fn((listener: typeof tabUpdated) => { tabUpdated = listener; }),
          removeListener: vi.fn(),
        },
      },
    });

    try {
      render(
        <App
          surface="side-panel"
          client={makeClient({ getStatus: vi.fn(async () => "unlocked" as const) })}
          onboardingClient={makeOnboardingClient()}
        />,
      );
      expect(await screen.findByText("No entries yet.")).toBeInTheDocument();
      const vaultCalls = (): unknown[] => sendMessage.mock.calls
        .map(([message]) => message)
        .filter((message) => message !== null
          && typeof message === "object"
          && "type" in message
          && ((message as { readonly type?: unknown }).type === "vault/list"
            || (message as { readonly type?: unknown }).type === "vault/sync"));
      expect(vaultCalls()).toHaveLength(2);

      const tab = (id: number, active: boolean): chrome.tabs.Tab => ({
        id,
        active,
        index: 0,
        pinned: false,
        highlighted: active,
        windowId: 1,
        incognito: false,
        selected: active,
        discarded: false,
        autoDiscardable: true,
        groupId: -1,
      });
      act(() => tabUpdated?.(2, { status: "complete" }, tab(2, false)));
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect(vaultCalls()).toHaveLength(2);

      act(() => tabUpdated?.(1, { status: "complete" }, tab(1, true)));
      await waitFor(() => expect(vaultCalls()).toHaveLength(3));
      expect(vaultCalls()[2]).toEqual({ type: "vault/list" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
