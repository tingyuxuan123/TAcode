import { useCallback, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, ClipboardCheck, FolderOpen, Globe, MessageCirclePlus, Pin, Plug, Sparkles, SquareTerminal, X } from "lucide-react";
import { ConfirmDialog, PanelPicker, PanelTabs } from "../ui";
import { useI18n } from "../i18n";
import type { PermissionMode, ProviderStatus } from "../../shared/types";
import type { ModelOption } from "../../shared/model-selection";
import { BrowserPanel } from "./browser-panel";
import { ChildSessionPanel } from "./child-session-panel";
import { FilePanel } from "./file-panel";
import { SideChatPanel } from "./side-chat-panel";
import { TerminalPanel } from "./terminal-panel";
import { browserPanelLabel, childSessionPanelLabel, filePanelLabel, isPanelVisible, visiblePanelTabs, type SideChatPanelTab } from "./panel-state";
import type { useBrowserPanels } from "./use-browser-panels";
import { SkillsPanel } from "../capabilities/skills-panel";
import { McpPanel } from "../capabilities/mcp-panel";
import "../capabilities/capabilities.css";
import { useFileEditing } from "../workbench/file-editing";
import { fileDocuments } from "../workbench/file-document-store";

/** 侧边聊天是声明式临时会话：关闭有破坏性确认，「不再询问」记在 localStorage。 */
const SIDE_CHAT_DONT_ASK_KEY = "sidechat:close-dont-ask";

const readSideChatDontAskClose = (): boolean => {
  try {
    return localStorage.getItem(SIDE_CHAT_DONT_ASK_KEY) === "1";
  } catch {
    return false;
  }
};

/** 侧边聊天实例共享的启动参数（cwd/模型/权限在首条消息时快照，模型/深度/权限可随后调整）。 */
export type SideChatPanelProps = {
  workspace?: string;
  provider?: ProviderStatus;
  model: string;
  modelKey: string;
  models: ModelOption[];
  effort: string;
  effortLevels: string[];
  permission: PermissionMode;
};

