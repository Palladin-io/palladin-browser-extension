// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PopupPreferencesProvider } from "./preferences";
import { AppearanceSettings } from "./screens/AppearanceSettings";

const get = vi.fn();
const set = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({
    "palladin.ui.preferences": { language: "pl", theme: "dark" },
  });
  Object.assign(globalThis, {
    chrome: {
      storage: { local: { get, set } },
      i18n: { getUILanguage: () => "en-US" },
    },
    matchMedia: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});

describe("popup language and theme preferences", () => {
  it("loads Polish and dark mode, then persists explicit changes", async () => {
    render(
      <PopupPreferencesProvider>
        <AppearanceSettings />
      </PopupPreferencesProvider>,
    );
    const user = userEvent.setup();

    expect(await screen.findByRole("heading", { name: "Wygląd" })).toBeInTheDocument();
    await waitFor(() => {
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(document.documentElement.lang).toBe("pl");
    });

    await user.selectOptions(screen.getByLabelText("Język"), "en");
    expect(await screen.findByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(set).toHaveBeenCalledWith({
      "palladin.ui.preferences": { language: "en", theme: "dark" },
    });

    await user.selectOptions(screen.getByLabelText("Theme"), "light");
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
  });
});
