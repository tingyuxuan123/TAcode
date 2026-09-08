import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { BrowserDownloadItem, BrowserTabSnapshot } from "../../shared/types";
import { BrowserFindBar, type BrowserFindResult } from "./browser-find-bar";
import { BrowserToolbar } from "./browser-toolbar";
import { useBrowserHomepage } from "./homepage";
import { useWebviewScreenshot } from "./use-webview-screenshot";
import { DEFAULT_BROWSER_HOMEPAGE, normalizeUrl, sameUrlLoose } from "./url";
import { useI18n } from "../i18n";

export type BrowserPanelProps = {
  instanceId: string;
  initialUrl: string;
  isActive: boolean;
  /**
   * 实例内部全部标签页快照回调（增删 / 导航 / 切换激活页时触发，激活页置首）。
   * 独立窗口模式经由主进程 query 携带快照迁移实例。
   */
  onTabsChange?: (tabs: BrowserTabSnapshot[]) => void;
  /** 独立窗口「还原为标签页」时携带的快照（激活页置首），优先于 initialUrl。 */
  initialTabs?: BrowserTabSnapshot[];
  /** 主面板专属：把当前实例弹出为独立窗口（undefined 时菜单不显示该项）。 */
  onOpenDetached?: (url: string, tabs: BrowserTabSnapshot[]) => void;
} & (
  | { detached: true; onOpenTab?: never; onClose?: never }
  | { detached?: false; onOpenTab(url: string, activate: boolean): void; onClose(): void }
);

/**
 * Navigation error codes that are expected during normal browsing and should
 * not surface as real failures: -3 ERR_ABORTED (page redirected), -2
 * ERR_FAILED (request cancelled by a redirect).
 */
const SUPPRESSED_ERROR_CODES = new Set([-3, -2]);

/** 浏览器实例内部的标签页状态（每个标签页对应一个独立 <webview>）。 */
type BrowserWebviewTab = {
  id: string;
  /** 当前加载的 URL，驱动 <webview src>（仅在显式导航时更新）。 */
  src: string;
  /** 实际页面 URL，与地址栏编辑草稿、显式导航的 src 分开保存。 */
  url: string;
  /** 地址栏显示值（跟随页面内导航实时更新）。 */
  addressInput: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
};

