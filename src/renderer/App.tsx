import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AgentSessionStats,
  AgentSnapshot,
  ExtensionUiRequest,
  PermissionMode,
  ProviderStatus,
  SessionSummary,
  WorkspaceItem,
} from "../shared/types";
import type { AgentSkillCommand } from "../shared/skills";
import { parseSkillCommands, skillSlashCommand } from "../shared/skills";
import {
  DEFAULT_EFFORT,
  levelsForModel,
  normalizeEffort,
  readStoredEffort,
  writeStoredEffort,
} from "../shared/thinking";
import { modelSupportsVision, toPromptImages, visionAgentPrompt } from "../shared/vision-api";
import {
  applyAgentEvent,
  baseName,
  collectTodos,
  collectWorkingFiles,
  dropLastTurn,
  finalizeInterruptedTurn,
  settleStoppedTurn,
  failActiveTurn,
  friendlyAgentError,
  isTransientStreamError,
  assistantErrorRecovered,
  assistantGroupHasRecoverableError,
  assistantGroupSucceeded,
  assistantReplyText,
  collectProgressTasks,
  groupConversation,
  recoverableFailStreaks,
  lastTurnRestoreFiles,
  mentionedFiles,
  normalizeMessages,
  optimisticUserMessage,
  parseFeaturesJson,
  planAwaitingApproval,
  sessionTools,
  sessionTerminals,
  turnAnchorId,
  turnAnchors,
  upsertSessionSummary,
  type ChatMessage,
  type FileChange,
  type RestoreFile,
  type SessionTodo,
} from "./conversation";
import {
  ApprovalCard,
  AssistantTurn,
  Chat,
  Dots,
  FileDrawer,
  Icon,
  InspectPanel,
  Login,
  PromptBar,
  SidebarNav,
  Thinking,
  TurnNav,
  UserTurn,
} from "./ui";
import { MessageList, type MessageListHandle, type MessageListItem } from "./message-list";
import { WorkbenchPanels } from "./browser/workbench-panels";
import { useBrowserPanels } from "./browser/use-browser-panels";
import { useDelegationTabs } from "./browser/use-delegation-tabs";
import { useSidebarLayout } from "./sidebar-layout";
import { branchAutoExpanded, groupDelegatedSessions } from "./session-tree";
import { ProgressOverlay } from "./progress-overlay";
import { PanelActionsProvider } from "./panel-actions";
import { delegationPanelKey } from "./browser/panel-state";
import { createStreamScheduler } from "./stream-scheduler";
import { useFollowScroll } from "./use-follow-scroll";
import logo from "./logo.svg";
import { useI18n } from "./i18n";
import { PreviewContext } from "./file-path-chip";
import { composerModelOptions, modelOptionKey } from "../shared/model-selection";
import type { MessageKey } from "../shared/i18n";

const PERMISSIONS: PermissionMode[] = ["plan", "ask", "auto", "full"];

function relativeTime(iso: string, t: (key: MessageKey, vars?: Record<string, string | number>) => string) {
  const delta = Date.now() - Date.parse(iso);
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return t("common.justNow");
  if (minutes < 60) return t("common.minutesAgo", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("common.hoursAgo", { n: hours });
  const days = Math.round(hours / 24);
  if (days === 1) return t("common.yesterday");
  if (days < 7) return t("common.daysAgo", { n: days });
  return new Date(iso).toLocaleDateString();
}

function sessionFileOf(snapshot: AgentSnapshot): string | undefined {
  if (typeof snapshot.stats?.sessionFile === "string") return snapshot.stats.sessionFile;
  if (typeof snapshot.state.sessionFile === "string") return snapshot.state.sessionFile;
  return undefined;
}

function sessionIdOf(snapshot: AgentSnapshot): string | undefined {
  if (typeof snapshot.state.sessionId === "string") return snapshot.state.sessionId;
  return undefined;
}

function isSameSession(session: SessionSummary, active?: string) {
  return Boolean(active && (session.path === active || session.storagePath === active));
}

const PIN_ICON =
  "M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z";
const PENCIL_ICON = "M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5zM15 5l4 4";
const TRASH_ICON = "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6";
/** Real filled dots: zero-length stroked segments render as thin nubs, not circles. */
function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="6" r="1.85" />
      <circle cx="12" cy="12" r="1.85" />
      <circle cx="12" cy="18" r="1.85" />
    </svg>
  );
}

