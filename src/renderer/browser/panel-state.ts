import type { BrowserTabSnapshot } from "../../shared/types";

export type BrowserPanelTab = {
  id: string;
  type: "browser";
  /** 只在新建或窗口迁移时更新，导航与标题变化不得重建 guest。 */
  initialTabs?: BrowserTabSnapshot[];
  page?: BrowserTabSnapshot;
  detached: boolean;
  revision: number;
};
export type ReviewPanelTab = { id: "review"; type: "review" };
export type FilesPanelTab = { id: "files"; type: "files"; selectedPath?: string };
export type TerminalPanelTab = { id: "terminal"; type: "terminal" };
export type CapabilityPanelTab = { id: "skills"; type: "skills" } | { id: "mcp"; type: "mcp" };
/**
 * 侧边聊天（对齐 Codex 的 side chat）：声明式临时会话，可同主会话并开多个，
 * `ordinal` 是「侧边聊天 1/2/3」的编号（关闭后补最小空位，不重排已开的）；
 * `sourceSession` 记录发起时的主会话转录路径，`draft` 携带选中文本预填的草稿。
 */
export type SideChatPanelTab = { id: string; type: "side-chat"; ordinal: number; sourceSession?: string; draft?: string };
export type WorkbenchPanelTab =
  | ReviewPanelTab
  | FilesPanelTab
  | TerminalPanelTab
  | CapabilityPanelTab
  | SideChatPanelTab
  | BrowserPanelTab
  | ChildSessionPanelTab
  | FilePanelTab;

/**
 * 文件查看标签：过程区的读取/写入/编辑行点击时打开（对齐 ZCode 的 code viewer）。
 * 同一路径只开一个标签，再次点击激活已有的那个。
 */
export interface FilePanelTab {
  id: string;
  type: "file";
  path: string;
}

/**
 * 子代理子会话的只读标签：按父会话里的委派信息开标签，正文是子会话转录。
 * 同一 `path` 只开一个标签（再次点击激活已有的那个）。
 */
export interface ChildSessionPanelInfo {
  role: string;
  /**
   * 子会话转录文件（`~/.tacode/sessions/<delegationId>.jsonl`）。
   * 卡片入口与侧栏入口都会带上它；进程内委派没有文件，此时只有报告/活动流可看。
   */
  sessionPath?: string;
  /** 标签标题用（子会话标题/任务摘要），缺省回落到 role。 */
  title?: string;
  status?: string;
  startedAt?: number;
  completedAt?: number;
  toolCalls?: number;
  turns?: number;
  totalTokens?: number;
  /** 委派任务原文：面板顶部展示，比运行时注入的 prompt 更可读。 */
  task?: string;
  /** 运行中的当前步骤（对齐卡片上的 live 预览），表头实时显示执行进度。 */
  live?: string;
  uiRequest?: import("../../shared/types").ExtensionUiRequest;
  error?: string;
  /** 没有子会话转录（进程内委派）时的回退内容：最终报告 + 活动流。 */
  report?: string;
  activity?: Array<{ at: number; kind: string; text: string; isError?: boolean }>;
}

export interface ChildSessionPanelTab {
  id: string;
  type: "child-session";
  /**
   * 标签身份：**委派 id**（`delegation-<uuid>`）。主会话里的委派卡片与侧栏里的
   * 委派子会话是同一件事（前者 `task.id`、后者 `sourceDelegationId` 同值），
   * 用同一个 key 才能保证两处点到的是同一个标签页；没有 id 时退化为子会话路径。
   */
  key: string;
  info: ChildSessionPanelInfo;
}

/**
 * 标签身份推导：委派 id 与子会话文件（`<delegationId>.jsonl`）指向同一次委派，
 * 所以两个入口无论拿到哪一个都归到同一个 key——卡片可能只有 id、侧栏可能只有路径，
 * 只要有一边给得出，点到就是同一个标签页。
 */
export function delegationPanelKey(id?: string, sessionPath?: string): string {
  const trimmed = id?.trim();
  if (trimmed) return trimmed;
  const file = sessionPath?.trim();
  if (file) {
    const base = file.split(/[\\/]/).pop() ?? file;
    const name = base.replace(/\.jsonl$/i, "");
    if (name) return name;
  }
  return "";
}

