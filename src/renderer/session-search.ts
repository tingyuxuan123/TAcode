import type { AgentSessionActivity, SessionSummary } from "../shared/types";
import type { ChatMessage } from "./conversation";

export type SessionFilter = "all" | "running" | "waiting" | "failed";

export function matchesSession(session: SessionSummary, query: string, status: SessionFilter, activity?: AgentSessionActivity, running = false, projectName = "", waiting = false): boolean {
  const needle = query.toLocaleLowerCase().trim();
  const text = `${session.title}\n${session.cwd}\n${projectName}\n${session.preview ?? ""}`.toLocaleLowerCase();
  if (!text.includes(needle)) return false;
  if (status === "waiting") return waiting || Boolean(activity?.pendingRequests.length);
  if (status === "running") return activity?.running ?? (running || session.delegationStatus === "running" || session.delegationStatus === "pending");
  if (status === "failed") return activity?.status === "failed" || session.delegationStatus === "failed" || session.delegationStatus === "interrupted";
  return true;
}

export interface ConversationMatch { id: string; before: string; match: string; after: string; section: "text" | "thinking" | "tool" }
const searchText = new WeakMap<ChatMessage, Array<{ text: string; lower: string; section: ConversationMatch["section"] }>>();

/** 按消息返回匹配，包含折叠的思考和工具内容；未挂载的消息使用相同的数据路径。 */
export function searchConversation(messages: ChatMessage[], query: string): ConversationMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const results: ConversationMatch[] = [];
  for (const message of messages) {
    let fields = searchText.get(message);
    if (!fields) {
      fields = [
        { section: "text" as const, text: message.text },
        { section: "thinking" as const, text: message.thinking ?? "" },
        ...message.tools.map(tool => ({ section: "tool" as const, text: `${tool.title}\n${tool.output ?? ""}\n${tool.args ? JSON.stringify(tool.args) : ""}` })),
      ].filter(field => field.text).map(field => ({ ...field, lower: field.text.toLocaleLowerCase() }));
      searchText.set(message, fields);
    }
    for (const field of fields) {
      const offset = field.lower.indexOf(needle);
      if (offset < 0) continue;
      results.push({ id: message.id, section: field.section, before: field.text.slice(Math.max(0, offset - 45), offset), match: field.text.slice(offset, offset + needle.length), after: field.text.slice(offset + needle.length, offset + needle.length + 90) });
      break;
    }
  }
  return results;
}
