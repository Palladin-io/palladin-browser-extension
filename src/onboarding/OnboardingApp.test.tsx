// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ServerConfigClient } from "../popup/config/client";
import {
  OnboardingApp,
  openExtensionSurface,
  validatedPublicHttpsUrl,
  type ExtensionSurfaceBrowserApi,
} from "./OnboardingApp";

function serverClient(apiUrl = "https://api.palladin.io"): ServerConfigClient {
  return {
    get: vi.fn(async () => ({ apiUrl, changed: false })),
    save: vi.fn(async (next) => ({ apiUrl: next, changed: next !== apiUrl })),
  };
}

function dependencies(status: "signed-out" | "locked" | "unlocked" = "signed-out") {
  return {
    sessionClient: { getStatus: vi.fn(async () => status) },
    serverClient: serverClient(),
    onboardingClient: {
      complete: vi.fn(async () => undefined),
      openExtensionManager: vi.fn(async () => undefined),
    },
    browserActions: {
      openExtension: vi.fn(async () => undefined),
      openExternal: vi.fn(async () => undefined),
      openWebPanel: vi.fn(async () => undefined),
    },
  };
}

describe("full-page extension onboarding", () => {
  it("accepts only credential-free public HTTPS footer URLs", () => {
    expect(validatedPublicHttpsUrl("https://palladin.io/panel")).toBe("https://palladin.io/panel");
    expect(validatedPublicHttpsUrl("https://team.github.io/palladin")).toBe("https://team.github.io/palladin");
    expect(validatedPublicHttpsUrl("http://localhost:5173")).toBeNull();
    expect(validatedPublicHttpsUrl("https://localhost:5173")).toBeNull();
    expect(validatedPublicHttpsUrl("https://127.0.0.1")).toBeNull();
    expect(validatedPublicHttpsUrl("https://intranet")).toBeNull();
    expect(validatedPublicHttpsUrl("https://user:secret@example.com")).toBeNull();
    expect(validatedPublicHttpsUrl("not a url")).toBeNull();
  });

  it("falls back to an extension-owned tab when the browser cannot open the action popup", async () => {
    const api: ExtensionSurfaceBrowserApi = {
      openPopup: vi.fn(async () => { throw new Error("not available"); }),
      getUrl: (path) => `chrome-extension://palladin/${path}`,
      openTab: vi.fn(async () => undefined),
    };

    await openExtensionSurface(api);

    expect(api.openPopup).toHaveBeenCalledOnce();
    expect(api.openTab).toHaveBeenCalledWith({
      url: "chrome-extension://palladin/src/popup/index.html",
      active: true,
    });
  });

  it("keeps the browser action popup as the preferred handoff", async () => {
    const api: ExtensionSurfaceBrowserApi = {
      openPopup: vi.fn(async () => undefined),
      getUrl: vi.fn(),
      openTab: vi.fn(async () => undefined),
    };

    await openExtensionSurface(api);

    expect(api.openPopup).toHaveBeenCalledOnce();
    expect(api.openTab).not.toHaveBeenCalled();
  });

  it("starts with branded pinning guidance for the current browser", async () => {
    const deps = dependencies();
    render(<OnboardingApp {...deps} target="chromium" />);

    expect(screen.getByRole("heading", { name: "Your passwords, ready where you need them." }))
      .toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Keep Palladin one click away" }))
      .toBeInTheDocument();
    expect(screen.queryByText("Palladin browser extension")).not.toBeInTheDocument();
    expect(screen.queryByText("Zero-knowledge by design")).not.toBeInTheDocument();
    expect(screen.getByText("Find Palladin.io and select the pin icon."))
      .toBeInTheDocument();
    await waitFor(() => expect(deps.sessionClient.getStatus).toHaveBeenCalledOnce());
  });

  it("opens public browser guidance when internal extension settings are blocked", async () => {
    const deps = dependencies();
    deps.onboardingClient.openExtensionManager.mockRejectedValueOnce(new Error("blocked"));
    const user = userEvent.setup();
    render(<OnboardingApp {...deps} target="chromium" />);

    await user.click(screen.getByRole("button", { name: "Manage extensions" }));

    expect(deps.browserActions.openExternal).toHaveBeenCalledWith(
      "https://support.google.com/chrome_webstore/answer/2664769",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps custom server setup secondary and persists a validated URL", async () => {
    const deps = dependencies();
    const user = userEvent.setup();
    render(<OnboardingApp {...deps} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Connect your Palladin account" }))
      .toBeInTheDocument();
    const accountStatus = screen.getByRole("status");
    expect(accountStatus).toHaveTextContent("No account connected yet");
    expect(accountStatus.querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveClass("button--accent");
    expect(screen.getByRole("button", { name: "Open sign-in" })).toHaveClass("button--subtle");
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "Use a custom Palladin server" }));
    const input = await screen.findByLabelText("Server URL");
    await user.clear(input);
    await user.type(input, "https://vault.example.com/api/");
    await user.click(screen.getByRole("button", { name: "Save server" }));

    await waitFor(() => {
      expect(deps.serverClient.save).toHaveBeenCalledWith("https://vault.example.com/api/");
    });

    await user.click(screen.getByRole("switch", { name: "Use a custom Palladin server" }));
    await waitFor(() => {
      expect(deps.serverClient.save).toHaveBeenLastCalledWith("https://api.palladin.io");
    });
  });

  it("opens secure sign-in without waiting on storage and losing user activation", async () => {
    const deps = dependencies();
    let finishStorage!: () => void;
    deps.onboardingClient.complete.mockImplementation(
      () => new Promise<undefined>((resolve) => {
        finishStorage = () => resolve(undefined);
      }),
    );
    const user = userEvent.setup();
    render(<OnboardingApp {...deps} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Open sign-in" }));

    expect(deps.browserActions.openExtension).toHaveBeenCalledOnce();
    finishStorage();
  });

  it("opens import in the web panel and records completion", async () => {
    const deps = dependencies("locked");
    const user = userEvent.setup();
    render(<OnboardingApp {...deps} />);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Account connected");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const openPanel = screen.getByRole("button", { name: "Open web panel" });
    const finish = screen.getByRole("button", { name: "Finish setup" });
    expect(openPanel).toHaveClass("button--subtle");
    expect(finish).toHaveClass("button--accent");

    await user.click(openPanel);
    expect(deps.browserActions.openWebPanel).toHaveBeenCalledWith("/vaults?intent=import");

    await user.click(finish);
    expect(await screen.findByRole("heading", { name: "Palladin.io" }))
      .toBeInTheDocument();
    expect(document.querySelector(".completion-logo")).toBeInTheDocument();
    expect(screen.getByText(/It's ready\. Open the extension/)).toBeInTheDocument();
    expect(screen.queryByText("Setup complete")).not.toBeInTheDocument();
    expect(screen.getByText("Web panel")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("App Store")).toHaveAttribute("aria-disabled", "true");
    expect(deps.onboardingClient.complete).toHaveBeenCalledTimes(2);
  });
});
