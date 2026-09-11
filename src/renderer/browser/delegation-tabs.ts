/**
 * 子代理标签的自动开合策略（纯函数，便于单测）。
 *
 * 对齐 Proma 的行为：父代理**创建子代理**时就自动在右侧面板开一个标签，让用户能实时看到
 * 执行过程；而不是等用户去点卡片。TACode 的对应「启动事件」是父会话里出现的 delegate 工具
 * 条目（渲染层通过 tool_execution_start/update 推送拿到），后台会话的事件本就不会进入当前
 * messages，所以天然满足 Proma 那条「父会话必须在前台」的闸门。
 */

import { delegateProgress, sessionTools, type ChatMessage, type DelegateTaskStatus } from "../conversation";
import { delegationPanelKey, type ChildSessionPanelInfo } from "./panel-state";

/** 从当前会话里抽出的委派摘要（只保留面板需要的字段）。 */
export interface DelegationSummary {
  id?: string;
  role: string;
  task: string;
  status: DelegateTaskStatus;
  /** 有子会话文件才可能自动开面板（进程内委派没有文件）。 */
  childSessionPath?: string;
  live?: string;
  toolCalls?: number;
  turns?: number;
  totalTokens?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface DelegationTabRequest {
  key: string;
  info: ChildSessionPanelInfo;
  /** 首次出现时抢焦点（Proma 也是直接激活），后续实时刷新不抢。 */
  activate: boolean;
}

const TITLE_CHARS = 60;

/** 当前会话里所有委派子任务（按出现顺序，重复的委派 id 只留最后状态）。 */
export function collectDelegations(messages: ChatMessage[]): DelegationSummary[] {
  const tools = sessionTools(messages);
  const byKey = new Map<string, DelegationSummary>();
  for (const tool of tools) {
    if (tool.name !== "delegate") continue;
    for (const task of delegateProgress(tool, tools).tasks) {
      const summary: DelegationSummary = {
        ...(task.id ? { id: task.id } : {}),
        role: task.role,
        task: task.task,
        status: task.status,
        ...(task.childSessionPath ? { childSessionPath: task.childSessionPath } : {}),
        ...(task.live ? { live: task.live } : {}),
        ...(task.toolCalls !== undefined ? { toolCalls: task.toolCalls } : {}),
        ...(task.turns !== undefined ? { turns: task.turns } : {}),
        ...(task.usage?.totalTokens !== undefined ? { totalTokens: task.usage.totalTokens } : {}),
        ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
        ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
      };
      const key = delegationPanelKey(summary.id, summary.childSessionPath);
      byKey.set(key || `${summary.role}-${byKey.size}`, summary);
    }
  }
  return [...byKey.values()];
}

/** 待开的标签：首次出现且**正在执行**才自动打开；已开的标签只做实时刷新、不抢焦点。 */
export function planDelegationTabs(input: {
  delegations: readonly DelegationSummary[];
  openKeys: ReadonlySet<string>;
  autoOpenedKeys: ReadonlySet<string>;
}): { requests: DelegationTabRequest[]; autoOpened: string[] } {
  const requests: DelegationTabRequest[] = [];
  const autoOpened: string[] = [];
  for (const item of input.delegations) {
    if (!item.childSessionPath) continue;
    const key = delegationPanelKey(item.id, item.childSessionPath);
    if (!key) continue;
    const info: ChildSessionPanelInfo = {
      role: item.role,
      title: item.task.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS),
      task: item.task,
      sessionPath: item.childSessionPath,
      status: item.status,
      ...(item.live ? { live: item.live } : {}),
      ...(item.toolCalls !== undefined ? { toolCalls: item.toolCalls } : {}),
      ...(item.turns !== undefined ? { turns: item.turns } : {}),
      ...(item.totalTokens !== undefined ? { totalTokens: item.totalTokens } : {}),
      ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
      ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
    };
    if (!input.autoOpenedKeys.has(key)) {
      autoOpened.push(key);
      // 历史委派（重开会话时见到的已完成条目）不自动弹标签，避免一次开一堆。
      if (item.status === "pending" || item.status === "running") {
        requests.push({ key, info, activate: true });
      }
      continue;
    }
    // 用户手动关掉后不再自动开；只刷新还开着的那个标签。
    if (input.openKeys.has(key)) requests.push({ key, info, activate: false });
  }
  return { requests, autoOpened };
}
