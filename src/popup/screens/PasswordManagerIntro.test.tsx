// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { PasswordManagerIntro } from "./PasswordManagerIntro";

describe("password-manager first-run guidance", () => {
  it("explains the conflict without claiming to detect another manager", async () => {
    render(
      <PasswordManagerIntro
        onContinue={vi.fn(async () => undefined)}
        onOpenPasswordSettings={vi.fn(async () => undefined)}
        onOpenExtensionManager={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole("heading", { name: "One password manager works best" }))
      .toBeInTheDocument();
    expect(screen.getByText(/duplicate icons and prompts/i)).toBeInTheDocument();
    expect(screen.getByText(/turn off password autofill/i)).toBeInTheDocument();
    expect(screen.getByText(/disable other password-manager extensions/i)).toBeInTheDocument();
    expect(screen.queryByText(/scan/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("offers browser-owned shortcuts and one explicit continue action", async () => {
    const user = userEvent.setup();
    const openPasswords = vi.fn(async () => undefined);
    const openExtensions = vi.fn(async () => undefined);
    const onContinue = vi.fn(async () => undefined);
    render(
      <PasswordManagerIntro
        onContinue={onContinue}
        onOpenPasswordSettings={openPasswords}
        onOpenExtensionManager={openExtensions}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open password settings" }));
    await user.click(screen.getByRole("button", { name: "Manage extensions" }));
    await user.click(screen.getByRole("button", { name: "Continue to Palladin" }));

    expect(openPasswords).toHaveBeenCalledOnce();
    expect(openExtensions).toHaveBeenCalledOnce();
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