export const filePanelId = (path: string): string => `file-${path}`;
export const filePanelLabel = (path: string): string => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
export const childSessionPanelId = (key: string): string => `child-session-${key}`;
export const createChildSessionPanel = (key: string, info: ChildSessionPanelInfo): ChildSessionPanelTab => ({
  id: childSessionPanelId(key),
  type: "child-session",
  key,
  info,
});
export type PanelState = {
  tabs: WorkbenchPanelTab[];
  active: string;
  /** 当前主会话（侧边聊天可见性跟着它走）。 */
  session?: string;
  /** 每个会话上次激活的标签 id（key 为会话路径，首页用空串）：切走时记录，切回时恢复。 */
  sessionActive: Record<string, string>;
};
export type PanelAction =
  | { type: "open-review" }
  | { type: "open-files"; path?: string }
  | { type: "open-terminal" }
  | { type: "open-skills" }
  | { type: "open-mcp" }
  | { type: "open-side-chat"; sourceSession?: string; draft?: string; activate?: boolean }
  | { type: "focus-side-chat" }
  | { type: "session-changed"; sourceSession?: string }
  | { type: "open-child-session"; panel: ChildSessionPanelTab; activate?: boolean }
  | { type: "open-file"; path: string; activate?: boolean }
  | { type: "open-browser"; tab: BrowserPanelTab; activate: boolean }
  | { type: "select"; id: string }
  | { type: "close"; id: string }
  | { type: "page"; id: string; page: BrowserTabSnapshot }
  | { type: "detach"; id: string; page: BrowserTabSnapshot }
  | { type: "window-closed"; id: string }
  | { type: "restore"; id: string; tabs: BrowserPanelTab[] };

export const initialPanelState: PanelState = { tabs: [{ id: "review", type: "review" }], active: "review", sessionActive: {} };

/** 会话记忆的 key：首页（无会话）用空串，和 undefined 区分开。 */
const sessionActiveKey = (session: string | undefined): string => session ?? "";

/** 侧边聊天只属于发起它的主会话：会话不匹配就在标签栏隐藏（组件保持挂载，切回即恢复）。 */
export const isSideChatVisible = (tab: WorkbenchPanelTab, session: string | undefined): boolean =>
  tab.type !== "side-chat" || tab.sourceSession === session;

/** 标签栏与面板主体应展示的标签（对侧边聊天按当前主会话过滤，其余类型全可见）。 */
export function visiblePanelTabs(state: PanelState): WorkbenchPanelTab[] {
  return state.tabs.filter((tab) => isSideChatVisible(tab, state.session));
}
export const createBrowserPanelId = (): string => `browser-${crypto.randomUUID()}`;
export const createBrowserPanel = (id: string, page?: BrowserTabSnapshot): BrowserPanelTab => ({
  id, type: "browser", initialTabs: page?.url ? [page] : undefined, page, detached: false, revision: 0,
});

/** 「侧边聊天 1/2/3」编号取当前未用的最小正整数（关闭中间的编号后新开补位，不重排已开的）。 */
export function nextSideChatOrdinal(tabs: WorkbenchPanelTab[]): number {
  const used = new Set(tabs.flatMap((tab) => tab.type === "side-chat" ? [tab.ordinal] : []));
  let ordinal = 1;
  while (used.has(ordinal)) ordinal += 1;
  return ordinal;
}

export const createSideChatPanelId = (): string => `side-chat-${crypto.randomUUID()}`;
export const createSideChatPanel = (ordinal: number, options?: { sourceSession?: string; draft?: string }): SideChatPanelTab => ({
  id: createSideChatPanelId(),
  type: "side-chat",
  ordinal,
  ...(options?.sourceSession ? { sourceSession: options.sourceSession } : {}),
  ...(options?.draft ? { draft: options.draft } : {}),
});

export function browserPanelLabel(page: BrowserTabSnapshot | undefined, fallback: string): string {
  if (page?.title.trim()) return page.title;
  try { return new URL(page?.url ?? "").hostname || fallback; } catch { return fallback; }
}

