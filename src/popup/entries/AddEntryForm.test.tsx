// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { VaultClient } from "../vault/client";
import { AddEntryForm } from "./AddEntryForm";

function client(saveEntry = vi.fn(async () => ({ status: "saved" }) as const)): VaultClient {
  return { saveEntry } as unknown as VaultClient;
}

describe("AddEntryForm", () => {
  it("offers every canonical entry type", async () => {
    render(<AddEntryForm client={client()} />);
    const options = screen.getByLabelText("Entry type").querySelectorAll("option");
    expect([...options].map((option) => option.textContent)).toEqual([
      "Login", "API key", "Script", "Payment card",
    ]);
  });

  it("creates a credential and clears its plaintext fields after success", async () => {
    const saveEntry = vi.fn(async () => ({ status: "saved" }) as const);
    render(<AddEntryForm client={client(saveEntry)} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Name"), "Example login");
    await user.type(screen.getByLabelText("Username"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.type(screen.getByLabelText("Website URL"), "https://example.com/login");
    await user.click(screen.getByRole("button", { name: "Save entry" }));

    await waitFor(() => expect(saveEntry).toHaveBeenCalledWith({
      entryType: "credential",
      label: "Example login",
      username: "ada@example.com",
      password: "correct horse battery staple",
      url: "https://example.com/login",
    }));
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.getByText("Entry saved securely")).toBeInTheDocument();
  });

  it("adds neutral encrypted custom fields to the canonical entry payload", async () => {
    const saveEntry = vi.fn(async () => ({ status: "saved" }) as const);
    render(<AddEntryForm client={client(saveEntry)} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Name"), "Example login");
    await user.type(screen.getByLabelText("Password"), "correct horse battery staple");
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.selectOptions(screen.getByLabelText("Type of additional field 1"), "concealed");
    await user.type(screen.getByLabelText("Name of additional field 1"), "Recovery phrase hint");
    await user.type(screen.getByLabelText("Value of additional field 1"), "private note");
    await user.click(screen.getByRole("button", { name: "Save entry" }));

    await waitFor(() => expect(saveEntry).toHaveBeenCalledWith(expect.objectContaining({
      entryType: "credential",
      customFields: [expect.objectContaining({
        id: expect.stringMatching(/^custom:/),
        label: "Recovery phrase hint",
        type: "concealed",
        value: "private note",
      })],
    })));
    expect(screen.queryByLabelText("Name of additional field 1")).not.toBeInTheDocument();
  });

  it("reorders custom fields without changing their canonical IDs or values", async () => {
    const saveEntry = vi.fn(async () => ({ status: "saved" }) as const);
    render(<AddEntryForm client={client(saveEntry)} />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("Name"), "Ordered fields");
    await user.type(screen.getByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.click(screen.getByRole("button", { name: "Add field" }));
    await user.type(screen.getByLabelText("Name of additional field 1"), "First");
    await user.type(screen.getByLabelText("Value of additional field 1"), "one");
    await user.type(screen.getByLabelText("Name of additional field 2"), "Second");
    await user.type(screen.getByLabelText("Value of additional field 2"), "two");

    await user.click(screen.getByRole("button", { name: "Move additional field 2 up" }));
    expect(screen.getByLabelText("Name of additional field 1")).toHaveValue("Second");
    expect(screen.getByLabelText("Name of additional field 2")).toHaveValue("First");
    await user.click(screen.getByRole("button", { name: "Save entry" }));

    await waitFor(() => expect(saveEntry).toHaveBeenCalledWith(expect.objectContaining({
      customFields: [
        expect.objectContaining({ label: "Second", value: "two" }),
        expect.objectContaining({ label: "First", value: "one" }),
      ],
    })));
  });

  it("creates key, script, and card payloads through the same canonical command", async () => {
    const saveEntry = vi.fn(async () => ({ status: "saved" }) as const);
    render(<AddEntryForm client={client(saveEntry)} />);
    const user = userEvent.setup();
    const type = screen.getByLabelText("Entry type");

    await user.selectOptions(type, "key");
    await user.type(screen.getByLabelText("Name"), "API token");
    await user.type(screen.getByLabelText("Secret value"), "secret-key");
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    await waitFor(() => expect(saveEntry).toHaveBeenLastCalledWith({ entryType: "key", label: "API token", value: "secret-key" }));

    await user.selectOptions(type, "script");
    await user.type(screen.getByLabelText("Name"), "Deploy");
    await user.type(screen.getByLabelText("Script source"), "echo ok");
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    await waitFor(() => expect(saveEntry).toHaveBeenLastCalledWith({ entryType: "script", label: "Deploy", source: "echo ok", interpreter: "bash" }));

    await user.selectOptions(type, "creditCard");
    await user.type(screen.getByLabelText("Name"), "Personal card");
    await user.type(screen.getByLabelText("Cardholder name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Card number"), "4111 1111 1111 1111");
    await user.type(screen.getByLabelText("Expiry month"), "08");
    await user.type(screen.getByLabelText("Expiry year"), "2030");
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    await waitFor(() => expect(saveEntry).toHaveBeenLastCalledWith(expect.objectContaining({ entryType: "creditCard", label: "Personal card" })));
    expect(screen.queryByLabelText(/security|verification|cvv|cvc|pin/i)).not.toBeInTheDocument();
  });

  it("surfaces a failed save without clearing the draft", async () => {
    render(<AddEntryForm client={client(vi.fn(async () => { throw new Error("offline"); }))} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Name"), "Example");
    await user.type(screen.getByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    expect(await screen.findByText("Couldn't save this entry")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("secret");
  });
});
