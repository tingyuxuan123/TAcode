import { expect, it } from "vitest";
import type { AgentSessionActivity, SessionSummary } from "../shared/types";
import { normalizeMessages } from "./conversation";
import { matchesSession, searchConversation } from "./session-search";

it("narrows 1000 sessions by Chinese title, project path and persistent status", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), title: i === 2 || i === 900 ? "中文复盘" : `会话 ${i}`, cwd: i > 500 ? "/work/mobile" : "/work/desktop", path: `/s/${i}.jsonl` } as SessionSummary));
  expect(rows.filter(row => matchesSession(row, "中文复盘", "all")).map(row => row.id)).toEqual(["2", "900"]);
  expect(rows.filter(row => matchesSession(row, "中文复盘", "all") && matchesSession(row, "mobile", "all")).map(row => row.id)).toEqual(["900"]);
  const waiting = { running: true, pendingRequests: [{ id: "confirm" }], status: "waiting" } as AgentSessionActivity;
  expect(matchesSession(rows[2], "复盘", "waiting", waiting)).toBe(true);
  expect(matchesSession(rows[2], "复盘", "failed", waiting)).toBe(false);
  expect(matchesSession(rows[2], "复盘", "waiting", undefined, false, "", true)).toBe(true);
  expect(matchesSession(rows[900], "MOBILE", "running", undefined, true)).toBe(true);
});

it("searches offscreen history, thinking and tool text without mutating or trimming messages", () => {
  const messages = normalizeMessages(Array.from({ length: 2000 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: i === 4 || i === 1803 ? `完整的中文结论 ${i}` : `内容 ${i}` })));
  messages[20] = { ...messages[20], thinking: "折叠思考里的中文结论" };
  messages[30] = { ...messages[30], tools: [{ id: "t", name: "read_file", title: "读取", status: "complete", output: "文件里的中文结论" }] };
  const result = searchConversation(messages, "中文结论");
  expect(result.map(row => row.id)).toEqual([messages[4].id, messages[20].id, messages[30].id, messages[1803].id]);
  expect(result.map(row => row.section)).toEqual(["text", "thinking", "tool", "text"]);
  expect(searchConversation(messages, "不存在")).toEqual([]);
  expect(searchConversation(messages, "  ")).toEqual([]);
  expect(messages).toHaveLength(2000);
});
