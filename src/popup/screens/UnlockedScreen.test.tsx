// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ENTRY_CREDENTIAL, ENTRY_KEY } from "../vault/entry-type";
import type { EntryMetadata } from "../../background/vault/entry-metadata";
import type { VaultListView } from "../../background/vault/commands";
import type { VaultClient } from "../vault/client";
import { UnlockedScreen } from "./UnlockedScreen";

function entry(over: Partial<EntryMetadata> & Pick<EntryMetadata, "id" | "name">): EntryMetadata {
  return {
    vaultId: "v1",
    type: ENTRY_CREDENTIAL,
    updatedAt: "2026-07-15T00:00:00Z",
    ...over,
  };
}

const CRED = entry({ id: "cred", name: "Example login", urlDomain: "www.example.com" });
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
    totp: vi.fn(async () => null),
    fill: vi.fn(async () => ({ status: "filled" }) as const),
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
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient()} />);

    expect(await screen.findByText("For this site")).toBeInTheDocument();
    expect(screen.getByText("All items")).toBeInTheDocument();
    // The credential appears in both sections; the key only under All items.
    expect(screen.getAllByText("Example login").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("API token")).toBeInTheDocument();
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

  it("runs a fill and surfaces the outcome", async () => {
    const client = makeClient({ fill: vi.fn(async () => ({ status: "no-form" }) as const) });
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={client} />);
    const user = userEvent.setup();

    const rows = await screen.findAllByText("Example login");
    await user.click(rows[rows.length - 1]);
    await user.click(screen.getByRole("button", { name: "Fill" }));

    await waitFor(() => expect(client.fill).toHaveBeenCalledWith("v1", "cred"));
    expect(await screen.findByText("No login form found")).toBeInTheDocument();
  });

  it("keeps the Lock and Sign out actions", async () => {
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient()} />);
    expect(await screen.findByRole("button", { name: "Lock" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("shows an empty state when the vault has no entries", async () => {
    const client = makeClient({
      list: vi.fn(async () => view({ forSite: [], all: [] })),
      sync: vi.fn(async () => view({ forSite: [], all: [] })),
    });
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={client} />);
    expect(await screen.findByText("No entries yet.")).toBeInTheDocument();
  });
});
