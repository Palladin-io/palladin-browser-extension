import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { PopupPreferencesProvider } from "../popup/preferences";
import { OnboardingApp } from "./OnboardingApp";
import "./onboarding.css";

const container = document.getElementById("root");
if (!container) throw new Error("onboarding root element missing");

createRoot(container).render(
  <StrictMode>
    <PopupPreferencesProvider>
      <OnboardingApp />
    </PopupPreferencesProvider>
  </StrictMode>,
);
