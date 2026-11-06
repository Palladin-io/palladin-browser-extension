import { isManualEntrySaveInput } from '../../background/vault/commands';
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { VaultClient } from "../vault/client";
import { AddEntryForm } from "./AddEntryForm";

function client(saveEntry: VaultClient['saveEntry'] = vi.fn(async () => ({ status: "saved" }) as const)): VaultClient {
  return { saveEntry } as unknown as VaultClient;
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});

describe("AddEntryForm", () => {
  it('saves a selected glyph and resets the choice with the form', async () => {
    const saveEntry = vi.fn(async () => ({ status: 'saved' }) as const);
    render(<AddEntryForm client={client(saveEntry)} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Choose icon' }));
    await user.click(screen.getByRole('button', { name: 'Cloud' }));
    await user.click(screen.getByRole('button', { name: 'Icon color #60A5FA' }));
    await user.click(screen.getAllByRole('button', { name: 'Close icon picker' })[0]!);
    await user.type(screen.getByLabelText('Name'), 'Example');
    await user.type(screen.getByLabelText('Password'), 'synthetic');
    await user.click(screen.getByRole('button', { name: 'Save entry' }));
    await waitFor(() => expect(saveEntry).toHaveBeenCalledWith(expect.objectContaining({ icon: 'cloud', color: '#60A5FA' })));
    await user.click(screen.getByRole('button', { name: 'Choose icon' }));
    expect(screen.getByRole('button', { name: 'Cloud' })).toHaveAttribute('aria-pressed', 'false');
  });
  it('saves multiple same-provider methods in an OAuth-only Login and excludes them after a type switch', async () => {
    const saveEntry = vi.fn(async (_input: import('../../background/vault/protocol2/service').ManualEntrySaveInput) => ({ status: 'saved' }) as const);
    const { unmount } = render(<AddEntryForm client={client(saveEntry)} />);
    const user = userEvent.setup();
    for (const account of ['first@test', 'second@test']) {
      await user.click(screen.getByRole('button', { name: 'Add a sign-in method' }));
      await user.type(screen.getByLabelText('Account (optional)'), account);
      await user.click(screen.getByRole('button', { name: /^Save$/ }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }
    await user.type(screen.getByLabelText('Name'), 'OAuth only');
    await user.click(screen.getByRole('button', { name: 'Save entry' }));
    await waitFor(() => expect(saveEntry).toHaveBeenCalledWith(expect.objectContaining({ entryType: 'credential', username: '', password: '', signInMethods: [expect.objectContaining({ account: 'first@test' }), expect.objectContaining({ account: 'second@test' })] })));
    unmount();
    saveEntry.mockClear();
    render(<AddEntryForm client={client(saveEntry)} />);
    await user.click(screen.getByRole('button', { name: 'Add a sign-in method' }));
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await user.click(screen.getByRole('combobox', { name: 'Entry type' }));
    await user.click(screen.getByRole('option', { name: 'API key' }));
    await user.type(screen.getByLabelText('Name'), 'API');
    await user.type(screen.getByLabelText('Secret value'), 'synthetic');
    await user.click(screen.getByRole('button', { name: 'Save entry' }));
    await waitFor(() => expect(saveEntry).toHaveBeenCalled());
    expect(saveEntry.mock.calls[0]![0]).not.toHaveProperty('signInMethods');
  });

  it('normalizes decomposed provider accounts before the actual create input reaches the strict worker guard', async () => {
    const saveEntry = vi.fn(async (input: import('../../background/vault/protocol2/service').ManualEntrySaveInput) => {
      if (!isManualEntrySaveInput(input)) throw new Error('Invalid worker input');
      return { status: 'saved' } as const;
    });
    render(<AddEntryForm client={client(saveEntry)} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Name'), 'Unicode OAuth');
    await user.click(screen.getByRole('button', { name: 'Add a sign-in method' }));
    await user.type(screen.getByLabelText('Account (optional)'), '  Zoe\u0308@example.test  ');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    await user.click(screen.getByRole('button', { name: 'Save entry' }));
    await waitFor(() => expect(saveEntry).toHaveBeenCalledWith(expect.objectContaining({ signInMethods: [expect.objectContaining({ account: 'Zoë@example.test' })] })));
    expect(await screen.findByRole('status')).toHaveTextContent('Entry saved securely');
  });

  it("offers every canonical entry type", async () => {
    render(<AddEntryForm client={client()} />);
    await userEvent.setup().click(screen.getByRole("combobox", { name: "Entry type" }));
    const options = screen.getAllByRole("option");
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
    await user.click(screen.getByRole("combobox", { name: "Type of additional field 1" }));
    await user.click(screen.getByRole("option", { name: "Hidden" }));
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
  }, 15_000);

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

    await user.click(type);
    await user.click(screen.getByRole("option", { name: "API key" }));
    await user.type(screen.getByLabelText("Name"), "API token");
    await user.type(screen.getByLabelText("Secret value"), "secret-key");
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    await waitFor(() => expect(saveEntry).toHaveBeenLastCalledWith({ entryType: "key", label: "API token", value: "secret-key" }));

    await user.click(type);
    await user.click(screen.getByRole("option", { name: "Script" }));
    await user.type(screen.getByLabelText("Name"), "Deploy");
    await user.type(screen.getByLabelText("Script source"), "echo ok");
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    await waitFor(() => expect(saveEntry).toHaveBeenLastCalledWith({ entryType: "script", label: "Deploy", source: "echo ok", interpreter: "bash" }));

    await user.click(type);
    await user.click(screen.getByRole("option", { name: "Payment card" }));
    await user.type(screen.getByLabelText("Name"), "Personal card");
    await user.type(screen.getByLabelText("Cardholder name"), "Ada Lovelace");
    await user.type(screen.getByLabelText("Card number"), "4111 1111 1111 1111");
    await user.type(screen.getByLabelText("Expiry month"), "08");
    await user.type(screen.getByLabelText("Expiry year"), "2030");
    await user.type(screen.getByLabelText("CVV / CVC"), "012");
    await user.click(screen.getByRole("button", { name: "Save entry" }));
    await waitFor(() => expect(saveEntry).toHaveBeenLastCalledWith(expect.objectContaining({ entryType: "creditCard", label: "Personal card", cvv: "012" })));
    expect(screen.getByLabelText("CVV / CVC")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("CVV / CVC")).toHaveValue("");
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

describe('capture draft reuse', () => {
  it('conceals captured values and saves edits only through the injected action', async () => {
    const manual = vi.fn(); const captured = vi.fn(async () => ({ status: 'saved' }) as const);
    render(<AddEntryForm client={client(manual)} initialEntry={{ entryType: 'key', label: 'Captured', value: 'synthetic-captured-value' }} onSave={captured} />);
    const value = screen.getByLabelText('Secret value'); expect(value).toHaveAttribute('type', 'password');
    expect(value).toHaveValue('synthetic-captured-value'); expect(captured).not.toHaveBeenCalled();
    fireEvent.change(value, { target: { value: 'edited-captured-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));
    await waitFor(() => expect(captured).toHaveBeenCalledWith({ entryType: 'key', label: 'Captured', value: 'edited-captured-value' }));
    expect(manual).not.toHaveBeenCalled();
  });
});

it('keeps capture details and custom fields collapsed and delegates the submit footer', () => {
  render(<AddEntryForm client={{} as VaultClient} initialEntry={{ entryType: 'key', label: 'Example', value: 'synthetic-value' }} captureFormId="capture-test" />);
  expect(screen.queryByRole('button', { name: 'Save entry' })).toBeNull();
  expect(screen.getByText('Additional details').closest('details')).not.toHaveAttribute('open');
  expect(screen.getByText('Additional fields', { selector: 'summary' }).closest('details')).not.toHaveAttribute('open');
  expect(screen.queryByRole('combobox', { name: 'Entry type' })).toBeNull();
});

it('edits authenticator additional fields masked and saves canonical configuration', async () => {
  const save = vi.fn(async () => ({ status: 'saved' as const }));
  render(<AddEntryForm client={client(save)} initialEntry={{ entryType: 'key', label: 'Example', value: 'synthetic', customFields: [{ id: 'custom:authenticator', label: 'One-time code', type: 'totp', value: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 } }] }} />);
  const value = screen.getByLabelText('Value of additional field 1');
  expect(value).toHaveAttribute('type', 'password');
  fireEvent.change(value, { target: { value: 'invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));
  await screen.findByText("Couldn't save this entry");
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(value, { target: { value: 'otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ customFields: [expect.objectContaining({ type: 'totp', value: expect.objectContaining({ secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30 }) })] })));
});
it('orders captured card expiry before CVC and explains its source', () => {
  render(<AddEntryForm client={client()} captureFormId="card-review" initialEntry={{entryType:'creditCard',label:'Visa',cardNumber:'4111111111111111',cardholderName:'Example',expiryMonth:'06',expiryYear:'2029',cvv:'123'}} />);
  expect(screen.getByLabelText('Expiry year').compareDocumentPosition(screen.getByLabelText('CVV / CVC')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText('Captured from the payment form. Check before saving.')).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Choose icon'})).toBeNull();
});
it('focuses a new capture additional field and explains TOTP setup input', async () => {
  render(<AddEntryForm client={client()} captureFormId="login-review" initialEntry={{entryType:'credential',label:'Example',username:'alice',password:'synthetic'}} />);
  fireEvent.click(screen.getByText('Additional fields', {selector:'summary'}));
  fireEvent.click(screen.getByRole('button',{name:'Add field'}));
  expect(screen.getByLabelText('Name of additional field 1')).toHaveFocus();
  fireEvent.click(screen.getByRole('combobox',{name:'Type of additional field 1'}));
  fireEvent.click(screen.getByRole('option',{name:'One-time password (TOTP)'}));
  expect(screen.getByPlaceholderText('Setup key or otpauth:// URI')).toHaveAttribute('type','password');
  expect(screen.getByText('Enter the setup key from the service, not the current six-digit code.')).toBeInTheDocument();
});

it('reveals only the captured card field selected by the user', () => {
  render(<AddEntryForm client={client()} captureFormId="capture-card" initialEntry={{entryType:'creditCard',label:'Visa',cardNumber:'4111111111111111',cardholderName:'Example',expiryMonth:'12',expiryYear:'2031',cvv:'739'}} />);
  const number = screen.getByLabelText('Card number');
  const cvv = screen.getByLabelText('CVV / CVC');
  expect(number).toHaveAttribute('type','password');
  fireEvent.click(screen.getByRole('button',{name:'Show Card number'}));
  expect(number).toHaveAttribute('type','text');
  expect(cvv).toHaveAttribute('type','password');
  fireEvent.click(screen.getByRole('button',{name:'Hide Card number'}));
  expect(number).toHaveAttribute('type','password');
});
