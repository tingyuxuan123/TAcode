import { useCallback, useEffect, useReducer } from "react";
import { createBrowserPanel, createBrowserPanelId, initialPanelState, panelReducer } from "./panel-state";

/** 主窗口统一管理网页标签；独立窗口仍由 BrowserPanel 管理内部标签。 */
export function useBrowserPanels() {
  const [state, dispatch] = useReducer(panelReducer, initialPanelState);
  const openBrowser = useCallback((url?: string, activate = true) => {
    dispatch({ type: "open-browser", tab: createBrowserPanel(createBrowserPanelId(), url ? { url, title: "" } : undefined), activate });
  }, []);
  const openPanel = useCallback((type: string) => {
    if (type === "inspect") dispatch({ type: "open-inspect" });
    else if (type === "browser") openBrowser();
  }, [openBrowser]);
  const closePanel = useCallback((id: string) => dispatch({ type: "close", id }), []);
  const selectPanel = useCallback((id: string) => dispatch({ type: "select", id }), []);

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

  return { ...state, dispatch, openPanel, openBrowser, closePanel, selectPanel };
}
