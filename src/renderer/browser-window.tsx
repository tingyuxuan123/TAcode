import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, readStoredTheme } from "../shared/theme";
import { applyTypography, readStoredTypography } from "../shared/typography";
import { BrowserPanel } from "./browser/browser-panel";
import { LocaleProvider } from "./i18n";
import type { BrowserTabSnapshot } from "../shared/types";
import "@fontsource-variable/inter/wght.css";
import "./styles.css";

applyTheme(readStoredTheme());
applyTypography(readStoredTypography());

/**
 * 独立浏览器窗口入口（「在新窗口中打开」）。
 * 复用 BrowserPanel 完整 UI；instanceId / 初始 URL / 标签页快照经 query
 * 从主窗口迁移（激活页置首）。「还原为标签页」由 BrowserPanel 内部经
 * browser:restore-to-main 发起，主进程随后关闭本窗口。
 */

const params = new URLSearchParams(window.location.search);
const instanceId = params.get("instanceId") || "main";
const url = params.get("url") || "";
let initialTabs: BrowserTabSnapshot[] | undefined;
try {
  const raw = params.get("tabs");
  const parsed: unknown = raw ? JSON.parse(raw) : undefined;
  if (Array.isArray(parsed)) {
    initialTabs = parsed.filter(
      (tab): tab is BrowserTabSnapshot =>
        !!tab && typeof tab === "object" && typeof (tab as Record<string, unknown>).url === "string",
    );
  }
} catch {
  initialTabs = undefined;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <BrowserPanel
        instanceId={instanceId}
        initialUrl={url}
        isActive
        detached
        initialTabs={initialTabs}
      />
    </LocaleProvider>
  </StrictMode>,
);
