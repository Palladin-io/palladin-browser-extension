// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureClient } from "../capture/client";
import { ENTRY_CREDENTIAL, ENTRY_KEY } from "../vault/entry-type";
import type { EntryMetadata } from "../../background/vault/entry-metadata";
import type { VaultListView } from "../../background/vault/commands";
import type { VaultClient } from "../vault/client";
import { VaultClientError } from "../vault/client";
import { UnlockedScreen } from "./UnlockedScreen";

function entry(over: Partial<EntryMetadata> & Pick<EntryMetadata, "id" | "name">): EntryMetadata {
  return {
    vaultId: "v1",
    vaultName: "Personal",
    type: ENTRY_CREDENTIAL,
    updatedAt: "2026-07-15T00:00:00Z",
    ...over,
  };
}

const CRED = entry({
  id: "cred",
  name: "Example login",
  urlDomain: "www.example.com",
  icon: "public-asset:11111111-1111-4111-8111-111111111111|1|https%3A%2F%2Fassets.palladin.io%2Fgithub.png",
});
const KEY = entry({ id: "key", name: "API token", type: ENTRY_KEY });

function view(over: Partial<VaultListView> = {}): VaultListView {
  return {
    site: { domain: "example.com", secure: true },
    forSite: [CRED],
    all: [CRED, KEY],
    ...over,
  };
}

function makeClient(over: Partial<VaultClient> = {}): VaultClient {
  return {
    list: vi.fn(async () => view()),
    sync: vi.fn(async () => view()),
    reveal: vi.fn(async () => "s3cr3t"),
    credentialUsername: vi.fn(async () => "ada@example.com"),
    totp: vi.fn(async () => null),
    fill: vi.fn(async () => ({ status: "filled" }) as const),
    login: vi.fn(async () => ({ status: "filled" }) as const),
    fillGenerated: vi.fn(async () => ({ status: "filled" }) as const),
    saveEntry: vi.fn(async () => ({ status: "saved" }) as const),
    armClipboardClear: vi.fn(async () => undefined),
    ...over,
  };
}

function makeCaptureClient(over: Partial<CaptureClient> = {}): CaptureClient {
  return {
    getPrompt: vi.fn(async () => null),
    dismiss: vi.fn(async () => undefined),
    fillGenerated: vi.fn(async () => ({ status: "filled", saveAvailable: true }) as const),
    save: vi.fn(async () => ({ status: "saved", action: "created" }) as const),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `userEvent.setup()` provides a working navigator.clipboard stub; the copy
  // test reads it back. We only need to stub chrome for the deep-link buttons.
  Object.assign(globalThis, { chrome: { tabs: { create: vi.fn() } } });
});

const noop = async (): Promise<void> => {};

