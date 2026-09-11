import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { ChildSessionPanelInfo } from "./browser/panel-state";

/**
 * 面板操作上下文。
 *
 * 委派卡片（`DelegateDetail`）在 `ui.tsx` 里由模块级 `renderTool` 渲染，拿不到 App 的
 * props；用 context 把「打开子代理标签」这一动作透进去，避免改动整条 renderTool 签名。
 */
export interface PanelActions {
  /** 打开某个子代理子会话的只读标签（同一 path 复用已有标签）。 */
  openChildSession?(path: string, info: ChildSessionPanelInfo): void;
}

const PanelActionsContext = createContext<PanelActions>({});

export function PanelActionsProvider({ actions, children }: { actions: PanelActions; children: ReactNode }) {
  const value = useMemo(() => actions, [actions.openChildSession]);
  return <PanelActionsContext.Provider value={value}>{children}</PanelActionsContext.Provider>;
}

export function usePanelActions(): PanelActions {
  return useContext(PanelActionsContext);
}
