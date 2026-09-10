import type { SessionSummary } from "../shared/types";

export interface SessionTreeItem {
  session: SessionSummary;
  /** 委派产生的子会话（嵌套展示在该会话下，Proma 式分组）。 */
  children: SessionSummary[];
}

/**
 * 把项目下的会话组织成树：委派子会话（带 sourceDelegationId）嵌套到其父会话
 * （parentSessionPath 对得上）下；父会话不在当前列表（已归档/已删除）时保持
 * 原来的平铺位置，避免入口丢失。子 worker 不再递归委派（depth=1），树只有一层。
 */
export function groupDelegatedSessions(threads: readonly SessionSummary[]): SessionTreeItem[] {
  const byPath = new Map(threads.map((session) => [session.path, session]));
  const items = new Map<string, SessionTreeItem>(
    threads.map((session) => [session.id, { session, children: [] }]),
  );
  const roots: SessionTreeItem[] = [];
  for (const session of threads) {
    const item = items.get(session.id);
    if (!item) continue;
    const parent = session.sourceDelegationId && session.parentSessionPath
      ? byPath.get(session.parentSessionPath)
      : undefined;
    const parentItem = parent ? items.get(parent.id) : undefined;
    if (parentItem && parentItem.session.id !== session.id) parentItem.children.push(session);
    else roots.push(item);
  }
  return roots;
}

/** 分支是否应自动展开：父会话活跃，或任一子会话活跃/运行中。 */
export function branchAutoExpanded(input: {
  children: readonly SessionSummary[];
  isActive(session: SessionSummary): boolean;
  isRunning(session: SessionSummary): boolean;
  isParentActive(): boolean;
}): boolean {
  if (input.isParentActive()) return true;
  return input.children.some((child) => input.isActive(child) || input.isRunning(child));
}
