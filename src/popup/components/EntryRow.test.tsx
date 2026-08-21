// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EntryMetadata } from "../../background/vault/entry-metadata";
import type { VaultClient } from "../vault/client";
import { EntryRow } from "./EntryRow";

const entry: EntryMetadata = {
  id: "entry-1",
  vaultId: "vault-1",
  vaultName: "Personal",
  name: "Example login",
  type: 1,
  urlDomain: "example.com",
  updatedAt: "2026-08-16T00:00:00Z",
};

beforeEach(() => {
  Object.assign(globalThis, {
    chrome: {
      tabs: { create: vi.fn() },
    },
  });
});

describe("EntryRow credential actions", () => {
  it("uses one resilient login action and exposes the extensible Palladin management action", async () => {
    const login = vi.fn(async () => ({ status: "filled" }) as const);
    const client = {
      login,
      credentialUsername: vi.fn(async () => "ada@example.com"),
      totp: vi.fn(async () => null),
    } as unknown as VaultClient;
    const user = userEvent.setup();
    render(<EntryRow client={client} entry={entry} />);

    await user.click(screen.getByRole("button", { name: /Example login/i }));
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fill" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in Palladin" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Log in" }));
    expect(login).toHaveBeenCalledWith("vault-1", "entry-1");
    await user.click(screen.getByRole("button", { name: "Open in Palladin" }));
    expect(chrome.tabs.create).toHaveBeenCalledWith({
      url: "http://localhost:5173/vaults/vault-1/entries/entry-1",
    });
  });
});
