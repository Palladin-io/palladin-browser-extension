// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/config/build-target", () => ({ clipboardCopyAvailable: false }));

import type { VaultClient } from "./vault/client";
import { CopyButton } from "./components/CopyButton";
import { GeneratorPanel } from "./generator/GeneratorPanel";

const client = {} as VaultClient;

describe("non-Chromium clipboard UI", () => {
  it("does not render entry or generator Copy actions", () => {
    const { rerender } = render(
      <CopyButton
        client={client}
        vaultId="vault-1"
        entryId="entry-1"
        field="password"
        label="Copy password"
      />,
    );
    expect(screen.queryByRole("button", { name: /copy/i })).not.toBeInTheDocument();

    rerender(<GeneratorPanel client={client} />);
    expect(screen.queryByRole("button", { name: /^copy$/i })).not.toBeInTheDocument();
  });
});
