import type { AgentEvent, AgentSessionStats } from "../shared/types";

/** Billing totals are cumulative and must never be used as context-window occupancy. */
export function contextCapacity(stats?: AgentSessionStats) {
  const usage = stats?.contextUsage;
  const window = typeof usage?.contextWindow === "number" && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
    ? usage.contextWindow : undefined;
  const used = typeof usage?.tokens === "number" && Number.isFinite(usage.tokens) && usage.tokens >= 0
    ? usage.tokens : undefined;
  const usedPercent = used !== undefined && window !== undefined ? Math.round(used / window * 1_000) / 10 : undefined;
  return {
    window,
    used,
    usedPercent,
    remaining: used !== undefined && window !== undefined ? Math.max(0, window - used) : undefined,
    remainingPercent: usedPercent !== undefined ? Math.round(Math.max(0, 100 - usedPercent) * 10) / 10 : undefined,
    estimated: usage?.estimated === true,
  };
}

/** Snapshot replay carries stats as well as transcript events. */
export function latestContextStats(events: AgentEvent[], initial?: AgentSessionStats): AgentSessionStats | undefined {
  let stats = initial;
  for (const event of events) {
    if ((event.type === "desktop_session_stats" || event.type === "desktop_snapshot_meta") && event.stats && typeof event.stats === "object") {
      stats = event.stats as AgentSessionStats;
    }
  }
  return stats;
}

export function generationSpeed(stats?: AgentSessionStats): number | undefined {
  const usage = stats?.turnUsage;
  if (!usage || !Number.isFinite(usage.outputTokens) || usage.outputTokens <= 0 || !usage.responseDurationMs || !Number.isFinite(usage.responseDurationMs) || usage.responseDurationMs <= 0) return;
  return Math.round(usage.outputTokens / (usage.responseDurationMs / 1_000));
}
