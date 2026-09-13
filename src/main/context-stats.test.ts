import { describe, expect, it } from "vitest";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentSessionStats } from "../shared/types";
import { ContextStatsTracker } from "./context-stats";

const assistant = (text: string, usage: Partial<AssistantMessage["usage"]> = {}): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test",
  timestamp: 1, stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...usage },
});

const stats = (tokens: number | null = 1_000): AgentSessionStats => ({
  sessionId: "session", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
  tokens: { input: 10_000, output: 5_000, cacheRead: 100_000, cacheWrite: 0, total: 115_000 }, cost: 1,
  contextUsage: { tokens, contextWindow: 32_000, percent: tokens === null ? null : tokens / 32_000 * 100 },
});

describe("live context stats", () => {
  it("counts streaming text and thinking before the first message ends, then uses reported usage", () => {
    const tracker = new ContextStatsTracker();
    tracker.handle({ type: "agent_start" });
    const live = assistant("a".repeat(8_000));
    live.content.push({ type: "thinking", thinking: "b".repeat(4_000) });
    tracker.handle({ type: "message_update", message: live });
    const pending = tracker.enrich(stats());
    expect(pending.contextUsage).toMatchObject({ tokens: 4_000, percent: 12.5, estimated: true });
    expect(pending.tokens.total).toBe(115_000);
    expect(pending.turnUsage?.tokens).toBeUndefined();
    expect(pending.turnUsage?.outputTokens).toBe(3_000);

    tracker.handle({ type: "message_end", message: assistant("done", { input: 100, cacheRead: 8_000, output: 500, totalTokens: 8_600 }) });
    const complete = tracker.enrich(stats(8_600));
    expect(complete.contextUsage).toMatchObject({ tokens: 8_600, estimated: false });
    expect(complete.turnUsage).toMatchObject({ tokens: { total: 8_600, cacheRead: 8_000 }, outputTokens: 500, outputEstimated: false });
  });

  it("uses early provider prompt usage once, including cache reads and writes", () => {
    const tracker = new ContextStatsTracker();
    tracker.handle({ type: "message_update", message: assistant("x".repeat(400), { input: 200, cacheRead: 5_000, cacheWrite: 1_000 }) });
    expect(tracker.enrich(stats()).contextUsage).toMatchObject({ tokens: 6_300, estimated: true });
    expect(tracker.enrich(stats()).contextUsage?.tokens).toBe(6_300);
  });

  it("keeps successive tool rounds separate from context occupancy and excludes tool-reported model usage", () => {
    const tracker = new ContextStatsTracker();
    tracker.handle({ type: "agent_start" });
    const first = assistant("", { input: 100, cacheRead: 900, output: 100 });
    first.content = [{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "file.ts" } }];
    tracker.handle({ type: "message_end", message: first });
    const result: ToolResultMessage = { role: "toolResult", toolCallId: "call-1", toolName: "read_file", content: [{ type: "text", text: "x".repeat(4_000) }], isError: false, timestamp: 2 };
    tracker.handle({ type: "message_end", message: { ...result, usage: { input: 999_999, output: 999_999 } } });
    tracker.handle({ type: "message_update", message: assistant("x".repeat(800)) });
    const live = tracker.enrich(stats(2_100));
    expect(live.contextUsage?.tokens).toBe(2_300);
    expect(live.turnUsage).toMatchObject({ tokens: { total: 1_100 }, tools: { kinds: 1, calls: 1 } });
    expect(live.turnUsage!.tools.tokens).toBeGreaterThanOrEqual(1_000);

    tracker.handle({ type: "message_end", message: assistant("done", { input: 2_200, output: 300 }) });
    const complete = tracker.enrich(stats(2_500));
    expect(complete.contextUsage?.tokens).toBe(2_500);
    expect(complete.turnUsage?.tokens?.total).toBe(3_600);
  });

  it("measures generation time across model replies without counting tool execution time", () => {
    let now = 0;
    const tracker = new ContextStatsTracker(() => now);
    tracker.handle({ type: "agent_start" });
    tracker.handle({ type: "message_start", message: assistant("") });
    now = 1_000;
    tracker.handle({ type: "message_end", message: assistant("done", { input: 500, output: 100 }) });
    now = 6_000;
    tracker.handle({ type: "message_start", message: assistant("") });
    now = 8_000;
    tracker.handle({ type: "message_end", message: assistant("done", { input: 600, output: 60 }) });
    tracker.handle({ type: "agent_settled" });
    expect(tracker.enrich(stats()).turnUsage).toMatchObject({ responseDurationMs: 3_000, outputTokens: 160, outputEstimated: false });
  });

  it("leaves post-compaction context unknown until a usable prompt count arrives", () => {
    const tracker = new ContextStatsTracker();
    tracker.handle({ type: "auto_compaction_end" });
    tracker.handle({ type: "message_update", message: assistant("x".repeat(400)) });
    expect(tracker.enrich(stats(null)).contextUsage).toMatchObject({ tokens: null, percent: null });
    tracker.handle({ type: "message_update", message: assistant("x".repeat(400), { input: 2_000 }) });
    expect(tracker.enrich(stats(null)).contextUsage).toMatchObject({ tokens: 2_100, estimated: true });
  });

  it("restores only the latest user turn and does not reset live timing on snapshot", () => {
    const tracker = new ContextStatsTracker();
    tracker.restore([
      { role: "user", content: "old" }, assistant("old", { input: 9_000, output: 10 }),
      { role: "user", content: "new" }, assistant("new", { input: 2_000, output: 20 }),
    ]);
    expect(tracker.enrich(stats()).turnUsage).toMatchObject({ tokens: { total: 2_020 } });
    expect(tracker.enrich(stats()).turnUsage?.responseDurationMs).toBeUndefined();
    tracker.handle({ type: "agent_start" });
    tracker.handle({ type: "message_update", message: assistant("x".repeat(800)) });
    tracker.restore([]);
    expect(tracker.enrich(stats()).contextUsage?.tokens).toBe(1_200);
    expect(tracker.enrich(stats()).turnUsage?.tokens).toBeUndefined();
  });

  it("keeps interrupted output as an estimate without inventing billed tokens", () => {
    const tracker = new ContextStatsTracker();
    tracker.handle({ type: "message_update", message: assistant("x".repeat(400)) });
    tracker.handle({ type: "message_end", message: { ...assistant("x".repeat(400)), stopReason: "aborted" } });
    tracker.handle({ type: "agent_settled" });
    const result = tracker.enrich(stats(1_100));
    expect(result.contextUsage).toMatchObject({ tokens: 1_100, estimated: true });
    expect(result.turnUsage).toMatchObject({ outputTokens: 100, outputEstimated: true });
    expect(result.turnUsage?.tokens).toBeUndefined();
  });
});
