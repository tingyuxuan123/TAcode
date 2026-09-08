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
export type WorkbenchPanelTab = { id: string; type: "inspect" } | BrowserPanelTab;
export type PanelState = { tabs: WorkbenchPanelTab[]; active: string };
export type PanelAction =
  | { type: "open-inspect" }
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

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case "open-inspect":
      return { tabs: state.tabs.some((tab) => tab.type === "inspect") ? state.tabs : [...state.tabs, { id: "inspect", type: "inspect" }], active: "inspect" };
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
