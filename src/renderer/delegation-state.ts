import { isDelegationTerminal, type DelegationRecordSnapshot } from "../shared/delegation";
import type { SessionSummary } from "../shared/types";
import { delegateToolTitle, type ChatMessage, type ToolActivity } from "./conversation";

export type DelegationRecords = ReadonlyMap<string, DelegationRecordSnapshot>;

/** 协调器快照优先于磁盘列表；较早发出的 list 响应不能把终态改回 running。 */
export function reconcileDelegationSessions(sessions: SessionSummary[], records: DelegationRecords): SessionSummary[] {
  return sessions.map((session) => {
    const record = session.sourceDelegationId ? records.get(session.sourceDelegationId) : undefined;
    if (!record) return session;
    return { ...session, delegationStatus: record.status, delegationReport: record.report, delegationError: record.error };
  });
}

const messageCache = new WeakMap<ChatMessage, { records: DelegationRecords; result: ChatMessage }>();
const lifecycleTools = new Set(["delegate", "delegate_wait", "delegate_list", "delegate_stop", "delegate_continue"]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** 只校正界面的委派元数据，不改模型会话或历史工具输出。保留未变消息的引用供分组缓存复用。 */
export function reconcileDelegationMessages(messages: ChatMessage[], records: DelegationRecords): ChatMessage[] {
  if (!records.size) return messages;
  return messages.map((message) => {
    const cached = messageCache.get(message);
    if (cached?.records === records) return cached.result;
    const tools = message.tools.map((tool) => reconcileTool(tool, records));
    const changed = tools.some((tool, index) => tool !== message.tools[index]);
    const result = changed ? { ...message, tools } : message;
    messageCache.set(message, { records, result });
    return result;
  });
}

function reconcileTool(tool: ToolActivity, records: DelegationRecords): ToolActivity {
  if (!lifecycleTools.has(tool.name) || !isRecord(tool.details)) return tool;
  let changed = false;
  const details = { ...tool.details };
  for (const key of ["tasks", "delegations", "stopped"]) {
    const entries = details[key];
    if (!Array.isArray(entries)) continue;
    details[key] = entries.map((entry: unknown) => {
      if (!isRecord(entry)) return entry;
      const id = entry.delegationId ?? entry.id;
      const record = typeof id === "string" ? records.get(id) : undefined;
      if (!record) return entry;
      if (["status", "completedAt", "startedAt", "report", "error", "live"].every((field) => entry[field] === record[field as keyof DelegationRecordSnapshot])) return entry;
      changed = true;
      return { ...entry, ...record, id: record.delegationId, completedAt: record.completedAt, report: record.report, error: record.error, live: record.live };
    });
  }
  if (!changed) return tool;
  if (Array.isArray(details.tasks)) {
    details.done = details.tasks.filter((entry: unknown) => isRecord(entry) && isDelegationTerminal(entry.status as DelegationRecordSnapshot["status"])).length;
  }
  return { ...tool, details, ...(tool.name === "delegate" ? { title: delegateToolTitle({ ...tool, details }) } : {}) };
}
