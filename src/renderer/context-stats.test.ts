import { describe, expect, it } from "vitest";
import type { AgentSessionStats } from "../shared/types";
import { contextCapacity, generationSpeed, latestContextStats } from "./context-stats";

function stats(contextUsage?: AgentSessionStats["contextUsage"]): AgentSessionStats {
  return { sessionId: "s", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
    cost: 0, tokens: { input: 200_000, output: 4_000, cacheRead: 500_000, cacheWrite: 0, total: 704_000 }, contextUsage };
}

describe("context inspector", () => {
  it("shows remaining capacity from the model window, not cumulative usage", () => {
    expect(contextCapacity(stats({ tokens: 108_000, contextWindow: 1_000_000, percent: 10.8 }))).toMatchObject({
      used: 108_000, window: 1_000_000, remaining: 892_000, usedPercent: 10.8, remainingPercent: 89.2,
    });
  });

  it.each([undefined, { tokens: null, contextWindow: 128_000, percent: null }])("does not turn unknown usage into a zero or a billing total", (usage) => {
    expect(contextCapacity(stats(usage))).toMatchObject({ used: undefined, usedPercent: undefined, remaining: undefined, remainingPercent: undefined });
  });

  it("clamps remaining capacity at zero but retains overflow information", () => {
    expect(contextCapacity(stats({ tokens: 150_000, contextWindow: 100_000, percent: 150, estimated: true }))).toMatchObject({
      remaining: 0, remainingPercent: 0, usedPercent: 150, estimated: true,
    });
  });

  it("rejects invalid or absent model windows instead of assuming 128k", () => {
    expect(contextCapacity(stats()).window).toBeUndefined();
    expect(contextCapacity(stats({ tokens: 500, contextWindow: 0, percent: Infinity })).remainingPercent).toBeUndefined();
    expect(contextCapacity(stats({ tokens: NaN, contextWindow: 32_000, percent: NaN })).used).toBeUndefined();
  });

  it("applies stats received between the snapshot and live subscription", () => {
    const initial = stats({ tokens: 0, contextWindow: 32_000, percent: 0 });
    const live = stats({ tokens: 3_000, contextWindow: 32_000, percent: 9.375, estimated: true });
    expect(latestContextStats([
      { type: "desktop_snapshot_meta", stats: initial }, { type: "message_update" }, { type: "desktop_session_stats", stats: live },
    ], initial)).toBe(live);
    expect(latestContextStats([{ type: "message_update" }], live)).toBe(live);
  });

  it("only calculates throughput when output and model response timing are available", () => {
    expect(generationSpeed(stats())).toBeUndefined();
    const current = stats();
    current.turnUsage = { outputTokens: 600, outputEstimated: true, responseDurationMs: 3_000, tools: { kinds: 0, calls: 0, tokens: 0 } };
    expect(generationSpeed(current)).toBe(200);
    current.turnUsage.responseDurationMs = undefined;
    expect(generationSpeed(current)).toBeUndefined();
  });
});
