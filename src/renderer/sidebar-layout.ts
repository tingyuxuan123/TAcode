import { useCallback, useEffect, useReducer } from "react";

const SIDEBAR_COLLAPSED_KEY = "tacode.sidebarCollapsed";

interface SidebarLayoutState {
  manualCollapsed: boolean;
  autoCollapsed: boolean;
}

type SidebarLayoutAction = "toggle" | "auto-collapse";

export function sidebarLayoutReducer(state: SidebarLayoutState, action: SidebarLayoutAction): SidebarLayoutState {
  const collapsed = state.manualCollapsed || state.autoCollapsed;
  if (action === "toggle") return { manualCollapsed: !collapsed, autoCollapsed: false };
  return collapsed ? state : { ...state, autoCollapsed: true };
}

function initialSidebarLayout(): SidebarLayoutState {
  let manualCollapsed = false;
  try { manualCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"; } catch { /* Storage may be unavailable. */ }
  return { manualCollapsed, autoCollapsed: false };
}

/** 自动收起持续到用户手动展开；只记住手动选择，避免动画中的测量变化触发反复开合。 */
export function useSidebarLayout() {
  const [state, dispatch] = useReducer(sidebarLayoutReducer, undefined, initialSidebarLayout);
  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(state.manualCollapsed)); } catch { /* Storage may be unavailable. */ }
  }, [state.manualCollapsed]);
  const toggle = useCallback(() => dispatch("toggle"), []);
  const collapseAutomatically = useCallback(() => dispatch("auto-collapse"), []);
  return { collapsed: state.manualCollapsed || state.autoCollapsed, toggle, collapseAutomatically };
}
