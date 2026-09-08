import { useState } from "react";
import { ArrowLeft, ArrowRight, Camera, Check, Download, Globe, Loader2, RotateCw } from "lucide-react";
import type { BrowserDownloadItem } from "../../shared/types";
import { BrowserDownloadsPanel } from "./browser-downloads-panel";
import { BrowserMenu } from "./browser-menu";
import type { ScreenshotFeedback } from "./use-webview-screenshot";
import { useI18n } from "../i18n";

export type BrowserToolbarProps = {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  addressInput: string;
  isCapturing: boolean;
  screenshotFeedback: ScreenshotFeedback;
  onAddressChange: (value: string) => void;
  onAddressKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onScreenshot: () => void;
  // Browser menu
  zoomFactor: number;
  homepage: string;
  onClearCache: () => void;
  onClearCookies: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onForceReload: () => void;
  onFindInPage: () => void;
  onOpenDevTools: () => void;
  onSetHomepage: (url: string) => Promise<void>;
  /** 独立窗口专属：还原为浏览器面板标签页（undefined 时菜单不显示该项）。 */
  onRestoreToTabs?: () => void;
  /** 主面板专属：把当前实例弹出为独立窗口（undefined 时菜单不显示该项）。 */
  onOpenInNewWindow?: () => void;
  // 下载管理
  downloads: BrowserDownloadItem[];
  onDownloadOpen: (id: number) => void;
  onDownloadShowInFolder: (id: number) => void;
  onDownloadCancel: (id: number) => void;
};

const buildScreenshotClassName = (feedback: ScreenshotFeedback): string => {
  const base = "browser-nav-btn browser-screenshot-btn";
  if (feedback === "success") return `${base} is-success`;
  if (feedback === "error") return `${base} is-error`;
  return base;
};

const renderScreenshotIcon = (isCapturing: boolean, feedback: ScreenshotFeedback): React.JSX.Element => {
  if (isCapturing) return <Loader2 size={15} strokeWidth={1.8} className="spin-icon" />;
  if (feedback === "success") return <Check size={15} strokeWidth={1.8} />;
  return <Camera size={15} strokeWidth={1.8} />;
};

/**
 * 浏览器顶部工具栏：后退 / 前进 / 刷新、地址栏、截图（整页 PNG 到剪贴板）、
 * 下载面板入口与「更多操作」菜单。
 * 移植自 Snow App（MIT）BrowserToolbar.tsx（去掉元素选择按钮，随 Layer D 回归）。
 */
export const BrowserToolbar = ({
  canGoBack,
  canGoForward,
  isLoading,
  addressInput,
  isCapturing,
  screenshotFeedback,
  onAddressChange,
  onAddressKeyDown,
  onBack,
  onForward,
  onReload,
  onScreenshot,
  zoomFactor,
  homepage,
  onClearCache,
  onClearCookies,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onForceReload,
  onFindInPage,
  onOpenDevTools,
  onSetHomepage,
  onRestoreToTabs,
  onOpenInNewWindow,
  downloads,
  onDownloadOpen,
  onDownloadShowInFolder,
  onDownloadCancel,
}: BrowserToolbarProps): React.JSX.Element => {
  const { t } = useI18n();
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const activeDownloadCount = downloads.filter((item) => item.state === "progressing").length;

  return (
    <div className="browser-toolbar">
      <button type="button" className="browser-nav-btn" onClick={onBack} disabled={!canGoBack} aria-label={t("browser.back")} title={t("browser.back")}>
        <ArrowLeft size={15} strokeWidth={1.8} />
      </button>
      <button type="button" className="browser-nav-btn" onClick={onForward} disabled={!canGoForward} aria-label={t("browser.forward")} title={t("browser.forward")}>
        <ArrowRight size={15} strokeWidth={1.8} />
      </button>
      <button type="button" className="browser-nav-btn" onClick={onReload} aria-label={t("browser.reload")} title={t("browser.reload")}>
        {isLoading ? <Loader2 size={15} strokeWidth={1.8} className="spin-icon" /> : <RotateCw size={15} strokeWidth={1.8} />}
      </button>
      <div className="browser-address-bar">
        <Globe size={13} strokeWidth={1.6} className="browser-address-icon" />
        <input
          type="text"
          className="browser-address-input"
          value={addressInput}
          onChange={(e) => onAddressChange(e.target.value)}
          onKeyDown={onAddressKeyDown}
          placeholder={t("browser.addressPlaceholder")}
          spellCheck={false}
        />
      </div>
      <button
        type="button"
        className={buildScreenshotClassName(screenshotFeedback)}
        onClick={onScreenshot}
        disabled={isCapturing}
        aria-label={t("browser.screenshot")}
        title={t("browser.screenshotTitle")}
      >
        {renderScreenshotIcon(isCapturing, screenshotFeedback)}
      </button>
      <button
        type="button"
        className={`browser-nav-btn browser-downloads-btn${downloadsOpen ? " is-active" : ""}`}
        onClick={() => setDownloadsOpen((prev) => !prev)}
        disabled={downloads.length === 0 && activeDownloadCount === 0}
        aria-label={t("browser.downloadsTitle")}
        title={t("browser.downloadsTitle")}
      >
        <Download size={15} strokeWidth={1.8} />
        {activeDownloadCount > 0 && <span className="browser-downloads-badge">{activeDownloadCount}</span>}
      </button>
      <BrowserMenu
        zoomFactor={zoomFactor}
        homepage={homepage}
        onClearCache={onClearCache}
        onClearCookies={onClearCookies}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onZoomReset={onZoomReset}
        onForceReload={onForceReload}
        onFindInPage={onFindInPage}
        onOpenDevTools={onOpenDevTools}
        onSetHomepage={onSetHomepage}
        onRestoreToTabs={onRestoreToTabs}
        onOpenInNewWindow={onOpenInNewWindow}
      />
      {downloadsOpen && (
        <BrowserDownloadsPanel
          items={downloads}
          onOpen={onDownloadOpen}
          onShowInFolder={onDownloadShowInFolder}
          onCancel={onDownloadCancel}
          onClose={() => setDownloadsOpen(false)}
        />
      )}
    </div>
  );
};