export function SessionRow({
  session,
  active,
  running,
  childCount,
  branchExpanded,
  onToggleBranch,
  onOpen,
  onOpenInMain,
  onPin,
  onRename,
  onRemove,
}: {
  session: SessionSummary;
  active: boolean;
  running: boolean;
  /** 委派子会话数量；> 0 时显示分支展开开关。 */
  childCount?: number;
  branchExpanded?: boolean;
  onToggleBranch?(): void;
  onOpen(): void;
  /** 委派子会话专用：在中间主会话区打开（默认改为在右侧面板开只读标签）。 */
  onOpenInMain?(): void;
  onPin(): void;
  onRename(title: string): void;
  onRemove(): void;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const openMenu = (x: number, y: number) => {
    setMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - 190)),
      y: Math.max(8, Math.min(y, window.innerHeight - 154)),
    });
  };
  const action = (callback: () => void) => {
    setMenu(undefined);
    callback();
  };

  const delegationRunning = session.delegationStatus === "pending" || session.delegationStatus === "running";
  const sessionIsRunning = running || delegationRunning;

  return (
    <div
      className={["session-item", session.sourceDelegationId && "delegated-session", active && "active", menu && "menu-open"].filter(Boolean).join(" ")}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY);
      }}
    >
      {editing ? (
        <input
          className="session-rename"
          defaultValue={session.title}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => {
            const next = event.currentTarget.value.trim();
            setEditing(false);
            if (next && next !== session.title) onRename(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = session.title;
              event.currentTarget.blur();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="session-row"
          title={session.sourceDelegationId ? `${session.delegationRole ?? "subagent"}: ${session.title || t("common.unnamed")}` : session.title || t("common.unnamed")}
          aria-label={session.sourceDelegationId ? `${session.delegationRole ?? "subagent"}: ${session.title || t("common.unnamed")}` : session.title || t("common.unnamed")}
          aria-current={active ? "page" : undefined}
          onClick={onOpen}
        >
          {session.pinned && <Icon path={PIN_ICON} size={12} />}
          {sessionIsRunning && (
            <span className="session-running" title={t("nav.sessionRunning")} aria-label={t("nav.sessionRunning")}></span>
          )}
          {session.sourceDelegationId && !sessionIsRunning && <Icon path="M4 5h16v14H4zM8 9h8M8 13h5" size={12} />}
          <span className="sidebar-full-label">{session.sourceDelegationId ? `${session.delegationRole ?? "subagent"} · ` : ""}{session.title || t("common.unnamed")}</span>
          <span className="sidebar-short-label" aria-hidden="true">{Array.from(session.title.trim() || t("common.unnamed")).slice(0, 2).join("")}</span>
        </button>
      )}
      {childCount ? (
        <button
          type="button"
          className="session-branch-toggle"
          aria-label={t("nav.delegatedSessions")}
          title={t("nav.delegatedSessions")}
          aria-expanded={Boolean(branchExpanded)}
          onClick={(event) => {
            event.stopPropagation();
            onToggleBranch?.();
          }}
        >
          <Icon className="chevron" path="M9 6l6 6-6 6" size={12} />
        </button>
      ) : null}
      <button
        type="button"
        className="session-del session-more"
        aria-label={t("nav.sessionMenu")}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          openMenu(rect.right + 4, rect.top);
        }}
      >
        <MoreIcon />
      </button>
      {menu && createPortal(
        <div
          className="session-menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => action(onPin)}>
            <Icon path={PIN_ICON} size={16} />
            <span>{session.pinned ? t("common.unpin") : t("common.pin")}</span>
          </button>
          {onOpenInMain && (
            <button type="button" role="menuitem" onClick={() => action(onOpenInMain)}>
              <Icon path="M4 6h16v12H4zM9 10l3 3 3-3" size={16} />
              <span>{t("nav.openDelegatedInMain")}</span>
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => action(() => setEditing(true))}>
            <Icon path={PENCIL_ICON} size={16} />
            <span>{t("common.rename")}</span>
          </button>
          <div className="session-menu-separator" />
          <button type="button" role="menuitem" className="danger" onClick={() => action(onRemove)}>
            <Icon path={TRASH_ICON} size={16} />
            <span>{t("common.remove")}</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

const SANDBOX_OK_KEY = "harness:unsandboxed-projects";
/** 「停止中」的 UI 上限：超过它就把按钮还原成可再次点击，收尾仍等 agent_settled。 */
const STOP_UI_TIMEOUT_MS = 10_000;

function allowedProjects(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(SANDBOX_OK_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

/** Windows/Linux have no Seatbelt; workspace-write cannot run commands without Docker. */
function rememberUnsandboxed(cwd: string): void {
  const remembered = allowedProjects();
  if (remembered.has(cwd)) return;
  localStorage.setItem(SANDBOX_OK_KEY, JSON.stringify([...remembered, cwd]));
}

export function AccountMenu({
  model,
  configured,
  onOpenSettings,
}: {
  model: string;
  configured: boolean;
  onOpenSettings(): void;
}) {
  const { t, locale, setLocale } = useI18n();
  const [menu, setMenu] = useState<{ left: number; bottom: number }>();
  const [langOpen, setLangOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => {
      setMenu(undefined);
      setLangOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const open = () => {
    const node = root.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setLangOpen(false);
    setMenu({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 220)),
      bottom: Math.max(8, window.innerHeight - rect.top + 6),
    });
  };

  return (
    <div ref={root} className={menu ? "account-wrap open" : "account-wrap"}>
      <button type="button" className="account" title={t("nav.settingsTitle")} aria-label={t("nav.settingsTitle")} onClick={open}>
        <div className="account-icon">
          <Icon path="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H2.8a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.2 8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4V3.8a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z" size={15} />
        </div>
        <div className="account-meta">
          <strong>{configured ? model : t("nav.modelUnset")}</strong>
          <small>{configured ? t("nav.manageKeys") : t("nav.configureKeys")}</small>
        </div>
      </button>
      {menu && createPortal(
        <div
          className="account-menu"
          style={{ left: menu.left, bottom: menu.bottom }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setMenu(undefined);
              onOpenSettings();
            }}
          >
            <Icon path="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15H2.8a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.2 8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4V3.8a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z" size={15} />
            <span>{t("menu.settings")}</span>
          </button>
          <div
            className={langOpen ? "account-menu-item has-sub open" : "account-menu-item has-sub"}
            onMouseEnter={() => setLangOpen(true)}
            onMouseLeave={() => setLangOpen(false)}
          >
            <button type="button" className={langOpen ? "on" : ""} onClick={() => setLangOpen((open) => !open)}>
              <Icon path="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" size={15} />
              <span>{t("menu.language")}</span>
              <Icon className="account-chevron" path="M9 18l6-6-6-6" size={14} />
            </button>
            {langOpen && (
              <div className="account-submenu">
                <button
                  type="button"
                  onClick={() => {
                    void setLocale("zh");
                    setMenu(undefined);
                    setLangOpen(false);
                  }}
                >
                  <span>{t("menu.langZh")}</span>
                  {locale === "zh" && <Icon className="account-check" path="M20 6L9 17l-5-5" size={15} />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void setLocale("en");
                    setMenu(undefined);
                    setLangOpen(false);
                  }}
                >
                  <span>{t("menu.langEn")}</span>
                  {locale === "en" && <Icon className="account-check" path="M20 6L9 17l-5-5" size={15} />}
                </button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function activeChatProvider(accounts: ProviderStatus[]) {
  return accounts.find((item) => item.serviceId && item.preferred) ?? accounts.find((item) => item.id === "deepseek");
}

export function App() {
  const { t, locale } = useI18n();
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  // Phase 1：保留"运行中/未落盘"会话的展示标题。底层在首条 assistant 落盘前不写
  // JSONL，主进程 `sessions:list` 会合成一条占位（标题为 cwd 兜底）；这里用首次消息
  // 标题覆写，使新会话在切走/刷新后仍显示用户真正输入的标题，而非 cwd 名。
  const sessionTitlesRef = useRef<Map<string, string>>(new Map());
  const sessionsRefMirror = useRef<SessionSummary[]>([]);
  sessionsRefMirror.current = sessions;
  const eventSessionTitle = (sessionId: string | undefined): string => {
    if (!sessionId) return "";
    const row = sessionsRefMirror.current.find(
      (item) => item.path === sessionId || item.storagePath === sessionId,
    );
    return row?.title ?? sessionTitlesRef.current.get(sessionId) ?? "";
  };
  const setSessionList = useCallback((threads: SessionSummary[]) => {
    const titles = sessionTitlesRef.current;
    setSessions(
      threads.map((row) => {
        const title = titles.get(row.path);
        return title && title !== row.title ? { ...row, title } : row;
      }),
    );
  }, []);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const runtimeProviderRef = useRef<ProviderStatus["id"]>("deepseek");
  const runtimeServiceRef = useRef("");
  const [workspace, setWorkspace] = useState<string>();
  const [activeSession, setActiveSession] = useState<string>();
  const [model, setModel] = useState("");
  const [modelSwitchPending, setModelSwitchPending] = useState(false);
  const modelSwitchBusy = useRef(false);
  const [chatModels, setChatModels] = useState<string[]>([]);
  const [effort, setEffort] = useState(readStoredEffort);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>(["low", "medium", "high", "max"]);
  const [permission, setPermission] = useState<PermissionMode>("auto");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [stats, setStats] = useState<AgentSessionStats>();
  const [promptFill, setPromptFill] = useState({ text: "", token: 0 });
  const fillPrompt = useCallback((text: string) => {
    setPromptFill((current) => ({ text, token: current.token + 1 }));
  }, []);
  const [steering, setSteering] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  // Phase 3b：每个会话的运行状态（含后台会话），供侧边栏徽标与后台完成提示。
  const runningSessionIdsRef = useRef<Set<string>>(new Set());
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(new Set());
  /** 委派子会话分支的手动开合覆盖（未设置时按“父活跃或子运行中”自动展开）。 */
  const [railOpen, setRailOpen] = useState<Record<string, boolean>>({});
  const markSessionRunning = useCallback((sessionId: string | undefined, isRunning: boolean) => {
    if (!sessionId) return;
    setRunningSessionIds((current) => {
      const next = new Set(current);
      if (isRunning) next.add(sessionId);
      else next.delete(sessionId);
      runningSessionIdsRef.current = next;
      return next;
    });
  }, []);
  const [stopping, setStopping] = useState(false);
  const [transcriptKey, setTranscriptKey] = useState("empty");
  const eventQueue = useRef<ReturnType<typeof createStreamScheduler> | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [sandboxAsk, setSandboxAsk] = useState<{ cwd: string; message: string }>();
  const sandboxWaiter = useRef<((ok: boolean) => void) | undefined>(undefined);
  const [toast, setToast] = useState<string>();
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(undefined), 5000);
    return () => window.clearTimeout(id);
  }, [toast]);
  const [uiRequest, setUiRequest] = useState<ExtensionUiRequest>();
  const [fullscreen, setFullscreen] = useState(false);
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<FileChange>();
  const browserPanels = useBrowserPanels();
  // 供深链组件（委派卡片）打开子代理标签：卡片在 ui.tsx 的模块级 renderTool 里渲染，拿不到这里的 props。
  const panelActions = useMemo(
    () => ({ openChildSession: browserPanels.openChildSession }),
    [browserPanels.openChildSession],
  );
  const sidebarLayout = useSidebarLayout();
  // 父代理创建子代理时自动开右侧标签（对齐 Proma 的 delegation 面板），并实时刷新状态。
  useDelegationTabs(messages, browserPanels);

  // 主进程是旧构建（本地重建过但没完全重启）时提示一次：否则会出现「worker 已是新代码、
  // 主进程还是旧定义」这类很难自查的现象。
  useEffect(() => {
    let gone = false;
    void window.harness.app.buildStatus().then((status) => {
      if (!gone && status.restartRequired) setToast(t("toast.restartRequired"));
    }).catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [t]);
  const [featureTodos, setFeatureTodos] = useState<SessionTodo[]>([]);
  const [agentSkills, setAgentSkills] = useState<AgentSkillCommand[]>([]);
  const [stoppedJobs, setStoppedJobs] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const messageList = useRef<MessageListHandle>(null);
  const agentCwd = useRef<string | undefined>(undefined);
  const sessionRef = useRef<string | undefined>(undefined);
  const sending = useRef(false);
  const dock = useRef<HTMLDivElement>(null);
  const live = useRef(false);
  const pendingUndo = useRef<{ files: RestoreFile[] } | undefined>(
    undefined,
  );
  const modelRef = useRef(model);
  modelRef.current = model;
  const chatModelsRef = useRef(chatModels);
  chatModelsRef.current = chatModels;
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const agentModelIdsRef = useRef<string[]>([]);
  const agentModelsRef = useRef<AgentSnapshot["models"]>([]);
  const startSeq = useRef(0);
  const runEpoch = useRef(0);
  const permissionBeforePlan = useRef<Exclude<PermissionMode, "plan">>("auto");
  /** 当前视图对应的 Agent 运行句柄；用于补齐 snapshot 缺口事件。 */
  const runtimeIdRef = useRef<string | undefined>(undefined);
  /** 每个会话已应用到的最高事件序号，用于丢弃 snapshot 回放与实时流的重复事件。 */
  const eventSeqRef = useRef<Map<string, number>>(new Map());
  /** 宿主已停止或重启失败：清掉陈旧的会话引用，避免后续命令打到已不存在的会话。 */
  const dropAgentSession = useCallback(() => {
    live.current = false;
    agentCwd.current = undefined;
    runtimeIdRef.current = undefined;
    runtimeServiceRef.current = "";
  }, []);

  const applyThinkingForModel = useCallback((modelId: string, accounts = providers) => {
    const chat = activeChatProvider(accounts);
    const levels = levelsForModel(modelId, chat?.modelCapabilities ?? agentModelsRef.current);
    setThinkingLevels(levels);
    const next = normalizeEffort(effortRef.current, levels);
    effortRef.current = next;
    setEffort(next);
    writeStoredEffort(next);
  }, [providers]);

  const syncAgentThinking = useCallback(async () => {
    if (!agentCwd.current || modelSwitchBusy.current) return;
    const seq = startSeq.current;
    const currentService = activeChatProvider(providersRef.current);
    if (`${currentService?.serviceId ?? ""}:${currentService?.serviceVersion ?? ""}` !== runtimeServiceRef.current) return;
    const requestedModel = modelRef.current;
    const requestedEffort = effortRef.current;
    try {
      const [levelsResp, stateResp] = await Promise.all([
        window.harness.agent.command<{ levels: string[] }>("get_available_thinking_levels"),
        window.harness.agent.command<{ thinkingLevel?: string; model?: { id?: string } }>("get_state"),
      ]);
      const latestService = activeChatProvider(providersRef.current);
      if (latestService?.serviceId !== currentService?.serviceId || latestService?.serviceVersion !== currentService?.serviceVersion) return;
      if (modelSwitchBusy.current || seq !== startSeq.current || requestedModel !== modelRef.current || requestedEffort !== effortRef.current) return;
      if (stateResp?.model?.id && stateResp.model.id !== requestedModel) return;
      const levels = Array.isArray(levelsResp?.levels) ? levelsResp.levels : ["off"];
      setThinkingLevels(levels);
      const activeLevel = typeof stateResp?.thinkingLevel === "string"
        ? stateResp.thinkingLevel
        : effortRef.current;
      const next = normalizeEffort(activeLevel, levels);
      effortRef.current = next;
      setEffort(next);
      writeStoredEffort(next);
      if (typeof stateResp?.model?.id === "string" && stateResp.model.id) {
        setModel(stateResp.model.id);
        modelRef.current = stateResp.model.id;
      }
      await window.harness.agent.command("set_thinking_level", { level: next }).catch(() => undefined);
    } catch {
      // Agent may not be ready yet.
    }
  }, []);

  const applyEffort = useCallback((next: string) => {
    effortRef.current = next;
    setEffort(next);
    writeStoredEffort(next);
    const currentService = activeChatProvider(providersRef.current);
    if (!agentCwd.current || `${currentService?.serviceId ?? ""}:${currentService?.serviceVersion ?? ""}` !== runtimeServiceRef.current) return;
    void window.harness.agent.command("set_thinking_level", { level: next }).catch(() => undefined);
  }, []);

  const groupCache = useRef<ReturnType<typeof groupConversation>>([]);
  const groups = useMemo(() => {
    const next = groupConversation(messages, groupCache.current);
    groupCache.current = next;
    return next;
  }, [messages]);
  const follow = useFollowScroll(`${workspace ?? ""}:${transcriptKey}`, !loading);
  const setScroller = useCallback((node: HTMLDivElement | null) => {
    scroller.current = node;
    follow.viewportRef(node);
  }, [follow.viewportRef]);
  const canAutoCollapse = useCallback(() => follow.following.current, [follow.following]);
  const recoverableStreaks = useMemo(() => recoverableFailStreaks(groups), [groups]);
  const anchors = useMemo(() => turnAnchors(groups), [groups]);
  const tools = useMemo(() => sessionTools(messages), [messages]);
  const terminals = useMemo(
    () => sessionTerminals(messages).filter((job) => !stoppedJobs.includes(job.id)),
    [messages, stoppedJobs],
  );
  const workingFiles = useMemo(() => collectWorkingFiles(tools, mentionedFiles(messages)), [messages, tools]);
  const chatTodos = useMemo(() => collectTodos(messages, tools), [messages, tools]);
  const todos = chatTodos.length ? chatTodos : featureTodos;
  const progressTasks = useMemo(() => collectProgressTasks(messages, tools), [messages, tools]);
  const planApproval = planAwaitingApproval(permission, running, todos);
  const darwin = window.harness.platform === "darwin";
  const connected = activeChatProvider(providers);
  const modelOptions = useMemo(() => composerModelOptions(providers, model, chatModels), [providers, model, chatModels]);
  const waiting = running && (groups.length === 0 || groups.at(-1)?.type === "user");
  const suggestions = workspace
    ? [
        { label: t("suggest.explainRepo"), hint: t("suggest.hintStructure") },
        { label: t("suggest.findRiskiest"), hint: t("suggest.hintRiskFirst") },
        { label: t("suggest.addTests"), hint: t("suggest.hintCoverage") },
        { label: t("suggest.taskList"), hint: t("suggest.hintFeatures") },
      ]
    : [
        { label: t("suggest.openProject"), icon: "M3 7h6l2 2h10v10H3z", action: "open" as const },
        { label: t("suggest.explainArch"), hint: t("suggest.hintStructure") },
        { label: t("suggest.findBugs"), hint: t("suggest.hintRisk") },
        { label: t("suggest.writeTests"), hint: t("suggest.hintCoverage") },
      ];

  const projects = useMemo(() => {
    const byPath = new Map<string, { item: WorkspaceItem; sessions: SessionSummary[] }>();
    for (const item of workspaces) byPath.set(item.path, { item, sessions: [] });
    for (const session of sessions) {
      byPath.get(session.cwd)?.sessions.push(session);
    }
    return [...byPath.values()];
  }, [sessions, workspaces]);

  const refreshAgentSkills = useCallback(async () => {
    const loadDisk = () => window.harness.app.listSkills().catch(() => [] as AgentSkillCommand[]);
    if (!agentCwd.current) {
      setAgentSkills(await loadDisk());
      return;
    }
    try {
      const data = await window.harness.agent.command<{
        commands: Array<{
          name: string;
          description?: string;
          source?: string;
          sourceInfo?: { path?: string; baseDir?: string };
        }>;
      }>("get_commands");
      const fromAgent = parseSkillCommands(data.commands);
      if (fromAgent.length) {
        setAgentSkills(fromAgent);
        return;
      }
      setAgentSkills(await loadDisk());
    } catch {
      setAgentSkills(await loadDisk());
    }
  }, []);

  const refresh = useCallback(async () => {
    const [recent, status, threads] = await Promise.all([
      window.harness.workspace.recent(),
      window.harness.auth.status(),
      window.harness.sessions.list(),
    ]);
    setWorkspaces(recent);
    setProviders(status);
    setSessionList(threads);
    return status;
  }, []);

  const resolveSandbox = useCallback(async (asProject: boolean, mode: PermissionMode, cwd?: string) => {
    if (!asProject) return "read-only" as const;
    if (mode === "full") return "danger-full-access" as const;
    if (window.harness.platform === "darwin" || !cwd) return "workspace-write" as const;
    if (allowedProjects().has(cwd)) return "danger-full-access" as const;
    const ok = await new Promise<boolean>((resolve) => {
      sandboxWaiter.current = resolve;
      setSandboxAsk({ cwd, message: t("confirm.unsandboxed", { cwd }) });
    });
    setSandboxAsk(undefined);
    sandboxWaiter.current = undefined;
    if (ok) rememberUnsandboxed(cwd);
    return ok ? "danger-full-access" as const : "workspace-write" as const;
  }, [t]);

  const startAgent = useCallback(async (
    cwd?: string,
    sessionPath?: string,
    asProject = false,
    resume = false,
    mode = permission,
    seedMessage?: ChatMessage,
    storagePath?: string,
  ) => {
    const seq = ++startSeq.current;
    eventQueue.current?.clear();
    // 重新加载快照后事件序号重新对账：丢弃的记录由 replay 补齐。
    eventSeqRef.current.clear();
    live.current = false;
    setStopping(false);
    setTranscriptKey(sessionPath ?? seedMessage?.id ?? `session-${seq}`);
    setLoading(true);
    setUiRequest(undefined);
    let accounts: ProviderStatus[];
    try {
      accounts = await window.harness.auth.status();
    } catch (error) {
      setToast(friendlyAgentError(error));
      setLoading(false);
      return false;
    }
    if (seq !== startSeq.current) return false;
    setProviders(accounts);
    const chat = activeChatProvider(accounts);
    if (!chat?.configured) {
      setLoginOpen(true);
      setToast(t("toast.fillConfig"));
      setLoading(false);
      return false;
    }
    if (!seedMessage && !resume) {
      setSteering([]);
      // Opening a thread: clear the pane so we don't keep showing the welcome/home shell.
      if (sessionPath) {
        setMessages([]);
        setActiveSession(sessionPath);
        sessionRef.current = sessionPath;
      }
    }
    const requestedModel = modelRef.current.trim();
    const modelId = chat.serviceId && !chat.models?.includes(requestedModel) ? chat.defaultModel : requestedModel || chat.defaultModel;
    const extraModels = [...new Set([modelId, ...chatModelsRef.current].filter(Boolean))];
    if (!resume) {
      if (cwd) {
        setWorkspace(cwd);
        setOpenProjects((current) => ({ ...current, [cwd]: true }));
      } else {
        setWorkspace(undefined);
      }
    }
    const sandbox = await resolveSandbox(asProject, mode, cwd);
    if (seq !== startSeq.current) return false;
    if (asProject && sandbox !== "danger-full-access" && window.harness.platform !== "darwin") {
      setLoading(false);
      setToast(t("toast.sandboxCancelled"));
      return false;
    }
    try {
      const snapshot = await window.harness.agent.start({
        ...(cwd ? { cwd } : {}),
        project: asProject,
        provider: chat.id,
        ...(chat.serviceId ? { serviceId: chat.serviceId } : {}),
        ...(modelId ? { model: modelId } : {}),
        ...(chat.baseUrl ? { baseUrl: chat.baseUrl } : {}),
        effort: effortRef.current || DEFAULT_EFFORT,
        permission: mode,
        sandbox,
        ...(mode === "auto" || mode === "full" ? { network: true } : {}),
        ...(sessionPath ? { sessionPath } : {}),
        ...(storagePath ? { storagePath } : {}),
        ...(resume ? { resume: true } : {}),
        ...(extraModels.length ? { extraModels } : {}),
      });
      if (seq !== startSeq.current) return false;
      runtimeIdRef.current = snapshot.runtimeId;
      const file = sessionFileOf(snapshot) ?? sessionPath;
      if (file) sessionRef.current = file;
      // snapshot 与实时事件流之间可能漏事件：先套快照，再按序号补齐缓冲事件。
      const replay = snapshot.replay ?? [];
      const replaySeq = replay.reduce(
        (highest, event) =>
          typeof event.__seq === "number" ? Math.max(highest, event.__seq) : highest,
        typeof snapshot.lastSeq === "number" ? snapshot.lastSeq : 0,
      );
      const withReplay = (input: ChatMessage[]): ChatMessage[] =>
        replay.reduce((current, event) => applyAgentEvent(current, event), input);
      if (seedMessage) {
        setMessages(withReplay([...normalizeMessages(snapshot.messages), seedMessage]));
        setStats(snapshot.stats);
        setAgentSkills(snapshot.skills ?? []);
        setRunning(true);
      } else {
        const raw = normalizeMessages(snapshot.messages);
        const hadRunning = Boolean(raw.at(-1)?.tools.some((tool) => tool.status === "running"));
        const next = withReplay(resume ? finalizeInterruptedTurn(raw) : raw);
        setMessages(next);
        setStats(snapshot.stats);
        // Phase 3b：切回正在后台运行的会话时，以运行集合为准（比 isStreaming 启发式准）。
        const inBackgroundSet = file
          ? runningSessionIdsRef.current.has(file)
          : false;
        setRunning(inBackgroundSet || (Boolean(snapshot.state.isStreaming) && !hadRunning));
        setAgentSkills(snapshot.skills ?? []);
        if (resume && hadRunning) setToast(t("toast.sessionInterrupted"));
        if (sessionPath && next.length === 0) {
          setToast(t("toast.sessionEmpty"));
        }
      }
      if (file) eventSeqRef.current.set(file, replaySeq);
      live.current = true;
      // 快照生成到 renderer 进入 live 之间仍可能丢事件：再补一次，按序号去重。
      if (file) {
        void window.harness.agent
          .replay(snapshot.runtimeId, eventSeqRef.current.get(file) ?? replaySeq)
          .then((missed) => {
            if (seq !== startSeq.current || !live.current || !missed.length) return;
            const before = eventSeqRef.current.get(file) ?? replaySeq;
            const fresh = missed.filter(
              (event) => typeof event.__seq === "number" && event.__seq > before,
            );
            if (!fresh.length) return;
            setMessages((current) =>
              fresh.reduce((next, event) => applyAgentEvent(next, event), current),
            );
            eventSeqRef.current.set(
              file,
              fresh.reduce(
                (top, event) =>
                  typeof event.__seq === "number" ? Math.max(top, event.__seq) : top,
                before,
              ),
            );
          })
          .catch(() => undefined);
      }
      runtimeProviderRef.current = chat.id;
      runtimeServiceRef.current = `${chat.serviceId ?? ""}:${chat.serviceVersion ?? ""}`;
      agentCwd.current = snapshot.cwd ?? cwd ?? agentCwd.current;
      agentModelsRef.current = snapshot.models ?? [];
      agentModelIdsRef.current = agentModelsRef.current.map((item) => item.id).filter(Boolean);
      if (modelId) {
        modelRef.current = modelId;
        setModel(modelId);
        await window.harness.agent.command("set_model", { provider: chat.id, modelId });
      }
      applyThinkingForModel(modelId, accounts);
      const nextEffort = effortRef.current;
      await window.harness.agent.command("set_thinking_level", { level: nextEffort }).catch(() => undefined);
      await syncAgentThinking();
      await window.harness.agent.command("set_auto_compaction", { enabled: true }).catch(() => undefined);
      if (seq !== startSeq.current) return false;
      if (file) {
        sessionRef.current = file;
        setActiveSession(file);
      }
      void window.harness.sessions.list().then((threads) => {
        // A brand-new thread's JSONL is only written when the first assistant message
        // is persisted; until then the disk-backed list misses it. Keep a placeholder
        // row visible during the first turn so the sidebar updates immediately.
        if (seedMessage && file) {
          const cwdForSeed = snapshot.cwd ?? cwd ?? workspace;
          const seedTitle = seedMessage.text || t("common.unnamed");
          // Phase 1：缓存首次消息标题，切走/刷新后 `setSessionList` 会用它覆写主进程
          // 合成的占位标题（否则占位只能显示 cwd 兜底名）。
          sessionTitlesRef.current.set(file, seedTitle);
          setSessions(upsertSessionSummary(threads, {
            path: file,
            cwd: cwdForSeed ?? "",
            title: seedTitle,
            provider: chat.id,
            model: modelId,
          }));
        } else {
          setSessionList(threads);
        }
      });
      void refreshAgentSkills();
      return true;
    } catch (error) {
      if (seq !== startSeq.current) return false;
      const message = error instanceof Error ? error.message : String(error);
      // Session switch kills the previous agent; still tell the user when open failed.
      if (sessionPath) {
        setToast(t("toast.sessionOpenFailed", { error: friendlyAgentError(error) }));
      } else if (!/Agent session closed/.test(message)) {
        setToast(friendlyAgentError(error));
      }
      if (/not configured|credential|login|api key/i.test(message)) setLoginOpen(true);
      return false;
    } finally {
      if (seq === startSeq.current) setLoading(false);
    }
  }, [applyThinkingForModel, permission, refreshAgentSkills, resolveSandbox, syncAgentThinking, t]);

  /**
   * 委派子会话：默认在右侧面板开一个只读标签（不再抢占中间主会话区）。
   * 需要把子会话放进主区时走 SessionRow 右键菜单的「在主会话中打开」。
   */
  const openDelegatedSession = useCallback((session: SessionSummary) => {
    if (!session.path) return;
    const startedAt = Date.parse(session.createdAt);
    const updatedAt = Date.parse(session.updatedAt);
    const running = session.delegationStatus === "pending" || session.delegationStatus === "running";
    // 身份与主会话里的委派卡片一致（委派 id 或子会话文件名同源），点哪边都是同一个标签页。
    const key = delegationPanelKey(session.sourceDelegationId, session.path);
    if (!key) return;
    browserPanels.openChildSession(key, {
      role: session.delegationRole ?? "subagent",
      sessionPath: session.path,
      ...(session.title ? { title: session.title } : {}),
      ...(session.delegationStatus ? { status: session.delegationStatus } : {}),
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
      ...(!running && Number.isFinite(updatedAt) ? { completedAt: updatedAt } : {}),
      ...(session.messageCount ? { turns: session.messageCount } : {}),
      ...(session.delegationReport ? { report: session.delegationReport } : {}),
    });
  }, [browserPanels]);

  const openSession = useCallback((session: SessionSummary) => {
    // Allow re-open when the row is highlighted but the transcript failed to load.
    if (isSameSession(session, activeSession) && messages.length > 0 && !loading) return;
    void startAgent(session.cwd, session.path, true, false, permission, undefined, session.storagePath);
  }, [activeSession, loading, messages.length, permission, startAgent]);

  const ensureModelReady = useCallback(async (): Promise<boolean> => {
    if (!agentCwd.current) return true;
    const current = activeChatProvider(await window.harness.auth.status());
    if (`${current?.serviceId ?? ""}:${current?.serviceVersion ?? ""}` !== runtimeServiceRef.current) {
      // 停掉旧宿主后重启：先把渲染层标记为不可用，避免停止与重启之间的在途事件
      // 触发对已停止会话的命令；重启失败时清掉会话引用，别把陈旧 agentCwd 留给后续命令。
      live.current = false;
      await window.harness.agent.stop();
      const started = await startAgent(workspace, sessionRef.current, Boolean(workspace), true);
      if (!started) dropAgentSession();
      return started;
    }
    const next = modelRef.current.trim();
    if (!next) return true;
    if (agentModelIdsRef.current.includes(next)) {
      try {
        await window.harness.agent.command("set_model", { provider: runtimeProviderRef.current, modelId: next });
        await syncAgentThinking();
        return true;
      } catch (error) {
        setToast(friendlyAgentError(error));
        return false;
      }
    }
    live.current = false;
    await window.harness.agent.stop().catch(() => undefined);
    const restarted = await startAgent(workspace, sessionRef.current, Boolean(workspace), true);
    if (!restarted) dropAgentSession();
    return restarted;
  }, [dropAgentSession, startAgent, syncAgentThinking, workspace]);

  const switchModel = useCallback(async (key: string) => {
    const option = modelOptions.find((item) => item.value === key);
    if (!option || modelSwitchBusy.current || loading) return;
    const next = option.modelId;
    modelSwitchBusy.current = true;
    setModelSwitchPending(true);
    try {
      let accounts = providersRef.current;
      if (option.serviceId) {
        const saved = await window.harness.providers.setDefault(option.serviceId, next);
        if (!saved) throw new Error(t("toast.modelSwitchFailed"));
        accounts = await window.harness.auth.status();
        providersRef.current = accounts;
        setProviders(accounts);
      }
      setModel(next);
      modelRef.current = next;
      applyThinkingForModel(next, accounts);
      const currentService = activeChatProvider(accounts);
      // A running turn keeps its original service; ensureModelReady applies the choice next turn.
      if (!running && agentCwd.current && `${currentService?.serviceId ?? ""}:${currentService?.serviceVersion ?? ""}` === runtimeServiceRef.current
        && agentModelIdsRef.current.includes(next)) {
        await window.harness.agent.command("set_model", { provider: runtimeProviderRef.current, modelId: next }).catch(() => undefined);
      }
      setToast(agentCwd.current ? t("toast.modelNextTurn", { model: next }) : t("toast.modelSwitched", { model: next }));
    } catch (error) {
      setToast(friendlyAgentError(error));
    } finally {
      modelSwitchBusy.current = false;
      setModelSwitchPending(false);
    }
  }, [applyThinkingForModel, loading, modelOptions, running, t]);

  const bindProject = useCallback(async (cwd: string): Promise<boolean> => {
    // Phase 3b：多会话并行下，切换项目不再因“当前 agent 仍在运行”而阻止——每个
    // 项目/会话有独立 worker，旧项目的会话切走后会继续后台运行，切回即可见。
    if (running && agentCwd.current === cwd) return true;
    live.current = false;
    setWorkspace(cwd);
    setOpenProjects((current) => ({ ...current, [cwd]: true }));
    setMessages([]);
    setStats(undefined);
    fillPrompt("");
    setSteering([]);
    setActiveSession(undefined);
    sessionRef.current = undefined;
    setRunning(false);
    setUiRequest(undefined);
    setPreview(undefined);
    setFeatureTodos([]);
    setAgentSkills([]);
    if (!agentCwd.current) return true;
    agentCwd.current = undefined;
    if (!running) await window.harness.agent.stop().catch(() => undefined);
    return true;
  }, [fillPrompt, running, t]);
  const openFolder = useCallback(async () => {
    const selected = await window.harness.workspace.choose();
    if (!selected) return;
    if (!(await bindProject(selected))) return null;
    setWorkspaces(await window.harness.workspace.recent());
    return selected;
  }, [bindProject]);

  const newThread = useCallback(async () => {
    live.current = false;
    // 已绑定项目时，在当前项目内直接新开一条空白会话；只有未选项目才停在首页选择项目。
    // 首页（home）会据 workspace 自动切换成「项目名 + 输入框」，因此不清空 workspace。
    if (workspace) setOpenProjects((current) => ({ ...current, [workspace]: true }));
    setMessages([]);
    setStats(undefined);
    fillPrompt("");
    setSteering([]);
    setRunning(false);
    setUiRequest(undefined);
    setPreview(undefined);
    setFeatureTodos([]);
    setAgentSkills([]);
    setActiveSession(undefined);
    sessionRef.current = undefined;
    if (!agentCwd.current) return;
    agentCwd.current = undefined;
    await window.harness.agent.command("abort").catch(() => undefined);
    await window.harness.agent.stop().catch(() => undefined);
  }, [fillPrompt, workspace]);

  const removeSession = useCallback(async (session: SessionSummary) => {
    if (isSameSession(session, activeSession)) {
      live.current = false;
      // Abort + stop the RPC tree so Seatbelt shells / background jobs die with the thread.
      if (agentCwd.current) {
        await window.harness.agent.command("abort").catch(() => undefined);
        await window.harness.agent.stop().catch(() => undefined);
        agentCwd.current = undefined;
      }
      setMessages([]);
      setStats(undefined);
      setSteering([]);
      setActiveSession(undefined);
      sessionRef.current = undefined;
      setRunning(false);
      setUiRequest(undefined);
      setStoppedJobs([]);
    }
    try {
      await window.harness.sessions.remove(session.id);
      sessionTitlesRef.current.delete(session.path);
      setSessionList(await window.harness.sessions.list());
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  }, [activeSession]);

  const pinSession = useCallback(async (session: SessionSummary) => {
    try {
      await window.harness.sessions.pin(session.id, !session.pinned);
      setSessionList(await window.harness.sessions.list());
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const renameSession = useCallback(async (session: SessionSummary, title: string) => {
    try {
      await window.harness.sessions.rename(session.id, title);
      sessionTitlesRef.current.set(session.path, title);
      setSessionList(await window.harness.sessions.list());
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const removeProject = useCallback(async (path: string) => {
    try {
      setWorkspaces(await window.harness.workspace.forget(path));
      setSessionList(await window.harness.sessions.list());
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
      return;
    }
    if (workspace !== path) return;
    live.current = false;
    setWorkspace(undefined);
    setMessages([]);
    setStats(undefined);
    setSteering([]);
    setActiveSession(undefined);
    setRunning(false);
    setUiRequest(undefined);
    sessionRef.current = undefined;
    // abort 只在确有会话时发；否则主进程会回一条“无活动会话”诊断（哨兵已不刷屏，但没必要发）。
    const hadSession = Boolean(agentCwd.current);
    agentCwd.current = undefined;
    if (hadSession) await window.harness.agent.command("abort").catch(() => undefined);
    await window.harness.agent.stop().catch(() => undefined);
  }, [workspace]);

  const applyUndo = useCallback(async (files: RestoreFile[]) => {
    const result = await window.harness.workspace.restore(files, workspace);
    if (result.failed?.length) {
      // 明确告知哪些文件没恢复，避免 UI 已回退、磁盘只恢复一半的假象。
      setToast(
        `部分文件未恢复：${result.failed
          .map((item) => `${item.path}（${item.error}）`)
          .join("；")}`,
      );
    }
    setMessages((current) => dropLastTurn(current));
    const stats = await window.harness.agent.command<{ sessionFile?: string }>("get_session_stats").catch(() => undefined);
    if (typeof stats?.sessionFile === "string") {
      sessionRef.current = stats.sessionFile;
      setActiveSession(stats.sessionFile);
    }
    void window.harness.sessions.list().then(setSessionList);
  }, [workspace]);

  const stopJobs = useCallback(async (message: string) => {
    const data = await window.harness.agent.command<{ commands: Array<{ name: string }> }>("get_commands");
    const names = new Set((data.commands ?? []).map((item) => item.name.replace(/^\//, "")));
    if (!names.has("stop-job") && !names.has("stop-jobs")) throw new Error(t("toast.needJobCommands"));
    await window.harness.agent.command("prompt", { message });
  }, [t]);

  const undoLastTurn = useCallback(async () => {
    if (running) return;
    if (!agentCwd.current) {
      const started = await startAgent(workspace, sessionRef.current, true, true);
      if (!started) {
        setToast(t("toast.noActiveSession"));
        return;
      }
    }
    try {
      const log = await window.harness.agent.command<{ entries: Parameters<typeof lastTurnRestoreFiles>[0] }>("get_entries");
      const files = lastTurnRestoreFiles(log.entries ?? []);
      if (files.length === 0) {
        setToast(t("toast.nothingToUndo"));
        return;
      }
      pendingUndo.current = { files };
      setUiRequest({
        type: "extension_ui_request",
        id: "harness:undo",
        method: "confirm",
        title: `Undo last turn?\n${files.map((file) => file.path).join("\n")}`,
      });
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    }
  }, [running, startAgent, t, workspace]);

  const compactContext = useCallback(async () => {
    if (running) {
      setToast(t("toast.waitBeforeCompact"));
      return;
    }
    if (!agentCwd.current && !workspace && !sessionRef.current) {
      setToast(t("toast.nothingToCompact"));
      return;
    }
    if (!agentCwd.current) {
      const started = await startAgent(workspace, sessionRef.current, true, true);
      if (!started) {
        setToast(t("toast.noCompactSession"));
        return;
      }
    }
    setLoading(true);
    setToast(t("toast.compacting"));
    try {
      const result = await window.harness.agent.command<{ tokensBefore?: number; summary?: string }>("compact");
      const [history, nextStats] = await Promise.all([
        window.harness.agent.command<{ messages: unknown[] }>("get_messages"),
        window.harness.agent.command<AgentSessionStats>("get_session_stats"),
      ]);
      setMessages(normalizeMessages(history.messages));
      setStats(nextStats);
      setToast(
        result.tokensBefore
          ? t("toast.compactDoneTokens", { tokens: result.tokensBefore.toLocaleString(locale === "en" ? "en-US" : "zh-CN") })
          : t("toast.compactDone"),
      );
      void window.harness.sessions.list().then(setSessionList);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (/nothing to compact|session too small/i.test(raw)) {
        setToast(t("toast.compactTooShort"));
      } else if (/no workspace session|not active|no agent/i.test(raw)) {
        setToast(t("toast.noCompactSession"));
      } else {
        setToast(t("toast.compactFailed", {
          error: raw.replace(/^Error invoking remote method 'agent:command':\s*/i, "").replace(/^Error:\s*/i, ""),
        }));
      }
    } finally {
      setLoading(false);
    }
  }, [locale, running, startAgent, t, workspace]);

  const approvePlan = useCallback(async () => {
    if (loading || running) return;
    const target = permissionBeforePlan.current;
    setLoading(true);
    try {
      await window.harness.agent.command("prompt", { message: "/plan execute" });
      setPermission(target);
      setToast(t("plan.approved"));
    } catch (error) {
      setToast(friendlyAgentError(error));
    } finally {
      setLoading(false);
    }
  }, [loading, running, t]);

  const refinePlan = useCallback(async (changes: string) => {
    const text = changes.trim();
    if (!text || loading || running) return;
    setLoading(true);
    try {
      await window.harness.agent.command("prompt", {
        message: `Refine the current plan using update_plan. Requested changes:\n${text}`,
      });
    } catch (error) {
      setToast(friendlyAgentError(error));
    } finally {
      setLoading(false);
    }
  }, [loading, running]);

  const sendMessage = useCallback(async (preset?: string, images?: string[]) => {
    const text = (preset ?? "").trim();
    if (text === "/undo") {
      if (running) return;
      fillPrompt("");
      void undoLastTurn();
      return;
    }
    if ((!text && !images?.length) || loading || modelSwitchBusy.current || sending.current) return;
    if (running) {
      if (text.startsWith("/")) return;
      const followup = text || t("toast.defaultImagePrompt");
      fillPrompt("");
      try {
        const payload: Record<string, unknown> = { message: followup };
        if (images?.length) payload.images = toPromptImages(images);
        await window.harness.agent.command("steer", payload);
        setSteering((current) => (current.includes(followup) ? current : [...current, followup]));
        setToast(t("toast.steered"));
      } catch (error) {
        fillPrompt(text);
        setToast(friendlyAgentError(error));
      }
      return;
    }
    sending.current = true;
    const question = text || t("toast.defaultImagePrompt");
    const thumbs = (images ?? []).map((item) => {
      const match = item.match(/^data:([^;]+);base64,(.+)$/);
      return {
        mimeType: match?.[1] ?? "image/png",
        data: match?.[2] ?? item.replace(/^data:[^;]+;base64,/, ""),
      };
    });
    let optimistic: ChatMessage | undefined;
    try {
      let cwd = workspace ?? agentCwd.current;
      if (!cwd) {
        const opened = await openFolder();
        if (!opened) return;
        cwd = opened;
      }

      // Paint the user turn immediately so first-send doesn't sit on the home screen.
      optimistic = optimisticUserMessage(question, false, thumbs);
      runEpoch.current += 1;
      fillPrompt("");
      setMessages((current) => [...current, optimistic!]);
      setRunning(true);

      if (!agentCwd.current) {
        const started = await startAgent(cwd, undefined, true, false, permission, optimistic);
        if (!started) {
          setMessages((current) => current.filter((item) => item.id !== optimistic!.id));
          fillPrompt(text);
          setRunning(false);
          return;
        }
      } else if (!(await ensureModelReady())) {
        setMessages((current) => current.filter((item) => item.id !== optimistic!.id));
        fillPrompt(text);
        setRunning(false);
        return;
      }

      if (!images?.length) {
        await window.harness.agent.command("prompt", { message: question });
      } else if (agentModelsRef.current.find((item) => item.provider === runtimeProviderRef.current && item.id === modelRef.current)?.input?.includes("image")
        ?? modelSupportsVision(modelRef.current)) {
        try {
          await window.harness.agent.command("prompt", {
            message: question,
            images: toPromptImages(images),
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          // Model declared vision but API rejected images — fall back to dedicated vision tool.
          if (!/does not support image|image input|unsupported.*image|invalid.*image/i.test(detail)) {
            throw error;
          }
          const message = visionAgentPrompt(question, await window.harness.vision.stage(images));
          await window.harness.agent.command("prompt", { message });
        }
      } else {
        const message = visionAgentPrompt(question, await window.harness.vision.stage(images));
        await window.harness.agent.command("prompt", { message });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const optimisticId = optimistic?.id;
      if (optimisticId) setMessages((current) => current.filter((item) => item.id !== optimisticId));
      fillPrompt(text);
      setRunning(false);
      if (!/Agent session closed/.test(detail)) setToast(friendlyAgentError(error));
    } finally {
      sending.current = false;
    }
  }, [ensureModelReady, fillPrompt, loading, openFolder, permission, running, startAgent, t, undoLastTurn, workspace]);

  useEffect(() => {
    void refresh().then((status) => {
      const current = activeChatProvider(status);
      if (current?.configured) setModel(current.defaultModel);
      if (!current?.configured) setLoginOpen(true);
    });
  }, []);

  // 启动时提示“配置已损坏并回退默认值”，损坏文件已由主进程备份为 .corrupt。
  useEffect(() => {
    void window.harness.app
      .configNotices()
      .then((notices) => {
        if (notices.length) setToast(notices.join(" "));
      })
      .catch(() => undefined);
  }, []);

  // renderer 重载后重新发现仍在后台运行的会话，恢复侧边栏运行徽标。
  useEffect(() => {
    void window.harness.agent
      .runtimes()
      .then((list) => {
        for (const runtime of list) {
          if (runtime.running && runtime.sessionKey)
            markSessionRunning(runtime.sessionKey, true);
        }
      })
      .catch(() => undefined);
  }, [markSessionRunning]);

  useEffect(() => {
    const chat = activeChatProvider(providers);
    if (chat?.serviceId) {
      setChatModels(chat.models ?? []);
      applyThinkingForModel(modelRef.current || chat.defaultModel, providers);
      return;
    }
    if (!chat?.configured || !chat.baseUrl) return;
    let cancelled = false;
    void window.harness.auth.readApiKey("deepseek").then((key) => {
      if (!key.trim() || !chat.baseUrl) return;
      return window.harness.auth.listModels(chat.baseUrl, key);
    }).then((ids) => {
      if (!cancelled && ids?.length) setChatModels(ids);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [providers, applyThinkingForModel]);

  useEffect(() => {
    const queue = createStreamScheduler((events) => {
      const seq = startSeq.current;
      setMessages((current) => live.current && seq === startSeq.current
        ? events.reduce(applyAgentEvent, current)
        : current);
    });
    eventQueue.current = queue;
    const offEvent = window.harness.agent.onEvent((event) => {
      if (!live.current) { queue.clear(); return; }
      // Phase 3a：按活动会话路由。后台会话（__sessionId ≠ 当前视图）的事件不套到
      // 当前 messages/stats，避免污染；但维护运行中徽标，并在其结束时提示完成。
      const eventSession = (event as { __sessionId?: string }).__sessionId;
      if (eventSession && eventSession !== sessionRef.current) {
        if (event.type === "agent_start") {
          markSessionRunning(eventSession, true);
        } else if (event.type === "agent_settled") {
          markSessionRunning(eventSession, false);
          void window.harness.sessions.list().then(setSessionList);
          setToast(t("toast.backgroundSessionDone", { title: eventSessionTitle(eventSession) }));
        }
        return;
      }
      // 按运行句柄内序号去重：snapshot 回放与实时流可能重叠。
      const eventSeq = (event as { __seq?: number }).__seq;
      if (typeof eventSeq === "number") {
        const key = eventSession ?? sessionRef.current ?? "";
        if (eventSeq <= (eventSeqRef.current.get(key) ?? 0)) return;
        eventSeqRef.current.set(key, eventSeq);
      }
      if (event.type !== "message_update" && event.type !== "tool_execution_update") queue.flush();
      if (event.type === "agent_start") {
        runEpoch.current += 1;
        setRunning(true);
        setStopping(false);
        markSessionRunning(eventSession ?? sessionRef.current, true);
      }
      if (event.type === "desktop_snapshot_meta") {
        if (Array.isArray(event.models)) {
          agentModelsRef.current = event.models as typeof agentModelsRef.current;
          agentModelIdsRef.current = agentModelsRef.current.map((item) => item.id).filter(Boolean);
        }
        if (Array.isArray(event.thinkingLevels)) void syncAgentThinking();
        if (Array.isArray(event.skills)) setAgentSkills(event.skills as AgentSkillCommand[]);
        if (event.stats && typeof event.stats === "object") setStats(event.stats as AgentSessionStats);
      }
      if (event.type === "agent_settled") {
        setRunning(false);
        setStopping(false);
        setUiRequest(undefined);
        markSessionRunning(eventSession ?? sessionRef.current, false);
        const seq = startSeq.current;
        const epoch = runEpoch.current;
        void window.harness.agent.command<AgentSessionStats>("get_session_stats").then((nextStats) => {
          if (!live.current || seq !== startSeq.current || epoch !== runEpoch.current) return;
          setStats(nextStats);
          if (typeof nextStats?.sessionFile !== "string") return;
          sessionRef.current = nextStats.sessionFile;
          setActiveSession(nextStats.sessionFile);
        }).catch(() => undefined);
        void window.harness.sessions.list().then(setSessionList);
      }
      if (event.type === "queue_update") {
        const nextSteering = Array.isArray(event.steering)
          ? event.steering.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [];
        setSteering(nextSteering);
      }
      if (event.type === "extension_error" && typeof event.error === "string" && !isTransientStreamError(event.error)) {
        const text = friendlyAgentError(event.error);
        if (text) setToast(text);
      }
      if (event.type === "tool_execution_end" && event.isError === true) {
        const detail = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
        if (/read-only|permission denied|not permitted|sandbox/i.test(detail)) {
          setToast(t("toast.readOnlySession"));
        }
      }
      if (event.type === "extension_ui_request") {
        const request = event as ExtensionUiRequest;
        if (request.method === "notify") setToast(request.message ?? t("toast.notify"));
        else if (["select", "confirm", "input", "editor"].includes(request.method)) setUiRequest(request);
      }
      queue.push(event);
    });
    const offError = window.harness.agent.onError((payload) => {
      const message = payload?.message ?? String(payload);
      // Phase 3a：后台会话的错误不 fail 当前视图。
      const errorSession = payload?.__sessionId;
      if (errorSession && errorSession !== sessionRef.current) return;
      if (!live.current) return;
      if (/Agent session closed/.test(message) || isTransientStreamError(message)) return;
      queue.flush();
      setStopping(false);
      setRunning(false);
      markSessionRunning(errorSession ?? sessionRef.current, false);
      const text = friendlyAgentError(message);
      setMessages((current) => failActiveTurn(current, text || message));
      if (text) setToast(text);
    });
    const offCommand = window.harness.onAppCommand((command) => {
      if (command === "new-thread") void newThread();
      if (command === "open-folder") void openFolder();
      if (command === "workspace-watch-failed") setToast(t("toast.workspaceWatchFailed"));
      if (command === "fullscreen-on") setFullscreen(true);
      if (command === "fullscreen-off") setFullscreen(false);
    });
    return () => {
      queue.flush();
      queue.dispose();
      if (eventQueue.current === queue) eventQueue.current = undefined;
      offEvent();
      offError();
      offCommand();
    };
  }, [newThread, openFolder, syncAgentThinking, t, workspace]);

  useEffect(() => {
    if (!workspace) {
      setFeatureTodos([]);
      return;
    }
    let gone = false;
    const timer = window.setTimeout(() => {
      void window.harness.workspace.read(".agents/features.json", workspace).then(
        (result) => {
          if (!gone) setFeatureTodos(result.binary ? [] : parseFeaturesJson(result.content));
        },
        () => {
          if (!gone) setFeatureTodos([]);
        },
      );
    }, running ? 800 : 0);
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [workspace, running, workingFiles.length]);

  const home = groups.length === 0 && !activeSession && !loading;

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || home) return;

    const pin = () => {
      const overlay = dock.current?.offsetHeight ?? 0;
      if (overlay > 0) {
        node.style.setProperty("--dock-clearance", `${overlay + 24}px`);
        node.parentElement?.style.setProperty("--dock-clearance", `${overlay + 24}px`);
      }
    };

    const ro = new ResizeObserver(pin);
    if (dock.current) ro.observe(dock.current);
    pin();
    return () => ro.disconnect();
  }, [home, steering.length]);

  // 会话列表条目：窗口化渲染（见 message-list.tsx），只有视口附近的条目会真正挂载。
  // 这里只负责把「一轮提问/回答」「等待中」「确认卡片」描述成条目；条目内容在进入
  // 视口时才构造，因此历史轮次在流式期间不再每帧重新创建元素树。
  //
  // 条目对象按组缓存：流式期间每帧只有最后一组在变（groupConversation 对未变的
  // 前缀组返回同一引用），其余条目复用旧对象，让 MessageList 的 `items` 在纯内容
  // 更新帧保持稳定（配合 MemoItem，已挂载的历史条目整体跳过对账）。
  const listItemCache = useRef<Array<{ source: unknown; signature: string; item: MessageListItem }>>([]);
  const lastListItems = useRef<MessageListItem[] | undefined>(undefined);
  const listItems: MessageListItem[] = useMemo(() => {
    const cache = listItemCache.current;
    const items: MessageListItem[] = [];
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const cached = cache[index];
      if (group.type === "user") {
        if (cached && cached.source === group.message && cached.signature === "") {
          items.push(cached.item);
          continue;
        }
        const anchor = turnAnchorId(group.id);
        const item: MessageListItem = {
          key: group.id,
          anchor,
          render: () => (
            <UserTurn anchor={anchor} text={group.message.text} images={group.message.images} />
          ),
        };
        items.push(item);
        cache[index] = { source: group.message, signature: "", item };
        continue;
      }
      const recovered = assistantErrorRecovered(group.messages, groups, index);
      const isLastGroup = index === groups.length - 1;
      const showRetry = !running && isLastGroup
        && assistantGroupHasRecoverableError(group.messages)
        && !recovered
        && !assistantGroupSucceeded(group.messages);
      const recoverableFailStreak = recoverableStreaks[index] ?? 0;
      const signature = isLastGroup
        ? `${running}|${Boolean(uiRequest)}|${stopping}|${recovered}|${recoverableFailStreak}|${showRetry}`
        : `${recovered}|${recoverableFailStreak}|${showRetry}`;
      if (cached && cached.source === group && cached.signature === signature) {
        items.push(cached.item);
        continue;
      }
      const item: MessageListItem = {
        key: group.id,
        render: () => (
          <AssistantTurn
            messages={group.messages}
            running={isLastGroup && running}
            awaiting={isLastGroup && Boolean(uiRequest)}
            stopping={isLastGroup && stopping}
            canAutoCollapse={canAutoCollapse}
            errorRecovered={recovered}
            recoverableFailStreak={recoverableFailStreak}
            onOpenFile={setPreview}
            onOpenPath={(path) => browserPanels.openFile(path)}
            onRetry={showRetry ? () => {
              void sendMessage(t("composer.retryContinue"));
            } : undefined}
          />
        ),
      };
      items.push(item);
      cache[index] = { source: group, signature, item };
    }
    if (waiting) {
      items.push({
        key: "waiting",
        render: () => (
          <article className="turn">
            <div className="turn-trace">
              <Thinking
                text=""
                work={[]}
                tools={[]}
                live
                label={loading ? t("think.starting") : t("think.waiting")}
              />
            </div>
          </article>
        ),
      });
    }
    if (uiRequest) {
      const request = uiRequest;
      items.push({
        key: "approval",
        render: () => (
          <ApprovalCard
            request={request}
            lastTurn={[...messages].reverse().find((item) => item.role === "user" && item.text.trim() !== "/undo")?.text}
            onRespond={request.id === "harness:undo" ? async (response) => {
              if (response.confirmed !== true) {
                pendingUndo.current = undefined;
                return;
              }
              const pending = pendingUndo.current;
              if (!pending) return;
              await applyUndo(pending.files);
              pendingUndo.current = undefined;
            } : undefined}
            onDone={() => {
              setUiRequest(undefined);
            }}
            onError={setToast}
          />
        ),
      });
    }
    // 全部命中时保持上一次的数组引用：MessageList / Virtualizer 的 props 在
    // 流式帧里真正稳定，虚拟列表内部不再做无谓的按帧对账。
    const previous = lastListItems.current;
    if (previous && previous.length === items.length
      && items.every((item, index) => previous[index] === item)) {
      return previous;
    }
    lastListItems.current = items;
    return items;
  }, [groups, recoverableStreaks, running, stopping, uiRequest, loading, messages, t]);

  const homeRecents = (
    workspace
      ? projects.find((item) => item.item.path === workspace)?.sessions ?? []
      : projects.flatMap((item) => item.sessions).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  ).slice(0, 5);
  const composer = (
    <PromptBar
      fillText={promptFill.text}
      fillToken={promptFill.token}
      onSubmit={(text, images) => void sendMessage(text, images)}
      onStop={() => {
        const seq = startSeq.current;
        const epoch = runEpoch.current;
        eventQueue.current?.flush();
        // 停在「等用户应答」的卡片上时（ask_user、权限确认、访问边界选择），worker 的
        // abort 要等这个工具返回才能收尾；先按取消答复，卡片收起、turn 立刻结束。
        const pendingUi = uiRequest;
        if (pendingUi && !pendingUi.id.startsWith("harness:")) {
          setUiRequest(undefined);
          void window.harness.agent.respondToUi(pendingUi.id, { cancelled: true }).catch(() => undefined);
        }
        setStopping(true);
        // 宿主可能要等一个「不可中断的步骤」跑完才回 abort 响应（响应本身也有 10 分钟级上限），
        // 期间按钮不能一直锁在「停止中」：给 UI 一个上限，超时就把按钮还原成可再次点击，
        // 真正的收尾仍由 agent_settled 事件驱动。
        const abortOutcome = window.harness.agent
          .command("abort")
          .then(() => "aborted" as const)
          .catch((error) => (error instanceof Error ? error : new Error(String(error))));
        const stopDeadline = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), STOP_UI_TIMEOUT_MS));
        void Promise.race([abortOutcome, stopDeadline]).then((outcome) => {
          if (seq !== startSeq.current || epoch !== runEpoch.current) return;
          if (outcome === "timeout") {
            setStopping(false);
            return;
          }
          if (outcome instanceof Error) {
            setStopping(false);
            setToast(friendlyAgentError(outcome));
            return;
          }
          if (!live.current) return;
          eventQueue.current?.flush();
          setMessages((current) => epoch === runEpoch.current ? settleStoppedTurn(current) : current);
          setRunning(false);
          setStopping(false);
        });
      }}
      steering={steering}
      rootRef={dock}
      running={running}
      stopping={stopping}
      disabled={loading || modelSwitchPending}
      workspace={workspace}
      onPickWorkspace={() => void openFolder()}
      model={model}
      modelKey={modelOptionKey(connected?.serviceId, model)}
      models={modelOptions}
      onModel={(key) => void switchModel(key)}
      effort={effort}
      effortLevels={thinkingLevels}
      onEffort={applyEffort}
      permission={permission}
      onPermission={(next) => {
        const mode = next as PermissionMode;
        if (mode === "plan" && permission !== "plan") {
          permissionBeforePlan.current = permission;
        }
        setPermission(mode);
        if (!agentCwd.current) return;
        void (async () => {
          try {
            await window.harness.agent.command("prompt", { message: `/permissions ${mode}` });
            setToast(mode === "full" ? t("toast.sandboxOff") : t("toast.permissionChanged"));
          } catch (error) {
            setToast(friendlyAgentError(error));
          }
        })();
      }}
      onCommand={(command) => {
        if (command === "/new") void newThread();
        if (command === "/open") void openFolder();
        if (command === "/undo") void undoLastTurn();
        if (command === "/compact") void compactContext();
        if (command === "/login") setLoginOpen(true);
      }}
      skillCommands={agentSkills}
      stats={stats}
      onCompact={() => void compactContext()}
      placement={home ? "hero" : "dock"}
    />
  );

  return (
    <PreviewContext.Provider value={(filePath) => setPreview({ path: filePath, additions: 0, deletions: 0 })}>
    <div className={["app", darwin && "darwin", fullscreen && "fullscreen"].filter(Boolean).join(" ")}>
      <SidebarNav
        collapsed={sidebarLayout.collapsed}
        onToggle={sidebarLayout.toggle}
        onNew={() => void newThread()}
        onOpen={() => void openFolder()}
        account={(
          <AccountMenu
            model={model}
            configured={Boolean(connected?.configured)}
            onOpenSettings={() => setLoginOpen(true)}
          />
        )}
      >
        <div className="section-label">{t("nav.sectionProjects")}</div>
        {projects.length === 0 && <p className="sidebar-empty">{t("nav.noProjects")}</p>}
        {projects.map(({ item, sessions: threads }) => {
          const open = openProjects[item.path] === true;
          return (
            <div key={item.path} className={open ? "project open" : "project"}>
              <div
                className={item.path === workspace ? "project-head active" : "project-head"}
              >
              <button
                type="button"
                className="project-row"
                title={`${item.name}\n${item.path}`}
                aria-label={item.name}
                aria-current={item.path === workspace ? "true" : undefined}
                onClick={() => {
                  setOpenProjects((current) => ({ ...current, [item.path]: true }));
                  void bindProject(item.path);
                }}
              >
                <span
                  className="chevron-hit"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpenProjects((current) => ({ ...current, [item.path]: !open }));
                  }}
                >
                  <Icon className="chevron" path="M9 6l6 6-6 6" size={14} />
                </span>
                <Icon path="M3 7h6l2 2h10v10H3z" size={15} />
                <strong className="sidebar-full-label">{item.name}</strong>
                <span className="sidebar-short-label" aria-hidden="true">{Array.from(item.name.trim()).slice(0, 2).join("")}</span>
              </button>
              <button
                type="button"
                className="session-del"
                aria-label={t("nav.removeProject")}
                onClick={(event) => {
                  event.stopPropagation();
                  void removeProject(item.path);
                }}
              >
                <Icon path="M6 6l12 12M18 6L6 18" size={12} />
              </button>
              </div>
              {open && (
                <div className="session-list nested">
                  {threads.length === 0 && <p className="task-empty">{t("nav.noThreads")}</p>}
                  {groupDelegatedSessions(threads).map(({ session, children }) => {
                    const expanded = railOpen[session.id] ?? branchAutoExpanded({
                      children,
                      isActive: (item) => isSameSession(item, activeSession),
                      isRunning: (item) => runningSessionIds.has(item.path),
                      isParentActive: () => isSameSession(session, activeSession),
                    });
                    return (
                      <div key={session.id} className={expanded && children.length > 0 ? "session-branch open" : "session-branch"}>
                        <SessionRow
                          session={session}
                          active={isSameSession(session, activeSession)}
                          running={runningSessionIds.has(session.path)}
                          childCount={children.length}
                          branchExpanded={expanded}
                          onToggleBranch={() => setRailOpen((current) => ({ ...current, [session.id]: !expanded }))}
                          onOpen={() => openSession(session)}
                          onPin={() => void pinSession(session)}
                          onRename={(title) => void renameSession(session, title)}
                          onRemove={() => void removeSession(session)}
                        />
                        {children.length > 0 && expanded && (
                          <div className="delegated-children">
                            {children.map((child) => (
                              <SessionRow
                                key={child.id}
                                session={child}
                                active={isSameSession(child, activeSession)}
                                running={runningSessionIds.has(child.path)}
                                onOpen={() => openDelegatedSession(child)}
                                onOpenInMain={() => openSession(child)}
                                onPin={() => void pinSession(child)}
                                onRename={(title) => void renameSession(child, title)}
                                onRemove={() => void removeSession(child)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </SidebarNav>

      <PanelActionsProvider actions={panelActions}>
      <Chat
        onSidebarAutoCollapse={sidebarLayout.collapseAutomatically}
        home={home}
        title={sessions.find((session) => isSameSession(session, activeSession))?.title || (workspace ? baseName(workspace) : undefined)}
        composer={home ? undefined : composer}
        nav={<TurnNav items={anchors} onJump={(id) => {
          // 跳转是一次性改变滚动位置：等窗口化列表把目标条目挂载、测量完再重新取样
          // 滚动锚点，避免随后按旧锚点补偿把这次跳转拉回（见 use-follow-scroll 的 reanchor）。
          messageList.current?.scrollToAnchor(id, { onSettled: follow.reanchor });
        }} />}
        inspect={workspace ? (
          <WorkbenchPanels panels={browserPanels} onError={setToast} workspace={workspace} inspect={
            <InspectPanel
              files={workingFiles}
              todos={todos}
              terminals={terminals}
              folder={baseName(workspace)}
              workspace={workspace}
              refresh={running}
              running={running}
              planApproval={planApproval}
              onApprovePlan={() => void approvePlan()}
              onRefinePlan={(text) => void refinePlan(text)}
              onOpen={setPreview}
              onUndo={() => void undoLastTurn()}
              onStopTerminal={(id) => {
                setStoppedJobs((current) => current.includes(id) ? current : [...current, id]);
                void stopJobs(`/stop-job ${id}`).catch((error) => {
                  setStoppedJobs((current) => current.filter((item) => item !== id));
                  setToast(error instanceof Error ? error.message : String(error));
                });
              }}
              onStopAllTerminals={() => {
                const ids = terminals.map((job) => job.id);
                setStoppedJobs((current) => [...new Set([...current, ...ids])]);
                void stopJobs("/stop-jobs").catch((error) => {
                  setStoppedJobs((current) => current.filter((item) => !ids.includes(item)));
                  setToast(error instanceof Error ? error.message : String(error));
                });
              }}
            />
          } />
        ) : undefined}
      >
        <div
          className={home ? "conversation home" : "conversation"}
          ref={setScroller}
        >
          {home && (
            <div className="empty">
              <div className="empty-hero">
                <img className="empty-logo" src={logo} alt="" width={30} height={19} />
                <h1>{workspace ? baseName(workspace) : t("home.greeting")}</h1>
              </div>
              {composer}
              <div className="suggestions">
                {suggestions.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => {
                      if ("action" in item && item.action === "open") {
                        void openFolder();
                      } else {
                        void sendMessage(item.label);
                      }
                    }}
                  >
                    {"icon" in item && item.icon && <Icon path={item.icon} size={13} />}
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
              {homeRecents.length > 0 && (
                <div className="home-recents">
                  <div className="home-recents-head">
                    <span>{t("nav.recentActive")}</span>
                  </div>
                  {homeRecents.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className="home-recent"
                      onClick={() => openSession(session)}
                    >
                      <div className="home-recent-main">
                        <Icon path="M19 3H5a2 2 0 0 0-2 2v14l4-4h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" size={14} />
                        <span>{session.title || t("common.unnamedSession")}</span>
                      </div>
                      <small>{relativeTime(session.updatedAt, t)}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {!home && groups.length === 0 && (
            <div className={loading ? "session-pane loading" : "session-pane"}>
              {loading ? (
                <div className="session-loading" role="status" aria-live="polite">
                  <Dots />
                  <span className="shimmer">{t("chat.loadingSession")}</span>
                </div>
              ) : (
                <p className="session-pane-empty">{t("chat.emptySession")}</p>
              )}
            </div>
          )}
          {groups.length > 0 && (
            <MessageList
              ref={messageList}
              items={listItems}
              scrollerRef={scroller}
              contentRef={follow.contentRef}
              progressActive={progressTasks.length > 0}
              cacheKey={`${workspace ?? ""}:${transcriptKey}`}
            />
          )}
        </div>
        {!home && groups.length > 0 && <ProgressOverlay tasks={progressTasks} streaming={running && !stopping} atBottom={follow.atBottom} onFollowLatest={follow.followLatest} />}
        {toast && (
          <button type="button" className="toast" onClick={() => setToast(undefined)}>
            <Icon path="M9 18h6M10 22h4M12 2a7 7 0 0 1 4 12c-.8.8-1 1.5-1 3H9c0-1.5-.2-2.2-1-3A7 7 0 0 1 12 2z" size={16} />
            <span>{/unrestricted host filesystem/i.test(toast) ? t("toast.hostAccessAllowed") : toast}</span>
          </button>
        )}
      </Chat>
      </PanelActionsProvider>
      {preview && <FileDrawer file={preview} workspace={workspace} onClose={() => setPreview(undefined)} />}

      {sandboxAsk && (
        <div
          className="modal"
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            sandboxWaiter.current?.(false);
          }}
        >
          <div className="panel" role="dialog">
            <h2>{t("confirm.unsandboxedTitle")}</h2>
            <p>{sandboxAsk.message}</p>
            <div className="row-actions">
              <button type="button" className="ghost" onClick={() => sandboxWaiter.current?.(false)}>{t("common.cancel")}</button>
              <button type="button" className="primary" onClick={() => sandboxWaiter.current?.(true)}>{t("common.allow")}</button>
            </div>
          </div>
        </div>
      )}
      {loginOpen && (
        <Login
          agentSkills={agentSkills}
          onRefreshSkills={() => void refreshAgentSkills()}
          onClose={() => {
            setLoginOpen(false);
            void refresh().then((status) => {
              const current = activeChatProvider(status);
              if (current?.configured) {
                modelRef.current = current.defaultModel;
                setModel(current.defaultModel);
                applyThinkingForModel(current.defaultModel, status);
              }
            }).catch((error) => setToast(friendlyAgentError(error)));
          }}
          onSaved={async () => {
            const status = await window.harness.auth.status();
            setProviders(status);
            const current = activeChatProvider(status);
            if (current?.configured) {
              const nextModel = current.defaultModel;
              modelRef.current = nextModel;
              setModel(nextModel);
              applyThinkingForModel(nextModel, status);
              setLoginOpen(false);
              await window.harness.agent.stop().catch(() => undefined);
              if (workspace || agentCwd.current) {
                void startAgent(workspace, sessionRef.current, Boolean(workspace), false, permission).then((started) => {
                  if (!started) dropAgentSession();
                });
              }
            }
          }}
        />
      )}
    </div>
    </PreviewContext.Provider>
  );
}
