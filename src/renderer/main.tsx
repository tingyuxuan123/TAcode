import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, readStoredTheme } from "../shared/theme";
import { applyTypography, readStoredTypography } from "../shared/typography";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { LocaleProvider } from "./i18n";
// Bundled so Windows/Linux render the same Latin text as macOS instead of thin Segoe UI.
import "@fontsource-variable/inter/wght.css";
import "katex/dist/katex.min.css";
import "./styles.css";

applyTheme(readStoredTheme());
applyTypography(readStoredTypography());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </LocaleProvider>
  </StrictMode>,
);
