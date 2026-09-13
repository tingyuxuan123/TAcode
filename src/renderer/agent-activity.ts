import type { AgentSessionActivity } from "../shared/types";

/** 列表快照、打开会话的快照与实时状态共用版本对账，旧 worker 不能覆盖新 worker。 */
export function mergeAgentActivity(
  current: ReadonlyMap<string, AgentSessionActivity>,
  activity: AgentSessionActivity,
): ReadonlyMap<string, AgentSessionActivity> {
  const key = activity.sessionPath ?? activity.runtimeId;
  const previous = current.get(key);
  if (previous && previous.version >= activity.version) return current;
  const next = new Map(current);
  if (activity.sessionPath) next.delete(activity.runtimeId);
  next.set(key, activity);
  return next;
}