/** 子代理标签标题：优先委派任务摘要（两个入口都会带），再回落到标题/角色名/通用文案；等待确认时加后缀提醒。 */
export function childSessionPanelLabel(info: ChildSessionPanelInfo, fallback: string, waitingLabel?: string): string {
  const title = (info.task ?? info.title)?.replace(/\s+/g, " ").trim();
  const label = title || info.role.trim();
  const base = !label ? fallback : label.length > 28 ? `${label.slice(0, 27).trimEnd()}…` : label;
  return info.uiRequest && waitingLabel ? `${base} · ${waitingLabel}` : base;
}

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  const next = applyPanelAction(state, action);
  // session / sessionActive 只由 session-changed 维护；其余动作原样保留，避免每个分支都要记得带上。
  if (action.type === "session-changed") return next;
  const preserved = next.session === state.session && next.sessionActive === state.sessionActive;
  return preserved ? next : { ...next, session: state.session, sessionActive: state.sessionActive };
}

function applyPanelAction(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "open-review":
      return { tabs: state.tabs.some((tab) => tab.type === "review") ? state.tabs : [...state.tabs, { id: "review", type: "review" }], active: "review", session: state.session, sessionActive: state.sessionActive };
    case "open-files": {
      const existing = state.tabs.find((tab): tab is FilesPanelTab => tab.type === "files");
      if (existing) {
        return {
          tabs: action.path ? state.tabs.map((tab) => tab.id === existing.id ? { ...tab, selectedPath: action.path } : tab) : state.tabs,
          active: existing.id,
          session: state.session,
          sessionActive: state.sessionActive,
        };
      }
      return { tabs: [...state.tabs, { id: "files", type: "files", ...(action.path ? { selectedPath: action.path } : {}) }], active: "files", session: state.session, sessionActive: state.sessionActive };
    }
    case "open-terminal":
      return { tabs: state.tabs.some((tab) => tab.type === "terminal") ? state.tabs : [...state.tabs, { id: "terminal", type: "terminal" }], active: "terminal", session: state.session, sessionActive: state.sessionActive };
    case "open-skills":
      return { ...state, tabs: state.tabs.some((tab) => tab.type === "skills") ? state.tabs : [...state.tabs, { id: "skills", type: "skills" }], active: "skills" };
    case "open-mcp":
      return { ...state, tabs: state.tabs.some((tab) => tab.type === "mcp") ? state.tabs : [...state.tabs, { id: "mcp", type: "mcp" }], active: "mcp" };
    case "open-side-chat": {
      // 侧边聊天是多实例（Codex 模式）：每次 open 都新建编号标签，按 id 而非类型去重；
      // 来源未显式给出时锚定当前主会话，保证可见性跟随会话切换。
      const tab = createSideChatPanel(nextSideChatOrdinal(state.tabs), {
        sourceSession: action.sourceSession ?? state.session,
        draft: action.draft,
      });
      return { tabs: [...state.tabs, tab], active: action.activate === false ? state.active : tab.id, session: state.session, sessionActive: state.sessionActive };
    }
    case "focus-side-chat": {
      // 快捷键语义：当前会话已有侧边聊天时聚焦最新一个，一个都没有才新建（避免连按爆标签）。
      const existing = state.tabs.filter((tab) => isSideChatVisible(tab, state.session));
      if (existing.length > 0) return { ...state, active: existing[existing.length - 1].id, session: state.session };
      const tab = createSideChatPanel(nextSideChatOrdinal(state.tabs), { sourceSession: state.session });
      return { tabs: [...state.tabs, tab], active: tab.id, session: state.session, sessionActive: state.sessionActive };
    }
    case "session-changed": {
      if (state.session === action.sourceSession) return state;
      // 只切换「当前主会话」上下文：别的会话的侧边聊天从标签栏隐藏但保持挂载，
      // 切回来原样恢复；只有手动关闭（带确认）或退出应用才真正销毁。
      const isVisible = (tab: WorkbenchPanelTab) => isSideChatVisible(tab, action.sourceSession);
      // 每个会话记住自己上次的激活标签：离开时记录当前激活，回来时优先恢复记忆；
      // 记忆的标签已被关闭时，回落到新上下文里离它最近的可见标签。
      const sessionActive = { ...state.sessionActive, [sessionActiveKey(state.session)]: state.active };
      const remembered = sessionActive[sessionActiveKey(action.sourceSession)];
      const rememberedTab = remembered ? state.tabs.find((tab) => tab.id === remembered && isVisible(tab)) : undefined;
      let active: string;
      if (rememberedTab) {
        active = rememberedTab.id;
      } else {
        const current = state.tabs.find((tab) => tab.id === state.active);
        if (current && isVisible(current)) {
          active = current.id;
        } else {
          const index = current ? state.tabs.indexOf(current) : state.tabs.length;
          const previous = [...state.tabs.slice(0, index)].reverse().find(isVisible);
          active = (previous ?? state.tabs.find(isVisible))?.id ?? "";
        }
      }
      return { tabs: state.tabs, active, session: action.sourceSession, sessionActive };
    }
    case "open-child-session": {
      // 同一委派只开一个标签：再次点击时合并信息（两个入口掌握的信息不同，不能互相覆盖）
      // 并激活已有标签。
      const existing = state.tabs.find(
        (tab): tab is ChildSessionPanelTab => tab.type === "child-session" && tab.key === action.panel.key,
      );
      if (existing) {
        const merged: ChildSessionPanelTab = { ...existing, info: { ...existing.info, ...action.panel.info } };
        return {
          tabs: state.tabs.map((tab) => tab.id === existing.id ? merged : tab),
          // 实时刷新（activate=false）不抢焦点：用户在看别的标签时不该被顶走。
          active: action.activate === false ? state.active : existing.id,
          session: state.session,
          sessionActive: state.sessionActive,
        };
      }
      // 自动开标签时抢焦点；后台更新（activate=false）只建标签不切换。
      return { tabs: [...state.tabs, action.panel], active: action.activate === false ? state.active : action.panel.id, session: state.session, sessionActive: state.sessionActive };
    }
    case "open-file": {
      const id = filePanelId(action.path);
      const exists = state.tabs.some((tab) => tab.id === id);
      if (exists) return { ...state, active: action.activate === false ? state.active : id };
      return { tabs: [...state.tabs, { id, type: "file", path: action.path }], active: action.activate === false ? state.active : id, session: state.session, sessionActive: state.sessionActive };
    }
    case "open-browser":
      return {
        tabs: state.tabs.some((tab) => tab.id === action.tab.id) ? state.tabs : [...state.tabs, action.tab],
        active: action.activate ? action.tab.id : state.active,
        session: state.session,
        sessionActive: state.sessionActive,
      };
    case "select":
      return state.tabs.some((tab) => tab.id === action.id) ? { ...state, active: action.id } : state;
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      return {
        tabs,
        active: state.active === action.id ? (tabs[index - 1] ?? tabs[index])?.id ?? "" : state.active,
        session: state.session,
        sessionActive: state.sessionActive,
      };
    }
    case "page":
    case "detach":
    case "window-closed": {
      const tab = state.tabs.find((tab) => tab.id === action.id);
      if (!tab || tab.type !== "browser") return state;
      let next: BrowserPanelTab;
      if (action.type === "page") {
        if (tab.detached || (tab.page?.url === action.page.url && tab.page?.title === action.page.title)) return state;
        next = { ...tab, page: action.page };
      } else if (action.type === "detach") {
        next = { ...tab, page: action.page, initialTabs: [action.page], detached: true };
      } else {
        // 还原广播先到，随后原独立窗口关闭；不得覆盖已经还原的页面。
        if (!tab.detached) return state;
        next = { ...tab, detached: false };
      }
      return { ...state, tabs: state.tabs.map((tab) => tab.id === action.id ? next : tab) };
    }
    case "restore": {
      if (action.tabs.length === 0) return state;
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      const old = state.tabs[index];
      const restored = action.tabs.map((tab, i) => i === 0 ? { ...tab, revision: old?.type === "browser" ? old.revision + 1 : 0 } : tab);
      const tabs = [...state.tabs];
      // 第一页复用原实例的位置，其他页面依次放在它右侧。
      tabs.splice(index < 0 ? tabs.length : index, index < 0 ? 0 : 1, ...restored);
      return { tabs, active: restored[0].id, session: state.session, sessionActive: state.sessionActive };
    }
  }
}
