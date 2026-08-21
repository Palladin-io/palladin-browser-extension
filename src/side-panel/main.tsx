import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "../popup/App";
import { PopupPreferencesProvider } from "../popup/preferences";
import "../popup/popup.css";

const container = document.getElementById("root");
if (!container) throw new Error("side-panel root element missing");

createRoot(container).render(
  <StrictMode>
    <PopupPreferencesProvider>
      <App surface="side-panel" />
    </PopupPreferencesProvider>
  </StrictMode>,
);
