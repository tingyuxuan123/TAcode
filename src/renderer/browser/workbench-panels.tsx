import { useState, type ReactNode } from "react";
import { ClipboardCheck, FolderOpen, Globe, MessageCirclePlus, SquareTerminal } from "lucide-react";
import { ConfirmDialog, PanelPicker, PanelTabs } from "../ui";
import { useI18n } from "../i18n";
import type { PermissionMode, ProviderStatus } from "../../shared/types";
import { BrowserPanel } from "./browser-panel";
import { ChildSessionPanel } from "./child-session-panel";
import { FilePanel } from "./file-panel";
import { SideChatPanel } from "./side-chat-panel";
import { TerminalPanel } from "./terminal-panel";
import { browserPanelLabel, childSessionPanelLabel, filePanelLabel, isSideChatVisible, visiblePanelTabs, type SideChatPanelTab } from "./panel-state";
import type { useBrowserPanels } from "./use-browser-panels";

/** 侧边聊天是声明式临时会话：关闭有破坏性确认，「不再询问」记在 localStorage。 */
const SIDE_CHAT_DONT_ASK_KEY = "sidechat:close-dont-ask";

const readSideChatDontAskClose = (): boolean => {
  try {
    return localStorage.getItem(SIDE_CHAT_DONT_ASK_KEY) === "1";
  } catch {
    return false;
  }
};

/** 侧边聊天实例共享的启动参数（cwd/模型/权限等在首条消息时快照生效）。 */
export type SideChatPanelProps = {
  workspace?: string;
  provider?: ProviderStatus;
  model: string;
  effort: string;
  permission: PermissionMode;
};

