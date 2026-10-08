import { webAppUrl } from '@shared/config/web-app';
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
  Object.assign(globalThis, { chrome: { tabs: { create: vi.fn() }, runtime: { sendMessage: vi.fn(async (command: { type: string }) => command.type === 'config/connections/get' ? { ok: true, state: { connections: [], activeApiUrl: 'https://api.example.test' } } : command.type === 'workspace/detail'
    ? { ok: true, data: { revision: '1', fields: [{ id: 'credential.username', label: '', type: 'text', value: 'ada@example.com' }, { id: 'credential.password', label: '', type: 'concealed', value: null }] } }
    : command.type === 'workspace/field' ? { ok: true, data: { value: 's3cr3t' } } : { ok: true }) } } });
});

const noop = async (): Promise<void> => {};

describe("UnlockedScreen", () => {
  it('keeps the acknowledged success until Done despite vault and pending invalidations', async () => {
    const pending = { id: '11111111-1111-4111-8111-111111111111', title: 'Shared login',
      entryType: 'credential', vaults: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Personal' }] };
    let current: typeof pending | null = pending;
    let finishConfirm: ((value: { ok: boolean; status: string }) => void) | undefined;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (raw: unknown) => {
      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'share-save/get') {
        return { ok: true, pending: current };
      }
      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'share-save/confirm') {
        current = null;
        return new Promise(resolve => { finishConfirm = resolve; });
      }
      return { ok: true };
    });
    const props = { onLock: noop, onSignOut: noop, vaultClient: makeClient(), captureClient: makeCaptureClient() };
    const page = render(<UnlockedScreen {...props} viewRevision={0} shareRevision={0} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Save to my vault' }));
    page.rerender(<UnlockedScreen {...props} viewRevision={1} shareRevision={1} />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Save shared entry' })).toBeInTheDocument());
    await act(async () => { finishConfirm?.({ ok: true, status: 'saved' }); });
    expect(await screen.findByRole('heading', { name: 'Saved to your vault' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Saved to your vault' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('heading', { name: 'Saved to your vault' })).not.toBeInTheDocument();
  });

  it('removes an unconfirmed prompt after another surface cancels it', async () => {
    const pending = { id: '11111111-1111-4111-8111-111111111111', title: 'Shared login',
      entryType: 'credential', vaults: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Personal' }] };
    let current: typeof pending | null = pending;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (raw: unknown) => raw && typeof raw === 'object'
      && 'type' in raw && raw.type === 'share-save/get' ? { ok: true, pending: current } : { ok: true });
    const props = { onLock: noop, onSignOut: noop, vaultClient: makeClient(), captureClient: makeCaptureClient() };
    const page = render(<UnlockedScreen {...props} shareRevision={0} />);
    expect(await screen.findByRole('heading', { name: 'Save shared entry' })).toBeInTheDocument();
    current = null;
    page.rerender(<UnlockedScreen {...props} shareRevision={1} />);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Save shared entry' })).not.toBeInTheDocument());
  });
  it('keeps a failed confirmation visible until the user dismisses it', async () => {
    const pending = { id: '11111111-1111-4111-8111-111111111111', title: 'Shared login',
      entryType: 'credential', vaults: [{ id: '22222222-2222-4222-8222-222222222222', name: 'Personal' }] };
    let current: typeof pending | null = pending;
    let finishConfirm: ((value: { ok: boolean; status: string }) => void) | undefined;
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async (raw: unknown) => {
      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'share-save/get') return { ok: true, pending: current };
      if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'share-save/confirm') {
        current = null;
        return new Promise(resolve => { finishConfirm = resolve; });
      }
      return { ok: true };
    });
    const props = { onLock: noop, onSignOut: noop, vaultClient: makeClient(), captureClient: makeCaptureClient() };
    const page = render(<UnlockedScreen {...props} shareRevision={0} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Save to my vault' }));
    page.rerender(<UnlockedScreen {...props} shareRevision={1} />);
    await act(async () => { finishConfirm?.({ ok: true, status: 'failed' }); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save this entry');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("offers management tabs and opens the generator from the toolbar without storing generated values", async () => {
    const client = makeClient();
    const user = userEvent.setup();
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={client} captureClient={makeCaptureClient()} />);
    await screen.findByText("API token");
    expect(screen.getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Vault", "Inbox", "Sharing", "Logs"]);
    await user.click(screen.getByRole("button", { name: "Generator" }));
    vi.mocked(chrome.runtime.sendMessage).mockClear();
    await user.click(screen.getAllByRole("button", { name: "Copy" }).at(-1)!);
    expect(await navigator.clipboard.readText()).not.toBe("");
    expect(client.armClipboardClear).toHaveBeenCalledOnce();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("renders matching entries first in one list without duplicate sections", async () => {
    const { container } = render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient()} />);

    await screen.findByText("API token");
    expect(screen.queryByText("For this site")).not.toBeInTheDocument();
    expect(screen.queryByText("All items")).not.toBeInTheDocument();
    // The current-site credential appears only once.
    expect(screen.getAllByText("Example login")).toHaveLength(1);
    expect(screen.getByText("API token")).toBeInTheDocument();
    expect(screen.getAllByText("Vault: Personal").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('img[src="https://assets.palladin.io/github.png"]')).not.toBeInTheDocument();
  });

  it("puts a current-site match before alphabetically earlier domains", async () => {
    const base = makeClient();
    const initial = await base.list();
    const earlier = { ...initial.all[0]!, id: 'earlier-entry', name: 'Earlier site', urlDomain: 'aaa.example' };
    const matching = { ...initial.forSite[0]!, name: 'Current site', urlDomain: 'zzz.example' };
    const data = { ...initial, all: [earlier, matching], forSite: [matching] };
    const { container } = render(<UnlockedScreen onLock={noop} onSignOut={noop}
      vaultClient={makeClient({ list: vi.fn(async () => data), sync: vi.fn(async () => data) })} />);
    await screen.findByText('Current site');
    expect([...container.querySelectorAll('.entry-list .entry-name')].map(row => row.textContent)).toEqual(['Current site', 'Earlier site']);
  });

  it('filters multiple vaults and restores all vaults', async () => {
    const personal = entry({ id: 'personal', name: 'Personal entry' });
    const work = entry({ id: 'work', name: 'Work entry', vaultId: 'v2', vaultName: 'Work' });
    const other = entry({ id: 'other', name: 'Other entry', vaultId: 'v3', vaultName: 'Other' });
    const data = view({ all: [personal, work, other], forSite: [] });
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient({ list: vi.fn(async () => data), sync: vi.fn(async () => data) })} />);
    const user = userEvent.setup();
    await screen.findByText('Personal entry');
    await user.click(screen.getByLabelText('Filter vaults'));
    await user.click(screen.getByRole('checkbox', { name: 'Work' }));
    expect(screen.queryByText('Work entry')).not.toBeInTheDocument();
    expect(screen.getByText('Personal entry')).toBeInTheDocument();
    expect(screen.getByText('Other entry')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Personal' }));
    expect(screen.queryByText('Personal entry')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'All vaults' }));
    expect(screen.getByText('Personal entry')).toBeInTheDocument();
    expect(screen.getByText('Work entry')).toBeInTheDocument();
  });

  it("filters by query and hides the for-this-site section while searching", async () => {
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient()} />);
    const user = userEvent.setup();

    await screen.findByText("API token");
    await user.type(screen.getByLabelText("Search entries"), "token");

    expect(screen.queryByText("For this site")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Filter vaults")).toBeInTheDocument();
    expect(screen.getByText("API token")).toBeInTheDocument();
    expect(screen.queryByText("Example login")).not.toBeInTheDocument();
  });

  it("preserves the selected view and search while the active-tab projection changes", async () => {
    const client = makeClient();
    const { rerender } = render(
      <UnlockedScreen
        viewRevision={0}
        onLock={noop}
        onSignOut={noop}
        vaultClient={client}
      />,
    );
    const user = userEvent.setup();

    await screen.findByText("API token");
    await user.type(screen.getByLabelText("Search entries"), "token");
    rerender(
      <UnlockedScreen
        viewRevision={1}
        onLock={noop}
        onSignOut={noop}
        vaultClient={client}
      />,
    );

    expect(screen.getByLabelText("Search entries")).toHaveValue("token");
    expect(screen.getByLabelText("Filter vaults")).toBeInTheDocument();
    expect(screen.getByText("API token")).toBeInTheDocument();
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
    expect(client.sync).toHaveBeenCalledOnce();
  });

  it("shows repeated website entries individually without eagerly decrypting usernames", async () => {
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
    expect(await screen.findByRole("button", { name: /WP work/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /WP personal/ })).toBeInTheDocument();
    expect(screen.queryByText("ada@work.pl")).not.toBeInTheDocument();
    expect(credentialUsername).not.toHaveBeenCalled();
    expect(screen.getByText("Vault: Work")).toBeInTheDocument();
  });

  it("loads the next Entry batch when the end sentinel reaches the scroll viewport", async () => {
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
  }, 15_000);

  it("loads credential details only after selecting its row", async () => {
    const credentialUsername = vi.fn(async () => "ada@example.com");
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient({ credentialUsername })} />);
    const user = userEvent.setup();

    expect(credentialUsername).not.toHaveBeenCalled();
    const rows = await screen.findAllByText("Example login");
    await user.click(rows[rows.length - 1]);

    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "workspace/detail", vaultId: "v1", entryId: "cred" });
  });

  it("shows an empty state when the search matches nothing", async () => {
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient()} />);
    const user = userEvent.setup();

    await screen.findByText("API token");
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
    await waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "workspace/field", vaultId: "v1", entryId: "cred", fieldId: "credential.password" }));
    // The Copied label proves writeText resolved; the clipboard holds the secret.
    expect(await screen.findByText("Copied")).toBeInTheDocument();
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

  it("opens the web panel from the footer", async () => {
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open web panel' }));
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: webAppUrl });
    expect(screen.queryByRole('button', { name: 'Open side panel' })).not.toBeInTheDocument();
  });

  it("generates, copies, and fills a password without saving it", async () => {
    const client = makeClient();
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={client} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Generator" }));
    const choices = screen.getAllByRole("button", { pressed: false });
    expect(choices).toHaveLength(7);
    const chosen = choices[2]!;
    await user.click(chosen);
    expect(chosen).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText("Generated value").textContent === chosen.textContent).toBe(true);
    await user.click(chosen.parentElement!.querySelector<HTMLButtonElement>('.toolbar-icon')!);
    expect(await navigator.clipboard.readText() === chosen.textContent).toBe(true);
    vi.mocked(client.armClipboardClear).mockClear();
    const generated = screen.getByLabelText("Generated value").textContent ?? "";
    expect(generated.length).toBeGreaterThanOrEqual(8);

    await user.click(screen.getAllByRole("button", { name: "Copy" }).at(-1)!);
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

    await user.click(screen.getByRole("button", { name: "Generator" }));
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

  it.each(['select', 'regenerate'] as const)('does not save a stale fill after %s changes the generated password', async change => {
    let complete!: (result: Awaited<ReturnType<CaptureClient['fillGenerated']>>) => void;
    const captureClient = makeCaptureClient({
      getPrompt: vi.fn(async () => ({ id: 'prompt_0123456789abcdef', kind: 'registration', site: 'example.com' } as const)),
      fillGenerated: vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
        .mockResolvedValue({ status: 'filled', saveAvailable: true }),
    });
    render(<UnlockedScreen onLock={noop} onSignOut={noop} vaultClient={makeClient()} captureClient={captureClient} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Use strong password' }));
    await user.click(screen.getByRole('button', { name: 'Fill' }));
    expect(screen.getByRole('button', { name: 'Fill' })).toBeDisabled();
    if (change === 'select') await user.click(screen.getAllByRole('button', { pressed: false })[0]!);
    else await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await act(async () => { complete({ status: 'filled', saveAvailable: true }); });
    expect(screen.queryByRole('button', { name: 'Save to Palladin' })).not.toBeInTheDocument();
    expect(captureClient.save).not.toHaveBeenCalled();
    const current = screen.getByLabelText('Generated value').textContent;
    await user.click(screen.getByRole('button', { name: 'Fill' }));
    await user.click(await screen.findByRole('button', { name: 'Save to Palladin' }));
    expect(captureClient.save).toHaveBeenCalledWith('prompt_0123456789abcdef', current);
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

    expect(await screen.findByText("API token")).toBeInTheDocument();
    expect(sync).toHaveBeenCalledTimes(2);
  });
});
