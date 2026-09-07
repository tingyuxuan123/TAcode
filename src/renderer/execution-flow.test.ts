import { describe, expect, it } from "vitest";
import { applyAgentEvent, buildTurnPresentation, failActiveTurn, groupConversation, normalizeMessages, settleStoppedTurn, type ChatMessage } from "./conversation";

const assistant = (content: unknown[]) => ({ role: "assistant", content });
const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string) => ({ type: "thinking", thinking: value });
const tool = (id: string) => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } });

describe("execution flow presentation", () => {
  it("replaces a revised snapshot without exposing the discarded draft", () => {
    let messages = applyAgentEvent([], { type: "message_start", message: assistant([text("draft")]) });
    const id = buildTurnPresentation(messages).reply[0]!.id;
    messages = applyAgentEvent(messages, { type: "message_end", message: assistant([text("final")]) });
    expect(buildTurnPresentation(messages).replyText).toBe("final");
    expect(buildTurnPresentation(messages).reply[0]?.id).toBe(id);
  });

  it("keeps separate content blocks even when their text overlaps", () => {
    const messages = applyAgentEvent([], { type: "message_start", message: assistant([text("one"), text("one more")]) });
    expect(buildTurnPresentation(messages).replyText).toBe("one\n\none more");
  });

  it("does not relabel a naturally completed response after a late abort response", () => {
    const messages = applyAgentEvent([], { type: "message_end", message: { ...assistant([text("done")]), stopReason: "stop" } });
    expect(settleStoppedTurn(messages).at(-1)?.interrupted).not.toBe(true);
  });

  it("leaves a local interrupted status when stopped before the first assistant token", () => {
    const messages = normalizeMessages([{ role: "user", content: [text("hello")] }]);
    expect(settleStoppedTurn(messages).at(-1)).toMatchObject({ role: "assistant", interrupted: true, text: "" });
  });

  it("keeps host errors visible alongside partial output", () => {
    const messages = applyAgentEvent([], { type: "message_update", message: assistant([text("partial")]) });
    const failed = failActiveTurn(messages, "connection closed");
    expect(failed.at(-1)).toMatchObject({ text: "partial", error: "connection closed", interrupted: true, streaming: false });
  });

  it("restores explicit aborted model messages from history", () => {
    const messages = normalizeMessages([{ ...assistant([text("partial")]), stopReason: "aborted" }]);
    expect(messages[0]?.interrupted).toBe(true);
  });

  it("separates thinking, progress and consecutive trailing text", () => {
    const view = buildTurnPresentation(normalizeMessages([assistant([
      thinking("inspect"), text("reading"), tool("a"), text("done"), text("verified"),
    ])]));
    expect(view.process.map((item) => item.type)).toEqual(["thinking", "text", "tool"]);
    expect(view.replyText).toBe("done\n\nverified");
    expect(view.tools).toHaveLength(1);
  });

  it("does not promote narration preceding a tool to the final reply", () => {
    const view = buildTurnPresentation(normalizeMessages([assistant([text("reading"), tool("a")])]));
    expect(view.replyText).toBe("");
    expect(view.process.map((item) => item.type)).toEqual(["text", "tool"]);
  });

  it("does not create a process group for a plain reply", () => {
    const view = buildTurnPresentation(normalizeMessages([assistant([text("hello")])]));
    expect(view.process).toEqual([]);
    expect(view.replyText).toBe("hello");
  });

  it("keeps repeated narration in separate model messages and stable identities", () => {
    let messages: ChatMessage[] = [];
    messages = applyAgentEvent(messages, { type: "message_start", message: assistant([text("checking")]) });
    const firstId = buildTurnPresentation(messages).reply[0]!.id;
    messages = applyAgentEvent(messages, { type: "tool_execution_start", toolCallId: "a", toolName: "read" });
    messages = applyAgentEvent(messages, { type: "message_start", message: assistant([text("checking")]) });
    messages = applyAgentEvent(messages, { type: "message_update", message: assistant([text("checking again")]) });
    const view = buildTurnPresentation(messages);
    expect(view.process[0]).toMatchObject({ id: firstId, type: "text", text: "checking" });
    expect(view.replyText).toBe("checking again");
    expect(new Set(view.items.map((item) => item.id)).size).toBe(view.items.length);
  });

  it("matches live and stored content order without requiring the same runtime ids", () => {
    let live = applyAgentEvent([], { type: "message_start", message: assistant([thinking("inspect"), text("reading"), tool("a")]) });
    live = applyAgentEvent(live, { type: "tool_execution_start", toolCallId: "a", toolName: "read" });
    live = applyAgentEvent(live, { type: "tool_execution_end", toolCallId: "a", toolName: "read", result: "ok" });
    live = applyAgentEvent(live, { type: "message_start", message: assistant([thinking("verify"), text("done")]) });
    const stored = normalizeMessages([
      assistant([thinking("inspect"), text("reading"), tool("a")]),
      { role: "toolResult", toolCallId: "a", content: [text("ok")] },
      assistant([thinking("verify"), text("done")]),
    ]);
    const content = (messages: ChatMessage[]) => buildTurnPresentation(messages).items.map((item) => item.type === "tool" ? item.toolId : [item.type, item.text]);
    expect(content(live)).toEqual(content(stored));
  });

  it("distinguishes missing history results from completed tools", () => {
    const view = buildTurnPresentation(normalizeMessages([
      assistant([tool("a"), tool("b")]),
      { role: "toolResult", toolCallId: "b", content: [text("ok")] },
    ]));
    expect(view.tools[0]?.resultRecorded).toBe(false);
    expect(view.tools[1]?.resultRecorded).toBe(true);
  });

  it("preserves the start time while parallel tools complete out of order", () => {
    let messages = applyAgentEvent([], { type: "tool_execution_start", toolCallId: "a", toolName: "read", timestamp: 1700000000000 });
    messages = applyAgentEvent(messages, { type: "tool_execution_start", toolCallId: "b", toolName: "read", timestamp: 1700000001000 });
    messages = applyAgentEvent(messages, { type: "tool_execution_update", toolCallId: "a", toolName: "read", timestamp: 1700000002000, partialResult: "partial" });
    messages = applyAgentEvent(messages, { type: "tool_execution_end", toolCallId: "b", toolName: "read", isError: true, result: "failed" });
    expect(messages[0]?.tools[0]).toMatchObject({ id: "a", status: "running", startedAt: 1700000000000 });
    expect(messages[0]?.tools[1]).toMatchObject({ id: "b", status: "error" });
  });

  it("reuses unchanged history groups when the active message changes", () => {
    const messages = normalizeMessages([
      { role: "user", content: [text("first")] }, assistant([text("reply")]),
      { role: "user", content: [text("next")] }, assistant([text("live")]),
    ]);
    const previous = groupConversation(messages);
    const next = groupConversation([...messages.slice(0, -1), { ...messages.at(-1)!, text: "changed" }], previous);
    expect(next[0]).toBe(previous[0]);
    expect(next[1]).toBe(previous[1]);
    expect(next[3]).not.toBe(previous[3]);
  });
});
