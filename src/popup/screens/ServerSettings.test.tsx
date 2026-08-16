// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ServerConfigClientError,
  type ServerConfigClient,
} from "../config/client";
import { ServerSettings } from "./ServerSettings";

function client(overrides: Partial<ServerConfigClient> = {}): ServerConfigClient {
  return {
    get: vi.fn(async () => ({ apiUrl: "https://api.palladin.io", changed: false })),
    save: vi.fn(async (apiUrl) => ({ apiUrl: apiUrl.trim().replace(/\/$/, ""), changed: true })),
    ...overrides,
  };
}

describe("server settings", () => {
  it("loads production by default and saves a trimmed custom HTTPS URL", async () => {
    const server = client();
    const onChanged = vi.fn();
    render(<ServerSettings client={server} onChanged={onChanged} />);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Server URL");
    expect(input).toHaveValue("https://api.palladin.io");
    await user.clear(input);
    await user.type(input, "  https://vault.example.com/  ");
    await user.click(screen.getByRole("button", { name: "Save server" }));

    await waitFor(() => expect(server.save).toHaveBeenCalledWith("https://vault.example.com/"));
    expect(await screen.findByRole("status")).toHaveTextContent("signed out");
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("offers an explicit reset to the production server", async () => {
    const server = client({
      get: vi.fn(async () => ({ apiUrl: "http://localhost:5000", changed: false })),
    });
    render(<ServerSettings client={server} onChanged={vi.fn()} />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Use production" }));
    expect(screen.getByLabelText("Server URL")).toHaveValue("https://api.palladin.io");
  });

  it("blocks an insecure non-local URL before submit", async () => {
    const server = client();
    render(<ServerSettings client={server} onChanged={vi.fn()} />);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Server URL");
    await user.clear(input);
    await user.type(input, "http://vault.example.com");
    expect(screen.getByRole("button", { name: "Save server" })).toBeDisabled();
    expect(server.save).not.toHaveBeenCalled();
  });

  it("surfaces a denied host permission without exposing raw failures", async () => {
    const server = client({
      save: vi.fn(async () => { throw new ServerConfigClientError("permission-denied"); }),
    });
    render(<ServerSettings client={server} onChanged={vi.fn()} />);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Server URL");
    await user.clear(input);
    await user.type(input, "https://vault.example.com");
    await user.click(screen.getByRole("button", { name: "Save server" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Allow access");
  });
});