/** 网页与审查共用顶部标签栏，切换标签时所有网页保持挂载。 */
export function WorkbenchPanels({ panels, review, files, sideChatProps, onError, workspace, onUsePrompt, onOpenFile = panels.openFile }: {
  panels: ReturnType<typeof useBrowserPanels>;
  review: ReactNode;
  files: ReactNode;
  sideChatProps: SideChatPanelProps;
  onError(message: string): void;
  /** 文件标签读取内容用（过程区文件行打开的标签）。 */
  workspace?: string;
  onUsePrompt?(text: string): void;
  onOpenFile?(path: string, options?: { preview?: boolean; literal?: boolean }): void;
}) {
  const { t } = useI18n();
  const editing = useFileEditing();
  const { active, dispatch, openPanel, openBrowser, openSideChat, closePanel, selectPanel } = panels;
  // 标签栏只显示当前主会话上下文的标签（侧边聊天、子会话标签跟会话走）；其他会话的实例保持挂载（display:none），切回即原样恢复。
  const tabs = visiblePanelTabs(panels);
  const activeTab = tabs.find((tab) => tab.id === active);
  // 快捷键提示跟随平台样式；浏览器暂无快捷键，不显示提示。
  const isMac = window.harness.platform === "darwin";
  const shortcutHint = (mac: Parameters<typeof t>[0], other: Parameters<typeof t>[0]) => (isMac ? t(mac) : t(other));
  // Each panel owns its padding and scrolling, including the Git workbench.
  const flush = activeTab !== undefined;
  const [pendingSideChatClose, setPendingSideChatClose] = useState<SideChatPanelTab | null>(null);
  const [dontAskClose, setDontAskClose] = useState(false);
  const [dirtyCapabilities, setDirtyCapabilities] = useState<Record<string, boolean>>({});
  const [pendingCapabilityClose, setPendingCapabilityClose] = useState<string>();
  const skillsDirty = useCallback((dirty: boolean) => setDirtyCapabilities((current) => current.skills === dirty ? current : { ...current, skills: dirty }), []);
  const mcpDirty = useCallback((dirty: boolean) => setDirtyCapabilities((current) => current.mcp === dirty ? current : { ...current, mcp: dirty }), []);

  const requestClosePanel = (id: string) => {
    if (dirtyCapabilities[id]) { setPendingCapabilityClose(id); return; }
    const tab = tabs.find((item) => item.id === id);
    if (tab?.type === "file" && tab.workspace) {
      void editing.confirm(tab.workspace, [tab.path]).then((allow) => { if (allow) closePanel(id); }).catch((error) => onError(String(error)));
      return;
    }
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
          { id: "skills", label: t("panel.skills"), icon: <Sparkles size={18} strokeWidth={1.8} /> },
          { id: "mcp", label: t("panel.mcp"), icon: <Plug size={18} strokeWidth={1.8} /> },
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
          : tab.type === "skills"
            ? { id: tab.id, label: t("panel.skills"), icon: <Sparkles size={13} /> }
          : tab.type === "mcp"
            ? { id: tab.id, label: t("panel.mcp"), icon: <Plug size={13} /> }
          : tab.type === "terminal"
            ? { id: tab.id, label: t("panel.terminal") }
            : tab.type === "side-chat"
              ? { id: tab.id, label: t("panel.sideChatNumbered", { n: tab.ordinal }), title: tab.sourceSession ?? undefined }
        : tab.type === "child-session"
          ? { id: tab.id, label: childSessionPanelLabel(tab.info, t("delegate.detailChildSession"), t("subagent.awaitingInput")), title: tab.info.sessionPath ?? tab.info.task ?? "" }
          : tab.type === "file"
            ? { id: tab.id, label: filePanelLabel(tab.path), title: [tab.workspace, tab.path].filter(Boolean).join("/"), preview: Boolean(tab.preview), reorderable: true, dirty: Boolean(tab.workspace && fileDocuments().snapshot(tab.workspace, tab.path).dirty) }
            : { id: tab.id, label: browserPanelLabel(tab.page, t("browser.newTab")), title: [tab.page?.title, tab.page?.url].filter(Boolean).join("\n") })}
      active={active}
      onSelect={selectPanel}
      onCloseTab={requestClosePanel}
      onPinTab={(id) => dispatch({ type: "pin-file", id })}
      onReorder={(id, before, after) => dispatch({ type: "reorder", id, before, after })}
      tabCommands={(id) => {
        const index = tabs.findIndex((tab) => tab.id === id); const tab = tabs[index]; if (tab?.type !== "file") return [];
        return [
          ...(tab.preview ? [{ label: t("fileView.pin"), icon: <Pin size={14} />, run: () => dispatch({ type: "pin-file", id }) }] : []),
          { label: t("panel.closeTab"), icon: <X size={14} />, run: () => requestClosePanel(id) },
          { label: t("fileView.closeOthers"), icon: <X size={14} />, run: () => {
            const other = tabs.filter((item) => item.type === "file" && item.id !== id).map((item) => item.type === "file" ? item.path : "");
            void editing.confirm(tab.workspace, other).then((allow) => { if (allow) dispatch({ type: "close-other-files", id }); }).catch((error) => onError(String(error)));
          } },
          { label: t("fileView.moveLeft"), icon: <ArrowLeft size={14} />, disabled: index === 0, run: () => { if (tabs[index - 1]) dispatch({ type: "reorder", id, before: tabs[index - 1].id }); } },
          { label: t("fileView.moveRight"), icon: <ArrowRight size={14} />, disabled: index === tabs.length - 1, run: () => { if (tabs[index + 1]) dispatch({ type: "reorder", id, before: tabs[index + 1].id, after: true }); } },
        ];
      }}
      addItems={[
        ...(!tabs.some((tab) => tab.type === "skills") ? [{ type: "skills", label: t("panel.skills"), icon: <Sparkles size={15} strokeWidth={1.8} /> }] : []),
        ...(!tabs.some((tab) => tab.type === "mcp") ? [{ type: "mcp", label: t("panel.mcp"), icon: <Plug size={15} strokeWidth={1.8} /> }] : []),
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
      {tabs.filter((tab) => tab.type === "skills").map((tab) => (
        <div key={`${tab.id}:${workspace ?? "global"}`} className="panel-host" style={{ display: tab.id === active ? "flex" : "none" }}>
          <SkillsPanel workspace={workspace} onUsePrompt={onUsePrompt} onDirtyChange={skillsDirty} />
        </div>
      ))}
      {tabs.filter((tab) => tab.type === "mcp").map((tab) => (
        <div key={`${tab.id}:${workspace ?? "global"}`} className="panel-host" style={{ display: tab.id === active ? "flex" : "none" }}>
          <McpPanel workspace={workspace} onUsePrompt={onUsePrompt} onDirtyChange={mcpDirty} />
        </div>
      ))}
      {tabs.filter((tab) => tab.type === "terminal").map((tab) => (
        <div key={tab.id} className="panel-host" style={{ display: tab.id === active ? "flex" : "none" }}>
          <TerminalPanel key={tab.id} workspace={workspace} isActive={tab.id === active} />
        </div>
      ))}
      {panels.tabs.filter((tab) => tab.type === "side-chat").map((tab) => (
        <div key={tab.id} className="panel-host" style={{ display: tab.id === active && isPanelVisible(tab, panels.session) ? "flex" : "none" }}>
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
          <ChildSessionPanel info={tab.info} delegationId={tab.key} />
        </div>
      ))}
      {panels.tabs.filter((tab) => tab.type === "file").map((tab) => (
        <div key={tab.id} className="child-session-host" style={{ display: tab.id === active ? "flex" : "none" }}>
          <FilePanel path={tab.path} workspace={tab.workspace} scope={tab.scope} location={tab.location} reveal={tab.reveal} active={tab.id === active && isPanelVisible(tab, panels.session, panels.filesScope)} onOpen={onOpenFile} />
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
    {pendingCapabilityClose && <ConfirmDialog title={t("cap.discardTitle")} detail={t("cap.discardDetail")} confirmLabel={t("cap.discard")} cancelLabel={t("cap.keepEditing")}
      onCancel={() => setPendingCapabilityClose(undefined)} onConfirm={() => { closePanel(pendingCapabilityClose); setPendingCapabilityClose(undefined); }} />}
  </>;
}
