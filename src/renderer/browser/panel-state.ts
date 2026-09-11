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
export type WorkbenchPanelTab =
  | { id: string; type: "inspect" }
  | BrowserPanelTab
  | ChildSessionPanelTab;

/**
 * 子代理子会话的只读标签：按父会话里的委派信息开标签，正文是子会话转录。
 * 同一 `path` 只开一个标签（再次点击激活已有的那个）。
 */
export interface ChildSessionPanelInfo {
  role: string;
  /**
   * 子会话转录文件（`~/.tether/sessions/<delegationId>.jsonl`）。
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

export const childSessionPanelId = (key: string): string => `child-session-${key}`;
export const createChildSessionPanel = (key: string, info: ChildSessionPanelInfo): ChildSessionPanelTab => ({
  id: childSessionPanelId(key),
  type: "child-session",
  key,
  info,
});
export type PanelState = { tabs: WorkbenchPanelTab[]; active: string };
export type PanelAction =
  | { type: "open-inspect" }
  | { type: "open-child-session"; panel: ChildSessionPanelTab; activate?: boolean }
  | { type: "open-browser"; tab: BrowserPanelTab; activate: boolean }
  | { type: "select"; id: string }
  | { type: "close"; id: string }
  | { type: "page"; id: string; page: BrowserTabSnapshot }
  | { type: "detach"; id: string; page: BrowserTabSnapshot }
  | { type: "window-closed"; id: string }
  | { type: "restore"; id: string; tabs: BrowserPanelTab[] };

export const initialPanelState: PanelState = { tabs: [{ id: "inspect", type: "inspect" }], active: "inspect" };
export const createBrowserPanelId = (): string => `browser-${crypto.randomUUID()}`;
export const createBrowserPanel = (id: string, page?: BrowserTabSnapshot): BrowserPanelTab => ({
  id, type: "browser", initialTabs: page?.url ? [page] : undefined, page, detached: false, revision: 0,
});

export function browserPanelLabel(page: BrowserTabSnapshot | undefined, fallback: string): string {
  if (page?.title.trim()) return page.title;
  try { return new URL(page?.url ?? "").hostname || fallback; } catch { return fallback; }
}

/** 子代理标签标题：优先委派任务摘要（两个入口都会带），再回落到标题/角色名/通用文案。 */
export function childSessionPanelLabel(info: ChildSessionPanelInfo, fallback: string): string {
  const title = (info.task ?? info.title)?.replace(/\s+/g, " ").trim();
  const label = title || info.role.trim();
  if (!label) return fallback;
  return label.length > 28 ? `${label.slice(0, 27).trimEnd()}…` : label;
}

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "open-inspect":
      return { tabs: state.tabs.some((tab) => tab.type === "inspect") ? state.tabs : [...state.tabs, { id: "inspect", type: "inspect" }], active: "inspect" };
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
        };
      }
      // 自动开标签时抢焦点；后台更新（activate=false）只建标签不切换。
      return { tabs: [...state.tabs, action.panel], active: action.activate === false ? state.active : action.panel.id };
    }
    case "open-browser":
      return {
        tabs: state.tabs.some((tab) => tab.id === action.tab.id) ? state.tabs : [...state.tabs, action.tab],
        active: action.activate ? action.tab.id : state.active,
      };
    case "select":
      return state.tabs.some((tab) => tab.id === action.id) ? { ...state, active: action.id } : state;
    case "close": {
      const index = state.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.id);
      return { tabs, active: state.active === action.id ? (tabs[index - 1] ?? tabs[index])?.id ?? "" : state.active };
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
      return { tabs, active: restored[0].id };
    }
  }
}
