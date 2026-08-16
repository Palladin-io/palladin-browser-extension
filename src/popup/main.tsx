import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { PopupPreferencesProvider } from "./preferences";
import "./popup.css";

const container = document.getElementById("root");
if (!container) throw new Error("popup root element missing");

createRoot(container).render(
  <StrictMode>
    <PopupPreferencesProvider>
      <App />
    </PopupPreferencesProvider>
  </StrictMode>,
);