const createWebviewTab = (url: string): BrowserWebviewTab => ({
  id: `browser-tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  src: url,
  url,
  addressInput: url,
  title: "",
  canGoBack: false,
  canGoForward: false,
  isLoading: !!url,
});

/**
 * 浏览器面板（移植自 Snow App（MIT）BrowserPanelContent.tsx）：
 * 主面板中每个实例只承载一个网页，标签由顶部工作区统一管理；独立窗口
 * 内部保留多个标签页。各 webview 保持挂载以保留历史、表单和滚动状态。
 * guest 内的标签页级打开请求经 browser:open-tab 路由到对应标签栏；
 * 窗口级弹出（OAuth 等）由主进程创建真实窗口。
 *
 * Agent 操作由主进程 CDP 控制器执行；本面板登记 guest 并处理标签展示。
 * homepage 存 localStorage 而非设置数据库。
 */
export const BrowserPanel = ({
  instanceId,
  initialUrl,
  isActive,
  onTabsChange,
  detached = false,
  initialTabs,
  onOpenDetached,
  onOpenTab,
  onClose,
}: BrowserPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const panelCallbacks = useRef({ onOpenTab, onClose });
  panelCallbacks.current = { onOpenTab, onClose };
  const onTabsChangeRef = useRef(onTabsChange);
  onTabsChangeRef.current = onTabsChange;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const { homepage, loaded, setHomepage } = useBrowserHomepage();
  const homepageRef = useRef(homepage);
  homepageRef.current = homepage;

  const initialTabIdRef = useRef<string>(
    `browser-tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const [webviewTabs, setWebviewTabs] = useState<BrowserWebviewTab[]>(() => {
    const snapshotTabs = (detached ? initialTabs : initialTabs?.slice(0, 1))?.filter((tab) => tab.url.trim());
    if (snapshotTabs && snapshotTabs.length > 0) {
      return snapshotTabs.map((tab, index) => ({
        id:
          index === 0
            ? initialTabIdRef.current
            : `browser-tab-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        src: tab.url,
        url: tab.url,
        addressInput: tab.url,
        title: tab.title ?? "",
        canGoBack: false,
        canGoForward: false,
        isLoading: true,
      }));
    }
    const startUrl = initialUrl
      ? normalizeUrl(initialUrl, homepage)
      : loaded && homepage
        ? homepage
        : "";
    return [
      {
        id: initialTabIdRef.current,
        src: startUrl,
        url: startUrl,
        addressInput: startUrl,
        title: "",
        canGoBack: false,
        canGoForward: false,
        isLoading: !!startUrl,
      },
    ];
  });
  const [activeWebviewTabId, setActiveWebviewTabId] = useState<string>(initialTabIdRef.current);
  const activeWebviewTabIdRef = useRef<string>(initialTabIdRef.current);
  const webviewTabsRef = useRef(webviewTabs);
  webviewTabsRef.current = webviewTabs;
  // tabId -> webview 元素（所有标签页保持挂载以保留页面状态）。
  const webviewElementsRef = useRef<Map<string, Electron.WebviewTag>>(new Map());
  // guest webContents id -> tabId：把主进程 browser:open-tab 事件路由到实例内的标签页。
  const webviewGuestIdToTabIdRef = useRef<Map<number, string>>(new Map());
  // 当前激活标签页的 webview（工具栏操作 / 截图都作用于它）。
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [findVisible, setFindVisible] = useState(false);
  const [findText, setFindText] = useState("");
  const [findResult, setFindResult] = useState<BrowserFindResult | null>(null);
  const [downloads, setDownloads] = useState<BrowserDownloadItem[]>([]);
  // guest preload 路径由主进程提供（沙箱 preload 无 __dirname），就绪后才挂 webview。
  const [webviewPreload, setWebviewPreload] = useState("");
  const { isCapturing, feedback, captureScreenshot } = useWebviewScreenshot(webviewRef);

  useEffect(() => {
    window.harness.browser
      .webviewPreloadPath()
      .then(setWebviewPreload)
      .catch(() => {});
  }, []);

  const activeTab = webviewTabs.find((tab) => tab.id === activeWebviewTabId) ?? webviewTabs[0];

  const updateWebviewTab = useCallback(
    (tabId: string, updater: (tab: BrowserWebviewTab) => BrowserWebviewTab): void => {
      setWebviewTabs((prev) => prev.map((tab) => (tab.id === tabId ? updater(tab) : tab)));
    },
    [],
  );

  /**
   * 静音状态对齐 Chrome 后台标签页：仅当面板激活且该标签页为当前激活页时
   * 才允许出声。webview 方法要求 guest 已 dom-ready，未就绪会抛异常。
   */
  const applyMutedState = useCallback((): void => {
    const mutedForTab = (tabId: string): boolean =>
      !isActiveRef.current || tabId !== activeWebviewTabIdRef.current;
    for (const [tabId, webview] of webviewElementsRef.current) {
      try {
        webview.setAudioMuted(mutedForTab(tabId));
      } catch {
        // guest 尚未就绪（dom-ready 未触发），等 dom-ready 后重试。
      }
    }
  }, []);

  /** 为某个标签页的 webview 绑定事件监听（元素挂载时调用一次）。 */
  const attachWebviewListeners = useCallback(
    (webview: Electron.WebviewTag, tabId: string): void => {
      const handleDomReady = (): void => {
        try {
          webviewGuestIdToTabIdRef.current.set(webview.getWebContentsId(), tabId);
          void window.harness.browser.registerTab({ instanceId, tabId, webContentsId: webview.getWebContentsId() }).catch(console.error);
        } catch {
          // guest 尚未就绪，忽略。
        }
        applyMutedState();
      };

      const handleNavigationStateUpdate = (): void => {
        const canGoBack = webview.canGoBack();
        const canGoForward = webview.canGoForward();
        updateWebviewTab(tabId, (tab) => ({ ...tab, canGoBack, canGoForward }));
      };

      // did-navigate 覆盖所有导航（含服务端重定向与页内 pushState）。
      // 更新实际 URL 和地址栏，刻意不更新 tab.src —— 改 src 会触发属性观察器
      // 重新 loadURL，重定向场景会形成无限循环（如 Cloudflare 挑战页）。
      const handleDidNavigate = (e: Electron.DidNavigateEvent): void => {
        if ("isMainFrame" in e && e.isMainFrame === false) return;
        updateWebviewTab(tabId, (tab) => ({ ...tab, url: e.url, addressInput: e.url }));
        handleNavigationStateUpdate();
        if (tabId === activeWebviewTabIdRef.current) {
          setZoomFactor(webview.getZoomFactor());
        }
      };

      const handleDidStartLoading = (): void => {
        updateWebviewTab(tabId, (tab) => ({ ...tab, isLoading: true }));
      };

      const handleDidStopLoading = (): void => {
        updateWebviewTab(tabId, (tab) => ({ ...tab, isLoading: false }));
        handleNavigationStateUpdate();
      };

      const handlePageTitleUpdated = (e: Electron.PageTitleUpdatedEvent): void => {
        updateWebviewTab(tabId, (tab) => ({ ...tab, title: e.title }));
      };

      const handleDidFailLoad = (
        e: Event & { errorCode?: number; isMainFrame?: boolean },
      ): void => {
        if (e.errorCode !== undefined && SUPPRESSED_ERROR_CODES.has(e.errorCode)) return;
        void e.isMainFrame;
      };

      const handleFoundInPage = (e: Electron.FoundInPageEvent): void => {
        setFindResult({
          activeMatchOrdinal: e.result.activeMatchOrdinal,
          matches: e.result.matches,
        });
      };

      webview.addEventListener("dom-ready", handleDomReady);
      webview.addEventListener("did-navigate", handleDidNavigate);
      webview.addEventListener("did-navigate-in-page", handleDidNavigate);
      webview.addEventListener("did-start-loading", handleDidStartLoading as EventListener);
      webview.addEventListener("did-stop-loading", handleDidStopLoading as EventListener);
      webview.addEventListener("page-title-updated", handlePageTitleUpdated as EventListener);
      webview.addEventListener("did-fail-load", handleDidFailLoad as EventListener);
      webview.addEventListener("found-in-page", handleFoundInPage);
    },
    [updateWebviewTab, applyMutedState, instanceId],
  );

  /** 所有 webview 共用的稳定 ref callback（重渲染不重绑监听器）。 */
  const handleWebviewRef = useCallback(
    (el: Electron.WebviewTag | null): void => {
      const webview = el as unknown as Electron.WebviewTag | null;
      if (!webview) return;
      const tabId = (webview as HTMLElement).dataset.tabId;
      if (!tabId) return;
      // allowpopups 必须以 DOM API 写入字符串属性：React 会丢弃未知的
      // 布尔属性，而 guest 默认 disablePopups=true 会拦截一切 window.open。
      webview.setAttribute("allowpopups", "true");
      const isNew = !webviewElementsRef.current.has(tabId);
      webviewElementsRef.current.set(tabId, webview);
      if (isNew) attachWebviewListeners(webview, tabId);
      if (tabId === activeWebviewTabIdRef.current) webviewRef.current = webview;
    },
    [attachWebviewListeners],
  );

  // homepage 迟到加载时（无显式 initialUrl / initialTabs），给首个空标签页补导航。
  useEffect(() => {
    if (!loaded || initialUrl || (initialTabs && initialTabs.length > 0)) return;
    const url = normalizeUrl(homepage || DEFAULT_BROWSER_HOMEPAGE, homepage);
    setWebviewTabs((prev) => {
      const first = prev[0];
      if (!first || first.src) return prev;
      return [{ ...first, src: url, url, addressInput: url, isLoading: true }];
    });
  }, [loaded, initialUrl, homepage, initialTabs]);

  const addWebviewTab = (url: string, activate: boolean): void => {
    const normalized = normalizeUrl(url, homepageRef.current);
    if (!detached) {
      panelCallbacks.current.onOpenTab?.(normalized, activate);
      return;
    }
    const newTab = createWebviewTab(normalized);
    setWebviewTabs((prev) => [...prev, newTab]);
    if (activate) {
      activeWebviewTabIdRef.current = newTab.id;
      setActiveWebviewTabId(newTab.id);
      webviewRef.current = null;
      applyMutedState();
    }
  };

  const handleNewWebviewTab = (): void => {
    addWebviewTab(homepageRef.current || DEFAULT_BROWSER_HOMEPAGE, true);
  };

  // 主进程 browser:open-tab：guest 内的标签页级打开请求（JS window.open 走
  // setWindowOpenHandler；target=_blank 点击经 guest preload 中继）。按 guest
  // webContents id 路由：属于本实例的 webview 发起时才新建标签页。
  useEffect(() => {
    return window.harness.browser.onOpenTab((event) => {
      const tabId = webviewGuestIdToTabIdRef.current.get(event.guestWebContentsId);
      if (!tabId) return;
      addWebviewTab(event.url, event.disposition !== "background-tab");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 下载列表：初始拉取一次，之后由主进程增量推送。
  useEffect(() => {
    window.harness.browser
      .listDownloads()
      .then(setDownloads)
      .catch(() => {});
    return window.harness.browser.onDownloadsUpdated(setDownloads);
  }, []);

  const handleDownloadOpen = (id: number): void => {
    void window.harness.browser.openDownload(id).catch(() => {});
  };
  const handleDownloadShowInFolder = (id: number): void => {
    void window.harness.browser.showDownloadInFolder(id);
  };
  const handleDownloadCancel = (id: number): void => {
    void window.harness.browser.cancelDownload(id).catch(() => {});
  };

  useEffect(() => {
    applyMutedState();
  }, [isActive, activeWebviewTabId, applyMutedState]);

  const handleActivateWebviewTab = (tabId: string): void => {
    if (tabId === activeWebviewTabIdRef.current) return;
    activeWebviewTabIdRef.current = tabId;
    setActiveWebviewTabId(tabId);
    const webview = webviewElementsRef.current.get(tabId) ?? null;
    webviewRef.current = webview;
    applyMutedState();
    setZoomFactor(webview ? webview.getZoomFactor() : 1);
    webview?.focus();
  };

  const handleCloseWebviewTab = (tabId: string): void => {
    if (!webviewTabsRef.current.some((tab) => tab.id === tabId)) return;
    if (!detached) {
      panelCallbacks.current.onClose?.();
      return;
    }
    for (const [guestId, mappedTabId] of webviewGuestIdToTabIdRef.current) {
      if (mappedTabId === tabId) webviewGuestIdToTabIdRef.current.delete(guestId);
    }
    webviewElementsRef.current.delete(tabId);

    const tabsBefore = webviewTabsRef.current;
    const index = tabsBefore.findIndex((tab) => tab.id === tabId);
    const wasActive = activeWebviewTabIdRef.current === tabId;
    const remaining = tabsBefore.filter((tab) => tab.id !== tabId);

    if (remaining.length === 0) {
      // 关闭最后一个标签页：新建一个首页标签页（对齐 Chrome 行为）。
      const url = normalizeUrl(homepageRef.current, homepageRef.current);
      const newTab = createWebviewTab(url);
      setWebviewTabs([newTab]);
      activeWebviewTabIdRef.current = newTab.id;
      setActiveWebviewTabId(newTab.id);
      webviewRef.current = null;
      applyMutedState();
      return;
    }

    setWebviewTabs(remaining);

    if (wasActive) {
      // 激活左侧相邻标签页；没有则右侧相邻。
      const nextActive = remaining[index - 1] ?? remaining[index];
      activeWebviewTabIdRef.current = nextActive.id;
      setActiveWebviewTabId(nextActive.id);
      const webview = webviewElementsRef.current.get(nextActive.id) ?? null;
      webviewRef.current = webview;
      applyMutedState();
      setZoomFactor(webview ? webview.getZoomFactor() : 1);
      webview?.focus();
    }
  };

  const [pendingPresentation, setPendingPresentation] = useState<{ requestId: string; tabId: string } | null>(null);
  const agentPresentationRef = useRef({ select: handleActivateWebviewTab, close: handleCloseWebviewTab });
  agentPresentationRef.current = { select: handleActivateWebviewTab, close: handleCloseWebviewTab };
  useEffect(() => window.harness.browser.onAgentPresentation((event) => {
    if (event.instanceId !== instanceId || event.action === "open") return;
    if (event.action === "select") {
      agentPresentationRef.current.select(event.tabId);
      if (event.requestId) setPendingPresentation({ requestId: event.requestId, tabId: event.tabId });
    }
    else agentPresentationRef.current.close(event.tabId);
  }), [instanceId]);

  // Acknowledge only after React has selected the guest and the host layout is visible.
  useEffect(() => {
    if (!pendingPresentation || pendingPresentation.tabId !== activeWebviewTabId || !isActive) return;
    let frame = 0;
    const deadline = Date.now() + 5000;
    const check = () => {
      if (Date.now() > deadline) { setPendingPresentation(null); return; }
      const guest = webviewElementsRef.current.get(pendingPresentation.tabId);
      const bounds = guest?.getBoundingClientRect();
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        window.harness.browser.presentationReady(pendingPresentation.requestId);
        setPendingPresentation(null);
      } else frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [pendingPresentation, activeWebviewTabId, isActive]);

  const handleNavigate = (rawInput?: string): void => {
    const currentTab = webviewTabsRef.current.find((tab) => tab.id === activeWebviewTabIdRef.current);
    if (!currentTab) return;
    const input = (rawInput ?? currentTab.addressInput).trim();
    if (!input) return;
    const url = normalizeUrl(input, homepageRef.current);
    const webview = webviewRef.current;
    updateWebviewTab(currentTab.id, (tab) => ({ ...tab, addressInput: url }));
    if (!webview) return;
    if (sameUrlLoose(url, currentTab.src)) {
      // 同 URL：src 不会变化，显式 reload。
      webview.reload();
    } else {
      // 不同 URL：更新 src 触发属性观察器导航。不直接 loadURL，避免与
      // src 导航竞争产生多余的 ERR_ABORTED。
      updateWebviewTab(currentTab.id, (tab) => ({ ...tab, src: url }));
    }
  };

  const handleAddressChange = (value: string): void => {
    updateWebviewTab(activeWebviewTabIdRef.current, (tab) => ({ ...tab, addressInput: value }));
  };

  const handleAddressKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== "Enter") return;
    // 中文输入法组合输入期间按 Enter 是确认候选词而非提交，必须忽略。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    handleNavigate();
  };

  const handleBack = (): void => {
    const webview = webviewRef.current;
    if (webview && webview.canGoBack()) webview.goBack();
  };

  const handleForward = (): void => {
    const webview = webviewRef.current;
    if (webview && webview.canGoForward()) webview.goForward();
  };

  const handleReload = (): void => {
    webviewRef.current?.reload();
  };

  const handleClearCache = async (): Promise<void> => {
    try {
      await window.harness.browser.clearCache();
    } catch (error) {
      console.error("Failed to clear browser cache:", error);
    }
    // 忽略缓存重载，让效果立即可见。
    webviewRef.current?.reloadIgnoringCache();
  };

  const handleClearCookies = async (): Promise<void> => {
    try {
      await window.harness.browser.clearCookies();
    } catch (error) {
      console.error("Failed to clear browser cookies:", error);
    }
    webviewRef.current?.reload();
  };

  /** 实例内全部标签页的快照（激活页置首，供窗口迁移时完整携带）。 */
  const buildTabsSnapshot = useCallback((): BrowserTabSnapshot[] => {
    const activeId = activeWebviewTabIdRef.current;
    const tabs = webviewTabsRef.current;
    const active = tabs.find((tab) => tab.id === activeId);
    const rest = tabs.filter((tab) => tab.id !== activeId);
    return [...(active ? [active] : []), ...rest].map((tab) => ({
      url: tab.url || tab.src,
      title: tab.title,
    }));
  }, []);

  useEffect(() => {
    onTabsChangeRef.current?.(buildTabsSnapshot());
  }, [webviewTabs, activeWebviewTabId, buildTabsSnapshot]);

  // 独立窗口「还原为标签页」：经主进程转发给主窗口，随后独立窗口被关闭。
  const handleRestoreToTabs = useCallback((): void => {
    window.harness.browser.restoreToMain({ instanceId, tabs: buildTabsSnapshot() });
  }, [instanceId, buildTabsSnapshot]);

  // 主面板「在新窗口中打开」：弹出为独立窗口并携带全部标签页快照。
  const handleOpenDetached = useCallback((): void => {
    if (!onOpenDetached) return;
    const tabs = buildTabsSnapshot();
    const active = tabs[0];
    onOpenDetached(active?.url || homepageRef.current, tabs);
  }, [onOpenDetached, buildTabsSnapshot]);

  const applyZoom = (next: number): void => {
    setZoomFactor(next);
    webviewRef.current?.setZoomFactor(next);
  };

  const handleZoomIn = (): void => applyZoom(Math.min(Math.round((zoomFactor + 0.1) * 100) / 100, 5));
  const handleZoomOut = (): void => applyZoom(Math.max(Math.round((zoomFactor - 0.1) * 100) / 100, 0.25));
  const handleZoomReset = (): void => applyZoom(1);

  const handleForceReload = (): void => {
    webviewRef.current?.reloadIgnoringCache();
  };

  const handleOpenDevTools = (): void => {
    const webview = webviewRef.current;
    if (!webview) return;
    void window.harness.browser.openDevTools(webview.getWebContentsId()).catch((error) => {
      console.error("Failed to open browser DevTools:", error);
    });
  };

  const handleOpenFind = (): void => setFindVisible(true);

  const handleFindSearch = (text: string): void => {
    setFindText(text);
    const webview = webviewRef.current;
    if (!webview) return;
    if (text) {
      webview.findInPage(text);
    } else {
      webview.stopFindInPage("clearSelection");
      setFindResult(null);
    }
  };

  const handleFindNext = (): void => {
    if (!findText) return;
    webviewRef.current?.findInPage(findText, { forward: true, findNext: true });
  };

  const handleFindPrev = (): void => {
    if (!findText) return;
    webviewRef.current?.findInPage(findText, { forward: false, findNext: true });
  };

  const handleFindClose = (): void => {
    webviewRef.current?.stopFindInPage("clearSelection");
    setFindVisible(false);
    setFindText("");
    setFindResult(null);
  };

  return (
    <div className="browser-panel">
      <BrowserToolbar
        canGoBack={activeTab?.canGoBack ?? false}
        canGoForward={activeTab?.canGoForward ?? false}
        isLoading={activeTab?.isLoading ?? false}
        addressInput={activeTab?.addressInput ?? ""}
        isCapturing={isCapturing}
        screenshotFeedback={feedback}
        onAddressChange={handleAddressChange}
        onAddressKeyDown={handleAddressKeyDown}
        onBack={handleBack}
        onForward={handleForward}
        onReload={handleReload}
        onScreenshot={() => void captureScreenshot()}
        zoomFactor={zoomFactor}
        homepage={homepage}
        onClearCache={() => void handleClearCache()}
        onClearCookies={() => void handleClearCookies()}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
        onForceReload={handleForceReload}
        onFindInPage={handleOpenFind}
        onOpenDevTools={handleOpenDevTools}
        onSetHomepage={setHomepage}
        onRestoreToTabs={detached ? handleRestoreToTabs : undefined}
        onOpenInNewWindow={!detached && onOpenDetached ? handleOpenDetached : undefined}
        downloads={downloads}
        onDownloadOpen={handleDownloadOpen}
        onDownloadShowInFolder={handleDownloadShowInFolder}
        onDownloadCancel={handleDownloadCancel}
      />
      {detached && (
        <div className="browser-tab-bar" role="tablist">
          {webviewTabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeWebviewTabId}
              className={`browser-tab ${tab.id === activeWebviewTabId ? "active" : ""}`}
              onClick={() => handleActivateWebviewTab(tab.id)}
              title={tab.title || tab.addressInput || t("browser.newTab")}
            >
              <span className="browser-tab-title">{tab.title || tab.addressInput || t("browser.newTab")}</span>
              <button
                type="button"
                className="browser-tab-close"
                aria-label={t("browser.closeTab")}
                onClick={(e) => {
                  e.stopPropagation();
                  handleCloseWebviewTab(tab.id);
                }}
              >
                <X size={11} strokeWidth={2} />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="browser-tab-new"
            title={t("browser.newTab")}
            aria-label={t("browser.newTab")}
            onClick={handleNewWebviewTab}
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        </div>
      )}
      <div className="browser-content">
        {webviewPreload &&
          webviewTabs.map((tab) => (
            <webview
              key={tab.id}
              data-tab-id={tab.id}
              ref={handleWebviewRef}
              src={tab.src}
              className={`browser-webview ${tab.id === activeWebviewTabId ? "" : "is-hidden"}`}
              preload={webviewPreload}
              webpreferences="sandbox=no,contextIsolation=yes,nodeIntegration=no"
            />
          ))}
        {findVisible && (
          <BrowserFindBar
            value={findText}
            result={findResult}
            onSearch={handleFindSearch}
            onNext={handleFindNext}
            onPrev={handleFindPrev}
            onClose={handleFindClose}
          />
        )}
      </div>
    </div>
  );
};
