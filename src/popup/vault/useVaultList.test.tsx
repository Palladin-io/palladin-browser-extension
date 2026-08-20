// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { EntryMetadata } from "../../background/vault/entry-metadata";
import type { VaultListView } from "../../background/vault/commands";
import type { VaultClient } from "./client";
import { VaultClientError } from "./client";
import { useVaultList } from "./useVaultList";

const EMPTY_VIEW = {
  site: { domain: null, secure: false },
  forSite: [],
  all: [],
};

const ENTRY: EntryMetadata = {
  id: "11111111-1111-4111-8111-111111111111",
  vaultId: "22222222-2222-4222-8222-222222222222",
  vaultName: "Personal",
  name: "Example",
  type: 1,
  updatedAt: "2026-08-16T00:00:00Z",
  urlDomain: "example.com",
};

function Harness({
  client,
  viewRevision = 0,
}: {
  readonly client: VaultClient;
  readonly viewRevision?: number;
}): React.JSX.Element {
  const state = useVaultList(client, viewRevision);
  return <>
    <div data-testid="state">{state.status}:{state.errorCode ?? "none"}:{state.decryptStage ?? "none"}:{state.all.length}:{state.site?.domain ?? "none"}</div>
    <button type="button" onClick={state.retry}>retry</button>
  </>;
}

function client(overrides: Partial<VaultClient>): VaultClient {
  return {
    list: vi.fn(async () => EMPTY_VIEW),
    sync: vi.fn(async () => EMPTY_VIEW),
    reveal: vi.fn(),
    totp: vi.fn(),
    fill: vi.fn(),
    login: vi.fn(),
    fillGenerated: vi.fn(),
    saveEntry: vi.fn(),
    armClipboard: vi.fn(),
    ...overrides,
  } as VaultClient;
}

describe("useVaultList", () => {
  it("keeps loading after an empty cache read until authoritative sync completes", async () => {
    let resolveSync: ((value: typeof EMPTY_VIEW) => void) | undefined;
    const sync = vi.fn(() => new Promise<typeof EMPTY_VIEW>((resolve) => {
      resolveSync = resolve;
    }));
    render(<Harness client={client({ sync })} />);

    await waitFor(() => expect(sync).toHaveBeenCalledOnce());
    expect(screen.getByTestId("state")).toHaveTextContent("loading:none:none:0");

    resolveSync?.(EMPTY_VIEW);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:none:none:0"));
  });

  it("does not present an empty cache as an authoritative empty Vault after sync fails", async () => {
    render(<Harness client={client({ sync: vi.fn(async () => { throw new Error("offline"); }) })} />);

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("error:network:none:0"));
  });

  it("keeps useful cached entries when a refresh fails", async () => {
    render(<Harness client={client({
      list: vi.fn(async () => ({ ...EMPTY_VIEW, all: [ENTRY] })),
      sync: vi.fn(async () => { throw new Error("offline"); }),
    })} />);

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:none:none:1"));
  });

  it("shows a real empty state only after a successful authoritative sync", async () => {
    render(<Harness client={client({})} />);

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:none:none:0"));
  });

  it("preserves the value-free failure code and retries in the same popup", async () => {
    const sync = vi.fn()
      .mockRejectedValueOnce(new VaultClientError("decrypt-failed", "member-index"))
      .mockResolvedValueOnce({ ...EMPTY_VIEW, all: [ENTRY] });
    render(<Harness client={client({ sync })} />);

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("error:decrypt-failed:member-index:0"));
    await userEvent.click(screen.getByRole("button", { name: "retry" }));

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:none:none:1"));
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("updates only the active-site projection without loading or syncing again", async () => {
    let resolveProjection: ((value: VaultListView) => void) | undefined;
    const first: VaultListView = { ...EMPTY_VIEW, site: { domain: "first.example", secure: true }, all: [ENTRY] };
    const second: VaultListView = { ...EMPTY_VIEW, site: { domain: "second.example", secure: true }, all: [ENTRY] };
    const list = vi.fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => new Promise<VaultListView>((resolve) => {
        resolveProjection = resolve;
      }));
    const sync = vi.fn(async () => first);
    const vaultClient = client({ list, sync });
    const { rerender } = render(<Harness client={vaultClient} viewRevision={0} />);

    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:none:none:1:first.example"));
    rerender(<Harness client={vaultClient} viewRevision={1} />);

    expect(screen.getByTestId("state")).toHaveTextContent("ready:none:none:1:first.example");
    expect(sync).toHaveBeenCalledOnce();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    resolveProjection?.(second);
    await waitFor(() => expect(screen.getByTestId("state")).toHaveTextContent("ready:none:none:1:second.example"));
    expect(sync).toHaveBeenCalledOnce();
  });
});