describe("UnlockedScreen", () => {
  it("renders the for-this-site and all-items sections", async () => {
    const { container } = render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient()} />);

    expect(await screen.findByText("For this site")).toBeInTheDocument();
    expect(screen.getByText("All items")).toBeInTheDocument();
    // The credential appears in both sections; the key only under All items.
    expect(screen.getAllByText("Example login").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("API token")).toBeInTheDocument();
    expect(screen.getAllByText("Vault: Personal").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('img[src="https://assets.palladin.io/github.png"]')).toBeInTheDocument();
  });

  it("filters by query and hides the for-this-site section while searching", async () => {
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient()} />);
    const user = userEvent.setup();

    await screen.findByText("All items");
    await user.type(screen.getByLabelText("Search entries"), "token");

    expect(screen.queryByText("For this site")).not.toBeInTheDocument();
    expect(screen.getByText("Results")).toBeInTheDocument();
    expect(screen.getByText("API token")).toBeInTheDocument();
    expect(screen.queryByText("Example login")).not.toBeInTheDocument();
  });

  it("groups repeated website entries and reveals usernames only after expansion", async () => {
    const first = entry({ id: "work", name: "WP work", urlDomain: "1login.wp.pl", vaultName: "Work" });
    const second = entry({ id: "personal", vaultId: "v2", name: "WP personal", urlDomain: "1login.wp.pl", vaultName: "Personal" });
    const credentialUsername = vi.fn(async (_vaultId: string, entryId: string) => entryId === "work" ? "ada@work.pl" : "ada@wp.pl");
    const groupedView = view({ forSite: [], all: [first, second, KEY] });
    const client = makeClient({
      list: vi.fn(async () => groupedView),
      sync: vi.fn(async () => groupedView),
      credentialUsername,
    });
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={client} />);
    const user = userEvent.setup();

    const group = await screen.findByRole("button", { name: /1login\.wp\.pl.*logins: 2/i });
    expect(group).not.toHaveAccessibleName(/vaults/i);
    expect(screen.queryByText("ada@work.pl")).not.toBeInTheDocument();
    expect(credentialUsername).not.toHaveBeenCalled();

    await user.click(group);
    expect(await screen.findByText("ada@work.pl")).toBeInTheDocument();
    expect(await screen.findByText("ada@wp.pl")).toBeInTheDocument();
    expect(credentialUsername).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Vault: Work")).toBeInTheDocument();
  });

  it("loads the next grouped batch when the end sentinel reaches the scroll viewport", async () => {
    let intersection: IntersectionObserverCallback | null = null;
    const observe = vi.fn();
    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        intersection = callback;
      }
      observe = observe;
      disconnect = vi.fn();
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);
      root = null;
      rootMargin = "";
      thresholds = [];
    }
    vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
    const many = Array.from({ length: 205 }, (_, index) => entry({
      id: `entry-${index}`,
      name: `Entry ${String(index).padStart(3, "0")}`,
    }));
    const manyView = view({ forSite: [], all: many });
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient({
      list: vi.fn(async () => manyView),
      sync: vi.fn(async () => manyView),
    })} />);

    expect(await screen.findByText("Entry 099")).toBeInTheDocument();
    expect(screen.queryByText("Entry 100")).not.toBeInTheDocument();
    await waitFor(() => expect(observe).toHaveBeenCalled());
    act(() => intersection?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(await screen.findByText("Entry 199")).toBeInTheDocument();
    expect(screen.queryByText("Entry 200")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("reveals the username of a single credential only after its row is expanded", async () => {
    const credentialUsername = vi.fn(async () => "ada@example.com");
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient({ credentialUsername })} />);
    const user = userEvent.setup();

    expect(credentialUsername).not.toHaveBeenCalled();
    const rows = await screen.findAllByText("Example login");
    await user.click(rows[rows.length - 1]);

    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(credentialUsername).toHaveBeenCalledWith("v1", "cred");
  });

  it("shows an empty state when the search matches nothing", async () => {
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient()} />);
    const user = userEvent.setup();

    await screen.findByText("All items");
    await user.type(screen.getByLabelText("Search entries"), "zzzz");
    expect(screen.getByText("No entries match your search.")).toBeInTheDocument();
  });

  it("copies the password on demand (reveal + clipboard)", async () => {
    const client = makeClient();
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={client} />);
    const user = userEvent.setup();

    // Expand the credential row in the All items section (last match).
    const rows = await screen.findAllByText("Example login");
    await user.click(rows[rows.length - 1]);

    await user.click(screen.getByRole("button", { name: "Copy password" }));
    await waitFor(() => expect(client.reveal).toHaveBeenCalledWith("v1", "cred", "password"));
    // The Copied label proves writeText resolved; the clipboard holds the secret.
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe("s3cr3t");
  });

  it("runs the resilient login action and surfaces the outcome", async () => {
    const client = makeClient({ login: vi.fn(async () => ({ status: "no-form" }) as const) });
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={client} />);
    const user = userEvent.setup();

    const rows = await screen.findAllByText("Example login");
    await user.click(rows[rows.length - 1]);
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(client.login).toHaveBeenCalledWith("v1", "cred"));
    expect(await screen.findByText("No login form found")).toBeInTheDocument();
  });

  it("opens the credential website and starts the bound login fill", async () => {
    const client = makeClient();
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={client} />);
    const user = userEvent.setup();

    const rows = await screen.findAllByText("Example login");
    await user.click(rows[rows.length - 1]);
    await user.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(client.login).toHaveBeenCalledWith("v1", "cred"));
  });

  it("keeps the Lock and Sign out actions", async () => {
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient()} />);
    expect(await screen.findByRole("button", { name: "Lock" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("offers the browser side panel from the quick popup", async () => {
    const openPanel = vi.fn(async () => true);
    render(
      <UnlockedScreen
        onLock={noop}
        onSignOut={noop}
        onOpenSidePanel={openPanel}
        vaultClient={makeClient()}
      />,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Open side panel" }));
    expect(openPanel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Open Palladin" })).not.toBeInTheDocument();
  });

  it("generates, copies, and fills a password without saving it", async () => {
    const client = makeClient();
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={client} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: "Generator" }));
    const generated = screen.getByLabelText("Generated value").textContent ?? "";
    expect(generated.length).toBeGreaterThanOrEqual(8);

    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(client.armClipboardClear).toHaveBeenCalledOnce());
    expect(await navigator.clipboard.readText()).toBe(generated);

    await user.click(screen.getByRole("button", { name: "Fill" }));
    await waitFor(() => expect(client.fillGenerated).toHaveBeenCalledWith(generated));
    expect(screen.getByText("Filled in the active page")).toBeInTheDocument();
  });

  it("supports passphrases and does not persist generated values", async () => {
    const client = makeClient();
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={client} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: "Generator" }));
    const syncCallsBeforeGeneration = vi.mocked(client.sync).mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Passphrase" }));
    expect(screen.getByLabelText("Generated value").textContent?.split("-")).toHaveLength(6);
    expect(client.sync).toHaveBeenCalledTimes(syncCallsBeforeGeneration);
  });

  it("offers a strong password in extension UI and fills only the bound candidate", async () => {
    const captureClient = makeCaptureClient({
      getPrompt: vi.fn(async () => ({
        id: "prompt_0123456789abcdef",
        kind: "password-change",
        site: "example.com",
      } as const)),
    });
    render(
      <UnlockedScreen
        onLock={noop}
        onSignOut={noop}
        vaultClient={makeClient()}
        captureClient={captureClient}
      />,
    );
    const user = userEvent.setup();

    expect(await screen.findByText("Password change detected")).toBeInTheDocument();
    expect(screen.getByText(/then choose whether to save it/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use strong password" }));

    const generated = screen.getByLabelText("Generated value").textContent ?? "";
    await user.click(screen.getByRole("button", { name: "Fill" }));
    await waitFor(() => expect(captureClient.fillGenerated).toHaveBeenCalledWith(
      "prompt_0123456789abcdef",
      generated,
    ));
    expect(screen.getByText("Filled in the active page")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save to Palladin" }));
    await waitFor(() => expect(captureClient.save).toHaveBeenCalledWith(
      "prompt_0123456789abcdef",
      generated,
    ));
    expect(screen.getByText("Saved securely to Palladin")).toBeInTheDocument();
  });

  it("shows an empty state when the vault has no entries", async () => {
    const client = makeClient({
      list: vi.fn(async () => view({ forSite: [], all: [] })),
      sync: vi.fn(async () => view({ forSite: [], all: [] })),
    });
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={client} />);
    expect(await screen.findByText("No entries yet.")).toBeInTheDocument();
  });

  it("shows the list loader instead of an empty state while an empty cache is syncing", async () => {
    let resolveSync: ((value: ReturnType<typeof view>) => void) | undefined;
    const sync = vi.fn(() => new Promise<ReturnType<typeof view>>((resolve) => {
      resolveSync = resolve;
    }));
    render(<UnlockedScreen
      onLock={noop}
      onSignOut={noop}
      vaultClient={makeClient({
        list: vi.fn(async () => view({ forSite: [], all: [] })),
        sync,
      })}
    />);

    await waitFor(() => expect(sync).toHaveBeenCalledOnce());
    expect(document.querySelector(".list-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("No entries yet.")).not.toBeInTheDocument();

    resolveSync?.(view({ forSite: [], all: [] }));
    expect(await screen.findByText("No entries yet.")).toBeInTheDocument();
  });

  it("explains a decrypt failure and retries without closing the popup", async () => {
    const sync = vi.fn()
      .mockRejectedValueOnce(new VaultClientError("decrypt-failed", "member-index"))
      .mockResolvedValueOnce(view());
    render(<UnlockedScreen
      onLock={noop}
      onSignOut={noop}
      vaultClient={makeClient({
        list: vi.fn(async () => view({ forSite: [], all: [] })),
        sync,
      })}
    />);
    const user = userEvent.setup();

    expect(await screen.findByText("Couldn't open one of the encrypted entry indexes.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("All items")).toBeInTheDocument();
    expect(sync).toHaveBeenCalledTimes(2);
  });
});
