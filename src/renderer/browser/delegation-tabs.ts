/**
 * 子代理标签的自动开合策略（纯函数，便于单测）。
 *
 * 对齐 Proma 的行为：父代理**创建子代理**时就自动在右侧面板开一个标签，让用户能实时看到
 * 执行过程；而不是等用户去点卡片。TACode 的对应「启动事件」是父会话里出现的 delegate 工具
 * 条目（渲染层通过 tool_execution_start/update 推送拿到），后台会话的事件本就不会进入当前
 * messages，所以天然满足 Proma 那条「父会话必须在前台」的闸门。
 */

import { delegateProgress, sessionTools, type ChatMessage } from "../conversation";
import { delegationPanelKey, type ChildSessionPanelInfo } from "./panel-state";
import type { DelegationRecordSnapshot, DelegationStatus } from "../../shared/delegation";

/** 从当前会话里抽出的委派摘要（只保留面板需要的字段）。 */
export interface DelegationSummary {
  id?: string;
  role: string;
  task: string;
  status: DelegationStatus;
  /** 有子会话文件才可能自动开面板（进程内委派没有文件）。 */
  childSessionPath?: string;
  live?: string;
  toolCalls?: number;
  turns?: number;
  totalTokens?: number;
  startedAt?: number;
  completedAt?: number;
  report?: string;
  error?: string;
  uiRequest?: ChildSessionPanelInfo["uiRequest"];
  mayAutoOpen?: boolean;
}

/** 运行时快照覆盖父工具的启动快照；后台会话只更新已有标签，不抢焦点。 */
export function mergeDelegationSummaries(
  summaries: DelegationSummary[],
  records: ReadonlyMap<string, DelegationRecordSnapshot>,
  parentSessionPath: string | undefined,
  openKeys: ReadonlySet<string>,
): DelegationSummary[] {
  const merged = new Map(summaries.map((item) => [delegationPanelKey(item.id, item.childSessionPath), item]));
  for (const record of records.values()) {
    const key = record.delegationId;
    const current = merged.get(key);
    const belongsToCurrent = record.parentSessionPath === parentSessionPath;
    if (!current && !belongsToCurrent && !openKeys.has(key)) continue;
    merged.set(key, {
      ...current,
      id: key, role: record.role, task: record.task, status: record.status,
      childSessionPath: record.childSessionPath,
      startedAt: record.startedAt, completedAt: record.completedAt,
      live: record.live, report: record.report, error: record.error, uiRequest: record.uiRequest,
      mayAutoOpen: belongsToCurrent,
    });
  }
  return [...merged.values()];
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
  /** 已经提醒过的审批请求 id：同一个请求只抢一次焦点，应答后不再重开标签。 */
  attentionSeen?: ReadonlySet<string>;
}): { requests: DelegationTabRequest[]; autoOpened: string[]; /** 本次新出现的审批请求 id（调用方负责记入 attentionSeen）。 */ attention: string[] } {
  const requests: DelegationTabRequest[] = [];
  const autoOpened: string[] = [];
  const attention: string[] = [];
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
      live: item.live,
      report: item.report,
      error: item.error,
      uiRequest: item.uiRequest,
      ...(item.toolCalls !== undefined ? { toolCalls: item.toolCalls } : {}),
      ...(item.turns !== undefined ? { turns: item.turns } : {}),
      ...(item.totalTokens !== undefined ? { totalTokens: item.totalTokens } : {}),
      ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
      completedAt: item.completedAt,
    };
    // 新的审批请求必须被看见：子代理会停在等待上直到用户应答，标签没开着也要重开并抢焦点。
    const running = item.status === "pending" || item.status === "running";
    const requestId = item.uiRequest?.id;
    const urgent = Boolean(running && requestId && !input.attentionSeen?.has(requestId));
    if (urgent && requestId) attention.push(requestId);
    if (!input.autoOpenedKeys.has(key)) {
      autoOpened.push(key);
      if (input.openKeys.has(key)) {
        requests.push({ key, info, activate: urgent });
        continue;
      }
      // 历史委派（重开会话时见到的已完成条目）不自动弹标签，避免一次开一堆。
      if (urgent || (item.mayAutoOpen !== false && running)) {
        requests.push({ key, info, activate: true });
      }
      continue;
    }
    // 用户手动关掉后不再自动开；只刷新还开着的那个标签（审批例外：重开并抢焦点）。
    if (input.openKeys.has(key)) requests.push({ key, info, activate: urgent });
    else if (urgent) requests.push({ key, info, activate: true });
  }
  return { requests, autoOpened, attention };
}
