import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentEvent, AgentSessionStats } from "../shared/types";

type Tokens = AgentSessionStats["tokens"];
const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

function messageOf(value: unknown): AgentMessage | undefined {
  if (!value || typeof value !== "object" || !("role" in value)) return;
  const message = value as AgentMessage;
  if (message.role === "assistant" && !Array.isArray(message.content)) return;
  return message;
}

function usageOf(message: AssistantMessage): Tokens {
  const usage = message.usage;
  const tokens = {
    input: count(usage?.input),
    output: count(usage?.output),
    cacheRead: count(usage?.cacheRead),
    cacheWrite: count(usage?.cacheWrite),
    total: 0,
  };
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return tokens;
}

function addTokens(target: Tokens, source: Tokens): void {
  for (const key of Object.keys(target) as Array<keyof Tokens>) target[key] += source[key];
}

/** Keeps only the current reply and small turn counters; stream updates never scan history. */
export class ContextStatsTracker {
  private initialized = false;
  private active = false;
  private contextEstimated = true;
  private stream?: { message: AssistantMessage; startedAt: number };
  private tokens = emptyTokens();
  private outputTokens = 0;
  private outputEstimated = false;
  private responseDurationMs = 0;
  private timingKnown = true;
  private tools = new Map<string, { name: string; arguments: number; result: number }>();

  constructor(private readonly now = Date.now) {}

  restore(messages: unknown[]): void {
    // A snapshot of a running host must not reset its live reply or measured timing.
    if (this.initialized) return;
    this.initialized = true;
    this.timingKnown = false;
    const history = messages.map(messageOf).filter((message): message is AgentMessage => Boolean(message));
    let start = history.length;
    while (start > 0 && history[start - 1].role !== "user") start -= 1;
    for (const message of history.slice(start)) this.finishMessage(message, false);
    const last = history.at(-1);
    this.contextEstimated = !(last?.role === "assistant" && usageOf(last).total > 0 && !["error", "aborted"].includes(last.stopReason));
  }

  handle(event: AgentEvent): void {
    if (event.type === "agent_start") {
      this.initialized = true;
      if (!this.active) {
        this.tokens = emptyTokens();
        this.outputTokens = 0;
        this.outputEstimated = false;
        this.responseDurationMs = 0;
        this.timingKnown = true;
        this.tools.clear();
      }
      this.active = true;
    }
    const message = messageOf(event.message);
    if ((event.type === "message_start" || event.type === "message_update") && message?.role === "assistant") {
      this.stream = { message, startedAt: this.stream?.startedAt ?? this.now() };
    } else if (event.type === "message_end" && message) {
      this.finishMessage(message, true);
    } else if (event.type === "auto_compaction_end") {
      this.contextEstimated = true;
      this.stream = undefined;
    } else if (event.type === "agent_settled") {
      this.active = false;
      this.stream = undefined;
    }
  }

  enrich(stats: AgentSessionStats): AgentSessionStats {
    const current = this.stream?.message;
    const liveUsage = current ? usageOf(current) : emptyTokens();
    const liveOutput = current ? Math.max(liveUsage.output, estimateTokens(current)) : 0;
    let contextUsage = stats.contextUsage;
    if (contextUsage) {
      let tokens = contextUsage.tokens;
      if (current) {
        const prompt = liveUsage.input + liveUsage.cacheRead + liveUsage.cacheWrite;
        // Some providers report prompt usage at stream start; others only at the end.
        if (prompt > 0) tokens = prompt + liveOutput;
        else if (tokens !== null) tokens += liveOutput;
      }
      contextUsage = {
        ...contextUsage,
        tokens,
        percent: tokens !== null && contextUsage.contextWindow > 0 ? tokens / contextUsage.contextWindow * 100 : null,
        estimated: Boolean(current) || this.contextEstimated,
      };
    }
    const tokens = { ...this.tokens };
    addTokens(tokens, liveUsage);
    const toolRows = [...this.tools.values()];
    const responseDurationMs = this.responseDurationMs + (this.stream ? Math.max(0, this.now() - this.stream.startedAt) : 0);
    return {
      ...stats,
      contextUsage,
      turnUsage: {
        ...(tokens.total > 0 ? { tokens } : {}),
        outputTokens: this.outputTokens + liveOutput,
        outputEstimated: this.outputEstimated || Boolean(current),
        ...(this.timingKnown && responseDurationMs > 0 ? { responseDurationMs } : {}),
        tools: {
          kinds: new Set(toolRows.map((tool) => tool.name)).size,
          calls: toolRows.length,
          tokens: toolRows.reduce((total, tool) => total + tool.arguments + tool.result, 0),
        },
      },
    };
  }

  private finishMessage(message: AgentMessage, live: boolean): void {
    if (message.role === "assistant") {
      const tokens = usageOf(message);
      addTokens(this.tokens, tokens);
      this.outputTokens += tokens.output > 0 ? tokens.output : estimateTokens(message);
      this.outputEstimated ||= tokens.output === 0 && estimateTokens(message) > 0;
      if (live && this.stream) this.responseDurationMs += Math.max(0, this.now() - this.stream.startedAt);
      this.stream = undefined;
      this.contextEstimated = tokens.total === 0 || ["error", "aborted"].includes(message.stopReason);
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const existing = this.tools.get(block.id);
        this.tools.set(block.id, {
          name: block.name,
          arguments: Math.ceil((block.name.length + JSON.stringify(block.arguments).length) / 4),
          result: existing?.result ?? 0,
        });
      }
    } else if (message.role === "toolResult") {
      const existing = this.tools.get(message.toolCallId);
      this.tools.set(message.toolCallId, {
        name: message.toolName,
        arguments: existing?.arguments ?? 0,
        result: estimateTokens(message),
      });
      this.contextEstimated = true;
    } else {
      this.contextEstimated = true;
    }
  }
}
