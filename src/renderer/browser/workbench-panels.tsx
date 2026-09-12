import type { ReactNode } from "react";
import { FilePlus2, Globe } from "lucide-react";
import { PanelPicker, PanelTabs } from "../ui";
import { useI18n } from "../i18n";
import { BrowserPanel } from "./browser-panel";
import { ChildSessionPanel } from "./child-session-panel";
import { FilePanel } from "./file-panel";
import { browserPanelLabel, childSessionPanelLabel, filePanelLabel } from "./panel-state";
import type { useBrowserPanels } from "./use-browser-panels";

/** 网页与审查共用顶部标签栏，切换标签时所有网页保持挂载。 */
export function WorkbenchPanels({ panels, inspect, onError, workspace }: {
  panels: ReturnType<typeof useBrowserPanels>;
  inspect: ReactNode;
  onError(message: string): void;
  /** 文件标签读取内容用（过程区文件行打开的标签）。 */
  workspace?: string;
}) {
  const { t } = useI18n();
  const { tabs, active, dispatch, openPanel, openBrowser, closePanel, selectPanel } = panels;
  const activeTab = tabs.find((tab) => tab.id === active);
  // 网页与子代理面板走全出血（自己管滚动/内边距）；审查面板沿用带内边距的常规形态。
  const flush = activeTab !== undefined && activeTab.type !== "inspect";
  if (tabs.length === 0) {
    return <PanelPicker
      title={t("picker.title")}
      subtitle={t("picker.subtitle")}
      items={[
        { id: "inspect", label: t("inspect.title"), icon: <FilePlus2 size={18} strokeWidth={1.8} /> },
        { id: "browser", label: t("browser.tab"), icon: <Globe size={18} strokeWidth={1.8} /> },
      ]}
      onPick={openPanel}
    />;
  }
  return <PanelTabs
    tabs={tabs.map((tab) => tab.type === "inspect"
      ? { id: tab.id, label: t("inspect.title") }
      : tab.type === "child-session"
        ? { id: tab.id, label: childSessionPanelLabel(tab.info, t("delegate.detailChildSession")), title: tab.info.sessionPath ?? tab.info.task ?? "" }
        : tab.type === "file"
          ? { id: tab.id, label: filePanelLabel(tab.path), title: tab.path }
          : { id: tab.id, label: browserPanelLabel(tab.page, t("browser.newTab")), title: [tab.page?.title, tab.page?.url].filter(Boolean).join("\n") })}
    active={active}
    onSelect={selectPanel}
    onCloseTab={closePanel}
    addItems={[
      ...(!tabs.some((tab) => tab.type === "inspect")
        ? [{ type: "inspect", label: t("inspect.title"), icon: <FilePlus2 size={15} strokeWidth={1.8} /> }]
        : []),
      { type: "browser", label: t("browser.newTab"), icon: <Globe size={15} strokeWidth={1.8} /> },
    ]}
    onPickType={openPanel}
    flush={flush}
  >
    {activeTab?.type === "inspect" ? inspect : null}
    {tabs.filter((tab) => tab.type === "child-session").map((tab) => (
      <div key={tab.id} className="child-session-host" style={{ display: tab.id === active ? "flex" : "none" }}>
        <ChildSessionPanel info={tab.info} isActive={tab.id === active} />
      </div>
    ))}
    {tabs.filter((tab) => tab.type === "file").map((tab) => (
      <div key={tab.id} className="child-session-host" style={{ display: tab.id === active ? "flex" : "none" }}>
        <FilePanel path={tab.path} workspace={workspace} />
      </div>
    ))}
    {tabs.filter((tab) => tab.type === "browser").map((tab) => (
      <div key={tab.id} data-browser-instance={tab.id} style={{ display: tab.id === active ? "flex" : "none", flex: 1, minWidth: 0, minHeight: 0 }}>
        {tab.detached ? (
          <div className="browser-detached-notice">{t("browser.detachedNotice")}</div>
        ) : (
          <BrowserPanel
            key={`${tab.id}:${tab.revision}`}
            instanceId={tab.id}
            initialUrl=""
            isActive={tab.id === active}
            initialTabs={tab.initialTabs}
            onOpenTab={openBrowser}
            onClose={() => closePanel(tab.id)}
            onTabsChange={(pages) => {
              if (pages[0]) dispatch({ type: "page", id: tab.id, page: pages[0] });
            }}
            onOpenDetached={(url, pages) => {
              void window.harness.browser.openDetachedWindow(tab.id, url, pages).then(() => {
                dispatch({ type: "detach", id: tab.id, page: pages[0] ?? { url, title: "" } });
              }).catch((error) => onError(String(error)));
            }}
          />
        )}
      </div>
    ))}
  </PanelTabs>;
}