/** 网页与审查共用顶部标签栏，切换标签时所有网页保持挂载。 */
export function WorkbenchPanels({ panels, review, files, sideChatProps, onError, workspace }: {
  panels: ReturnType<typeof useBrowserPanels>;
  review: ReactNode;
  files: ReactNode;
  sideChatProps: SideChatPanelProps;
  onError(message: string): void;
  /** 文件标签读取内容用（过程区文件行打开的标签）。 */
  workspace?: string;
}) {
  const { t } = useI18n();
  const { active, dispatch, openPanel, openBrowser, openSideChat, closePanel, selectPanel } = panels;
  // 标签栏只显示当前主会话的侧边聊天；其他会话的实例保持挂载（display:none），切回即原样恢复。
  const tabs = visiblePanelTabs(panels);
  const activeTab = tabs.find((tab) => tab.id === active);
  // 快捷键提示跟随平台样式；浏览器暂无快捷键，不显示提示。
  const isMac = window.harness.platform === "darwin";
  const shortcutHint = (mac: Parameters<typeof t>[0], other: Parameters<typeof t>[0]) => (isMac ? t(mac) : t(other));
  // 审查保留工作台内边距；其余面板自己管理滚动和内边距。
  const flush = activeTab !== undefined && activeTab.type !== "review";
  const [pendingSideChatClose, setPendingSideChatClose] = useState<SideChatPanelTab | null>(null);
  const [dontAskClose, setDontAskClose] = useState(false);

  const requestClosePanel = (id: string) => {
    const tab = tabs.find((item) => item.id === id);
    if (tab?.type === "side-chat" && !readSideChatDontAskClose()) {
      setDontAskClose(false);
      setPendingSideChatClose(tab);
      return;
    }
    closePanel(id);
  };

  const sideChatCloseDialog = pendingSideChatClose ? <ConfirmDialog
    title={t("panel.sideChatCloseTitle")}
    detail={t("panel.sideChatCloseDetail")}
    confirmLabel={t("panel.sideChatCloseConfirm")}
    cancelLabel={t("common.cancel")}
    dontAskLabel={t("common.dontAskAgain")}
    dontAsk={dontAskClose}
    onDontAskChange={setDontAskClose}
    onCancel={() => setPendingSideChatClose(null)}
    onConfirm={() => {
      if (dontAskClose) {
        try {
          localStorage.setItem(SIDE_CHAT_DONT_ASK_KEY, "1");
        } catch {
          // 无 localStorage（隐私模式等）时仅本次生效。
        }
      }
      const id = pendingSideChatClose.id;
      setPendingSideChatClose(null);
      closePanel(id);
    }}
  /> : null;

  if (tabs.length === 0) {
    return <>
      <PanelPicker
        title={t("picker.title")}
        subtitle={t("picker.subtitle")}
        items={[
          { id: "review", label: t("inspect.title"), icon: <ClipboardCheck size={18} strokeWidth={1.8} />, hint: shortcutHint("panel.shortcutReview.mac", "panel.shortcutReview.other") },
          { id: "files", label: t("panel.files"), icon: <FolderOpen size={18} strokeWidth={1.8} />, hint: shortcutHint("panel.shortcutFiles.mac", "panel.shortcutFiles.other") },
          { id: "terminal", label: t("panel.terminal"), icon: <SquareTerminal size={18} strokeWidth={1.8} />, hint: shortcutHint("panel.shortcutTerminal.mac", "panel.shortcutTerminal.other") },
          { id: "side-chat", label: t("panel.sideChat"), icon: <MessageCirclePlus size={18} strokeWidth={1.8} />, hint: shortcutHint("panel.shortcutSideChat.mac", "panel.shortcutSideChat.other") },
          { id: "browser", label: t("browser.tab"), icon: <Globe size={18} strokeWidth={1.8} /> },
        ]}
        onPick={openPanel}
      />
      {sideChatCloseDialog}
    </>;
  }
  return <>
    <PanelTabs
      tabs={tabs.map((tab) => tab.type === "review"
        ? { id: tab.id, label: t("inspect.title") }
        : tab.type === "files"
          ? { id: tab.id, label: t("panel.files") }
          : tab.type === "terminal"
            ? { id: tab.id, label: t("panel.terminal") }
            : tab.type === "side-chat"
              ? { id: tab.id, label: t("panel.sideChatNumbered", { n: tab.ordinal }), title: tab.sourceSession ?? undefined }
        : tab.type === "child-session"
          ? { id: tab.id, label: childSessionPanelLabel(tab.info, t("delegate.detailChildSession")), title: tab.info.sessionPath ?? tab.info.task ?? "" }
          : tab.type === "file"
            ? { id: tab.id, label: filePanelLabel(tab.path), title: tab.path }
            : { id: tab.id, label: browserPanelLabel(tab.page, t("browser.newTab")), title: [tab.page?.title, tab.page?.url].filter(Boolean).join("\n") })}
      active={active}
      onSelect={selectPanel}
      onCloseTab={requestClosePanel}
      addItems={[
        ...(!tabs.some((tab) => tab.type === "review")
          ? [{ type: "review", label: t("inspect.title"), icon: <ClipboardCheck size={15} strokeWidth={1.8} />, hint: shortcutHint("panel.shortcutReview.mac", "panel.shortcutReview.other") }]
          : []),
        ...(!tabs.some((tab) => tab.type === "files")
          ? [{ type: "files", label: t("panel.files"), icon: <FolderOpen size={15} strokeWidth={1.8} />, hint: shortcutHint("panel.shortcutFiles.mac", "panel.shortcutFiles.other") }]
          : []),
        ...(!tabs.some((tab) => tab.type === "terminal")
          ? [{ type: "terminal", label: t("panel.terminal"), icon: <SquareTerminal size={15} strokeWidth={1.8} />, hint: shortcutHint("panel.shortcutTerminal.mac", "panel.shortcutTerminal.other") }]
          : []),
        { type: "side-chat", label: t("panel.sideChatAdd"), icon: <MessageCirclePlus size={15} strokeWidth={1.8} />, hint: shortcutHint("panel.shortcutSideChat.mac", "panel.shortcutSideChat.other") },
        { type: "browser", label: t("browser.newTab"), icon: <Globe size={15} strokeWidth={1.8} /> },
      ]}
      onPickType={openPanel}
      flush={flush}
    >
      {tabs.filter((tab) => tab.type === "review").map((tab) => (
        <div key={tab.id} className="panel-host" style={{ display: tab.id === active ? "flex" : "none" }}>{review}</div>
      ))}
      {tabs.filter((tab) => tab.type === "files").map((tab) => (
        <div key={tab.id} className="panel-host" style={{ display: tab.id === active ? "flex" : "none" }}>{files}</div>
      ))}
      {tabs.filter((tab) => tab.type === "terminal").map((tab) => (
        <div key={tab.id} className="panel-host" style={{ display: tab.id === active ? "flex" : "none" }}>
          <TerminalPanel key={tab.id} workspace={workspace} isActive={tab.id === active} />
        </div>
      ))}
      {panels.tabs.filter((tab) => tab.type === "side-chat").map((tab) => (
        <div key={tab.id} className="panel-host" style={{ display: tab.id === active && isSideChatVisible(tab, panels.session) ? "flex" : "none" }}>
          <SideChatPanel
            key={tab.id}
            {...sideChatProps}
            ordinal={tab.ordinal}
            sourceSession={tab.sourceSession}
            draft={tab.draft}
            onRecreate={() => openSideChat()}
          />
        </div>
      ))}
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
    </PanelTabs>
    {sideChatCloseDialog}
  </>;
}
