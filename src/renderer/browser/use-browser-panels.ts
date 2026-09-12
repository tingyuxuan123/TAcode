import { useCallback, useEffect, useReducer } from "react";
import {
  createBrowserPanel,
  createBrowserPanelId,
  createChildSessionPanel,
  initialPanelState,
  panelReducer,
  type ChildSessionPanelInfo,
} from "./panel-state";

/** 主窗口统一管理网页标签；独立窗口仍由 BrowserPanel 管理内部标签。 */
export function useBrowserPanels() {
  const [state, dispatch] = useReducer(panelReducer, initialPanelState);
  const openBrowser = useCallback((url?: string, activate = true) => {
    dispatch({ type: "open-browser", tab: createBrowserPanel(createBrowserPanelId(), url ? { url, title: "" } : undefined), activate });
  }, []);
  const openPanel = useCallback((type: string) => {
    if (type === "review") dispatch({ type: "open-review" });
    else if (type === "files") dispatch({ type: "open-files" });
    else if (type === "terminal") dispatch({ type: "open-terminal" });
    else if (type === "side-chat") dispatch({ type: "open-side-chat" });
    else if (type === "browser") openBrowser();
  }, [openBrowser]);
  /** 侧边聊天（Codex 模式）：+/菜单、/side、选中工具条每次都新建一个编号实例。 */
  const openSideChat = useCallback((sourceSession?: string, draft?: string) => {
    dispatch({ type: "open-side-chat", ...(sourceSession ? { sourceSession } : {}), ...(draft ? { draft } : {}) });
  }, []);
  /** 快捷键语义：已有侧边聊天时聚焦最新一个，一个都没有才新建（避免连按爆标签）。 */
  const focusSideChat = useCallback(() => dispatch({ type: "focus-side-chat" }), []);
  /** 打开/激活文件查看标签；同一路径复用同一个标签（过程区文件行的点击入口）。 */
  const openFile = useCallback((path: string) => {
    const trimmed = path.trim();
    if (trimmed) dispatch({ type: "open-file", path: trimmed });
  }, []);
  const openFiles = useCallback((path?: string) => dispatch({ type: "open-files", ...(path ? { path } : {}) }), []);
  const closePanel = useCallback((id: string) => dispatch({ type: "close", id }), []);
  const selectPanel = useCallback((id: string) => dispatch({ type: "select", id }), []);
  /**
   * 打开/刷新某个委派的只读标签；key 由 `delegationPanelKey()` 推导，同一委派复用同一个标签。
   * `activate: false` 用于运行期的实时刷新（不抢用户正在看的标签）。
   */
  const openChildSession = useCallback((key: string, info: ChildSessionPanelInfo, options?: { activate?: boolean }) => {
    if (!key.trim()) return;
    dispatch({ type: "open-child-session", panel: createChildSessionPanel(key, info), ...(options?.activate === false ? { activate: false } : {}) });
  }, []);

  useEffect(() => {
    const offRestore = window.harness.browser.onRestoreToMain(({ instanceId, tabs }) => {
      const pages = tabs.filter((tab) => tab.url.trim());
      dispatch({
        type: "restore", id: instanceId,
        tabs: pages.length
          ? pages.map((page, index) => createBrowserPanel(index === 0 ? instanceId : createBrowserPanelId(), page))
          : [createBrowserPanel(instanceId)],
      });
    });
    const offClosed = window.harness.browser.onDetachedWindowClosed(({ instanceId }) => {
      dispatch({ type: "window-closed", id: instanceId });
    });
    const offPresentation = window.harness.browser.onAgentPresentation((event) => {
      if (event.action === "open") {
        dispatch({ type: "open-browser", tab: createBrowserPanel(event.instanceId, { url: event.url, title: "" }), activate: true });
      } else if (event.action === "select") {
        dispatch({ type: "select", id: event.instanceId });
      }
      // close 由登记该 guest 的 BrowserPanel 校验 tabId 后转交 closePanel。
    });
    return () => { offRestore(); offClosed(); offPresentation(); };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      const key = event.key.toLowerCase();
      const primary = event.metaKey || event.ctrlKey;
      if (primary && key === "p") {
        event.preventDefault();
        dispatch({ type: "open-files" });
      } else if (event.ctrlKey && key === "`") {
        event.preventDefault();
        dispatch({ type: "open-terminal" });
      } else if (event.metaKey && event.altKey && key === "s") {
        event.preventDefault();
        focusSideChat();
      } else if (event.ctrlKey && event.shiftKey && key === "g") {
        event.preventDefault();
        dispatch({ type: "open-review" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusSideChat]);

  return { ...state, dispatch, openPanel, openBrowser, openChildSession, openFile, openFiles, openSideChat, focusSideChat, closePanel, selectPanel };
}
