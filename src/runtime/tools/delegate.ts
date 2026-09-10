/**
 * 子代理委派工具。
 *
 * 根会话优先通过主进程 delegation bridge 创建独立 child session；没有 bridge
 * 的 CLI/测试环境保留同 worker fallback。子 worker 在 depth=1 时不注册这些工具。
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent, convertToLlm } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MAX_SUBAGENT_CONCURRENCY,
  MAX_SUBAGENT_MAX_TURNS,
  MAX_SUBAGENT_REPORT_CHARS,
  subagentCanMutate,
  type SubagentDefinition,
  type SubagentModelPin,
  type SubagentThinkingLevel,
} from "../../shared/subagents.js";
import {
  boundedDelegationText,
  isDelegationTerminal,
  type DelegationAction,
  type DelegationBridgePayload,
  type DelegationRecordSnapshot,
} from "../../shared/delegation.js";

export const DELEGATE_TOOL_NAME = "delegate";
export const DELEGATE_WAIT_TOOL_NAME = "delegate_wait";
export const DELEGATE_LIST_TOOL_NAME = "delegate_list";
export const DELEGATE_STOP_TOOL_NAME = "delegate_stop";
export const DELEGATE_CONTINUE_TOOL_NAME = "delegate_continue";

export type DelegationStatus = "pending" | "running" | "completed" | "failed" | "aborted" | "truncated";

/** 活动记录类型统一走共享定义（主进程协调器与渲染层共用同一形状）。 */
export type { DelegationActivity } from "../../shared/delegation.js";
import type { DelegationActivity } from "../../shared/delegation.js";

export interface DelegationUsage {
  input: number;
  output: number;
  totalTokens: number;
  cost: number;
}

/** 子代理运行期间的单条活动记录（有界，随 details 下发给渲染层）。 */
interface InternalActivity extends DelegationActivity {
  /** 运行时内部用于把 tool_execution_end 对回 start 条目，不下发。 */
  callId?: string;
}

const MAX_RECENT_ACTIVITIES = 60;
const MAX_ACTIVITY_TEXT_CHARS = 200;

function pushActivity(record: DelegationRecord, entry: InternalActivity): void {
  record.recent.push({
    ...entry,
    text: entry.text.length > MAX_ACTIVITY_TEXT_CHARS ? `${entry.text.slice(0, MAX_ACTIVITY_TEXT_CHARS)}…` : entry.text,
  });
  if (record.recent.length > MAX_RECENT_ACTIVITIES) {
    record.recent.splice(0, record.recent.length - MAX_RECENT_ACTIVITIES);
  }
}

function serializeActivity(entry: InternalActivity): DelegationActivity {
  return entry.isError
    ? { at: entry.at, kind: entry.kind, text: entry.text, isError: true }
    : { at: entry.at, kind: entry.kind, text: entry.text };
}

export interface DelegationRecord {
  id: string;
  definition: SubagentDefinition;
  task: string;
  status: DelegationStatus;
  startedAt: number;
  completedAt?: number;
  report: string;
  error?: string;
  turns: number;
  toolCalls: number;
  live?: string;
  usage?: DelegationUsage;
  /** 运行期间的活动环形缓冲（最近 MAX_RECENT_ACTIVITIES 条）。 */
  recent: InternalActivity[];
  delivered: boolean;
  background: boolean;
  ctx: ExtensionContext;
  abort: AbortController;
  completion: Promise<void>;
  resolveCompletion: () => void;
}

export interface SubagentAgentLike {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): void;
}

export interface SubagentAgentOptions {
  systemPrompt: string;
  model: unknown;
  tools: AgentTool[];
  thinkingLevel?: string;
  maxTurns: number;
}

export interface DelegateToolDeps {
  getDefinitions(): Promise<SubagentDefinition[]>;
  createTools(definition: SubagentDefinition, ctx: ExtensionContext): AgentTool[];
  deliverReport(text: string): void;
  createAgent?(options: SubagentAgentOptions): SubagentAgentLike;
  log?(message: string, details?: unknown): void;
}

const delegateParameters = Type.Object({
  tasks: Type.Array(
    Type.Object({
      role: Type.String({ minLength: 1, description: "Subagent name from the catalog" }),
      task: Type.String({ minLength: 1, description: "Self-contained instruction for that subagent" }),
    }),
    { minItems: 1, maxItems: MAX_SUBAGENT_CONCURRENCY },
  ),
  background: Type.Optional(Type.Boolean({ description: "Return immediately and deliver reports later" })),
});

const waitParameters = Type.Object({
  delegationIds: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_SUBAGENT_CONCURRENCY })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 7_200 })),
});

const stopParameters = Type.Object({
  delegationIds: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_SUBAGENT_CONCURRENCY })),
});

const continueParameters = Type.Object({
  delegationId: Type.String({ minLength: 1 }),
  message: Type.String({ minLength: 1 }),
});

function boundedReport(value: string): string {
  return boundedDelegationText(value, MAX_SUBAGENT_REPORT_CHARS);
}

function describeToolCall(name: string, args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const target =
    (typeof record.path === "string" && record.path) ||
    (typeof record.cmd === "string" && record.cmd.split("\n")[0]) ||
    (typeof record.pattern === "string" && record.pattern) ||
    (typeof record.input === "string" && record.input.split("\n")[0]) ||
    "";
  return target ? `${name} ${target.slice(0, 120)}` : name;
}

export function composeSubagentSystemPrompt(definition: SubagentDefinition, cwd: string): string {
  const toolList = definition.tools.join(", ") || "none";
  return [
    `You are the "${definition.name}" subagent inside TACode, working on one task delegated by the main agent.`,
    `You cannot see the user, ask questions, or delegate further. Finish the task with the tools you have: ${toolList}.`,
    subagentCanMutate(definition)
      ? "You may change files, but only the ones the task is about; leave everything else untouched."
      : "You have no tools that change files or run commands, so never report an edit you could not have made.",
    "Your final message is the report the main agent receives when you finish. Make it self-contained: what you did, what you found with exact paths and line numbers, and anything you could not finish.",
    "Keep the report tight. Report findings, not narration, and never pad it with a summary of your own process.",
    `Working directory: ${cwd}`,
    definition.prompt,
  ].filter((block) => block.trim()).join("\n\n");
}

function statusLabel(status: DelegationStatus): string {
  return status === "truncated" ? "truncated (turn limit)" : status;
}

function recordSnapshot(record: DelegationRecord): Record<string, unknown> {
  return {
    delegationId: record.id,
    role: record.definition.name,
    task: record.task,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    ...(record.report ? { report: boundedReport(record.report) } : {}),
    ...(record.error ? { error: record.error } : {}),
    turns: record.turns,
    toolCalls: record.toolCalls,
    ...(record.live ? { live: record.live } : {}),
    ...(record.usage ? { usage: record.usage } : {}),
    ...(record.definition.model ? { model: record.definition.model } : {}),
    ...(record.recent.length ? { recent: record.recent.map(serializeActivity) } : {}),
  };
}

function delegateDetails(records: DelegationRecord[]): Record<string, unknown> {
  const settled = records.filter((record) => isSettled(record));
  return {
    total: records.length,
    done: settled.length,
    tasks: records.map((record) => ({
      id: record.id,
      delegationId: record.id,
      role: record.definition.name,
      task: record.task,
      status: record.status,
      startedAt: record.startedAt,
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
      toolCalls: record.toolCalls,
      turns: record.turns,
      ...(record.live ? { live: record.live } : {}),
      ...(record.definition.model ? { model: record.definition.model } : {}),
      ...(record.definition.thinkingLevel ? { thinkingLevel: record.definition.thinkingLevel } : {}),
      ...(record.recent.length ? { recent: record.recent.map(serializeActivity) } : {}),
    })),
    results: settled.map((record) => ({
      role: record.definition.name,
      task: record.task,
      output: boundedReport(record.report) || record.error || "",
      success: record.status === "completed" || record.status === "truncated",
      ...(record.usage ? { usage: record.usage } : {}),
    })),
  };
}

function reportBlock(records: DelegationRecord[]): string {
  return records.map((record) => {
    const header = `## ${record.definition.name} (${record.id}) — ${statusLabel(record.status)}`;
    return `${header}\n\n${record.status === "completed" || record.status === "truncated" ? boundedReport(record.report) || "(no report)" : record.error || "(no report)"}`;
  }).join("\n\n");
}

function isSettled(record: DelegationRecord): boolean {
  return record.status !== "pending" && record.status !== "running";
}

function assistantText(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

function addUsage(current: DelegationUsage | undefined, usage: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } | undefined): DelegationUsage | undefined {
  if (!usage) return current;
  return {
    input: (current?.input ?? 0) + (usage.input ?? 0),
    output: (current?.output ?? 0) + (usage.output ?? 0),
    totalTokens: (current?.totalTokens ?? 0) + (usage.totalTokens ?? 0),
    cost: (current?.cost ?? 0) + (usage.cost?.total ?? 0),
  };
}

class DelegationRunner {
  constructor(
    private readonly record: DelegationRecord,
    private readonly deps: DelegateToolDeps,
    private readonly ctx: ExtensionContext,
    private readonly onProgress: () => void,
  ) {}

  async run(): Promise<void> {
    try {
      await this.runInternal();
    } catch (error) {
      if (!isSettled(this.record)) {
        this.settle(this.record.abort.signal.aborted ? "aborted" : "failed", "", undefined, error instanceof Error ? error.message : String(error));
      }
      this.deps.log?.("subagent runner failed", error);
    }
  }

  private resolveModel(): { model: NonNullable<ExtensionContext["model"]> } | { error: string } {
    const pin: SubagentModelPin | undefined = this.record.definition.model;
    if (!pin) return this.ctx.model ? { model: this.ctx.model } : { error: "No model is active in this session." };
    const model = this.ctx.modelRegistry.find(pin.providerId, pin.modelId);
    return model ? { model } : { error: `Subagent model pin not found: ${pin.providerId}/${pin.modelId}` };
  }

  private async runInternal(): Promise<void> {
    const resolved = this.resolveModel();
    if ("error" in resolved) return this.settle("failed", "", undefined, resolved.error);
    const tools = this.deps.createTools(this.record.definition, this.ctx);
    if (!tools.length) return this.settle("failed", "", undefined, "This subagent has no usable tools.");
    const auth = await this.ctx.modelRegistry.getApiKeyAndHeaders(resolved.model).catch(() => undefined);
    const thinkingLevel = (this.record.definition.thinkingLevel ?? this.ctx.thinkingLevel) as SubagentThinkingLevel | undefined;
    const maxTurns = this.record.definition.maxTurns ?? MAX_SUBAGENT_MAX_TURNS;
    const agent = this.deps.createAgent
      ? this.deps.createAgent({ systemPrompt: composeSubagentSystemPrompt(this.record.definition, this.ctx.cwd), model: resolved.model, tools, ...(thinkingLevel ? { thinkingLevel } : {}), maxTurns })
      : new Agent({
          streamFn: (m, context, options) => streamSimple(m, context, { ...options, ...(auth?.ok && auth.apiKey ? { apiKey: auth.apiKey } : {}), ...(auth?.ok && auth.headers ? { headers: auth.headers } : {}) }),
          ...(auth?.ok && auth.apiKey ? { getApiKey: async () => auth.apiKey } : {}),
          convertToLlm,
          initialState: { systemPrompt: composeSubagentSystemPrompt(this.record.definition, this.ctx.cwd), model: resolved.model, tools, ...(thinkingLevel ? { thinkingLevel } : {}), messages: [] },
          toolExecution: "sequential",
        });

    let lastReport = "";
    let turns = 0;
    let toolCalls = 0;
    let usage: DelegationUsage | undefined;
    let truncated = false;
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        turns += 1;
        this.record.turns = turns;
        const text = assistantText(event.message);
        if (text.trim()) {
          lastReport = text;
          pushActivity(this.record, { at: Date.now(), kind: "report", text: text.trim() });
        }
        usage = addUsage(usage, event.message.usage);
        if (turns >= maxTurns && !truncated) {
          truncated = true;
          this.record.live = `reached maxTurns (${maxTurns})`;
          pushActivity(this.record, { at: Date.now(), kind: "notice", text: this.record.live });
          this.onProgress();
          agent.abort();
        }
      } else if (event.type === "tool_execution_start") {
        toolCalls += 1;
        this.record.toolCalls = toolCalls;
        this.record.live = describeToolCall(event.toolName, event.args);
        pushActivity(this.record, { at: Date.now(), kind: "tool", text: this.record.live, callId: event.toolCallId });
        this.onProgress();
      } else if (event.type === "tool_execution_end") {
        // 把结束状态对回 start 条目；只有失败才立即推送，成功态随下一次进度一起下发。
        for (let index = this.record.recent.length - 1; index >= 0; index -= 1) {
          const entry = this.record.recent[index]!;
          if (entry.kind === "tool" && entry.callId === event.toolCallId) {
            if (event.isError) entry.isError = true;
            break;
          }
        }
        if (event.isError) this.onProgress();
      }
    });
    const onAbort = () => agent.abort();
    this.record.abort.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await agent.prompt(this.record.task);
      // 完成契约（shared/delegation.ts 的 DELEGATION_COMPLETION_CONTRACT）：
      // 本地路径 prompt 返回即整轮结束的语义由 pi 的 Agent 保证，但这里仍显式
      // await waitForIdle()，与主进程桥接路径（AgentHost.waitForIdle）保持同一判定：
      // 空闲后以最后一条带文本的 assistant 消息为最终报告。
      await agent.waitForIdle();
    } catch (error) {
      this.settle(this.record.abort.signal.aborted ? "aborted" : "failed", lastReport, usage, error instanceof Error ? error.message : String(error));
      return;
    } finally {
      this.record.abort.signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }
    if (this.record.abort.signal.aborted) return this.settle("aborted", lastReport, usage);
    if (truncated) return this.settle("truncated", lastReport, usage);
    if (!lastReport.trim()) return this.settle("failed", "", usage, "The subagent finished without writing a report.");
    this.settle("completed", lastReport, usage);
  }

  private settle(status: DelegationStatus, report: string, usage?: DelegationUsage, error?: string): void {
    if (isSettled(this.record)) return;
    this.record.status = status;
    this.record.report = report;
    if (usage) this.record.usage = usage;
    if (error) this.record.error = error;
    this.record.completedAt = Date.now();
    try { this.onProgress(); } finally { this.record.resolveCompletion(); }
  }
}

export class DelegationRegistry {
  private readonly records = new Map<string, DelegationRecord>();
  private deliveryTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly deps: DelegateToolDeps) {}
  list(): DelegationRecord[] { return [...this.records.values()]; }
  active(): DelegationRecord[] { return this.list().filter((record) => !isSettled(record)); }
  dispose(): void {
    this.disposed = true;
    if (this.deliveryTimer) clearTimeout(this.deliveryTimer);
    for (const record of this.active()) record.abort.abort();
  }
  start(definition: SubagentDefinition, task: string, ctx: ExtensionContext, background: boolean, onProgress: () => void = () => undefined): DelegationRecord {
    const record: DelegationRecord = {
      id: `delegation-${randomUUID()}`,
      definition,
      task,
      status: "pending",
      startedAt: Date.now(),
      report: "",
      turns: 0,
      toolCalls: 0,
      recent: [],
      delivered: false,
      background,
      ctx,
      abort: new AbortController(),
      completion: Promise.resolve(),
      resolveCompletion: () => undefined,
    };
    record.completion = new Promise<void>((resolve) => { record.resolveCompletion = resolve; });
    this.records.set(record.id, record);
    record.status = "running";
    void new DelegationRunner(record, this.deps, ctx, () => {
      try { onProgress(); } catch (error) { this.deps.log?.("subagent progress update failed", error); }
      finally { this.scheduleDelivery(); }
    }).run();
    return record;
  }
  continue(id: string, message: string): DelegationRecord | undefined {
    const record = this.records.get(id);
    if (!record || !isSettled(record)) return undefined;
    record.status = "running";
    record.task = `${record.task}\n\nFollow-up: ${message.trim()}`;
    record.report = "";
    record.recent = [];
    record.error = undefined;
    record.completedAt = undefined;
    record.delivered = false;
    record.completion = new Promise<void>((resolve) => { record.resolveCompletion = resolve; });
    void new DelegationRunner(record, this.deps, record.ctx, () => this.scheduleDelivery()).run();
    return record;
  }

  private scheduleDelivery(): void {
    if (this.disposed || this.deliveryTimer) return;
    this.deliveryTimer = setTimeout(() => {
      this.deliveryTimer = undefined;
      if (this.disposed) return;
      const pending = this.list().filter((record) => record.background && !record.delivered && isSettled(record));
      if (!pending.length) return;
      for (const record of pending) record.delivered = true;
      this.deps.deliverReport(`${pending.length === 1 ? "A delegated subagent finished. Its report:" : `${pending.length} delegated subagents finished. Their reports:`}\n\n${reportBlock(pending)}`);
    }, 150);
    this.deliveryTimer.unref?.();
  }
  async wait(ids: string[] | undefined, timeoutSeconds: number | undefined, onTick?: (records: DelegationRecord[]) => void): Promise<{ status: "completed" | "timeout"; records: DelegationRecord[] }> {
    const targets = ids?.length ? this.list().filter((record) => ids.includes(record.id)) : this.active();
    if (!targets.length) return { status: "completed", records: [] };
    const timeoutMs = Math.max(1, timeoutSeconds ?? 600) * 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs); timer.unref?.(); });
    // 等待期间定期回报快照，驱动 UI 显示"等待子代理 x/y"进度。
    let tickTimer: ReturnType<typeof setInterval> | undefined;
    if (onTick) {
      onTick(targets);
      tickTimer = setInterval(() => onTick(targets), 1_000);
      tickTimer.unref?.();
    }
    const settled = Promise.all(targets.map((record) => record.completion)).then(() => "completed" as const);
    const status = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    if (tickTimer) clearInterval(tickTimer);
    for (const record of targets) if (isSettled(record)) record.delivered = true;
    return { status, records: targets };
  }
  stop(ids: string[] | undefined): DelegationRecord[] {
    const targets = ids?.length ? this.list().filter((record) => ids.includes(record.id)) : this.active();
    for (const record of targets) if (!isSettled(record)) record.abort.abort();
    return targets;
  }
}

export function registerDelegateTools(pi: ExtensionAPI, deps: DelegateToolDeps): DelegationRegistry {
  const registry = new DelegationRegistry(deps);
  pi.registerTool({
    name: DELEGATE_TOOL_NAME,
    label: "Delegate",
    description: "Run subagents, one per task. Each subagent has its own system prompt and tool set; only final reports return.",
    promptSnippet: "delegate: run subagents and collect reports",
    promptGuidelines: ["Delegate independent work with self-contained tasks.", "Use background when other work can proceed."],
    parameters: delegateParameters,
    renderShell: "self",
    executionMode: "parallel",
    async execute(_id, params, signal, onUpdate, ctx) {
      const definitions = await deps.getDefinitions();
      if (!definitions.length) return { content: [{ type: "text", text: "No subagents are enabled. Configure them in Settings → Subagents." }], details: { total: 0, done: 0, tasks: [], results: [] }, isError: true };
      const byName = new Map(definitions.map((item) => [item.name, item]));
      const unknown = params.tasks.map((task) => task.role).filter((role) => !byName.has(role));
      if (unknown.length) return { content: [{ type: "text", text: `Unknown subagent(s): ${unknown.join(", ")}. Available:\n${definitions.map((item) => `- ${item.name}: ${item.description}`).join("\n")}` }], details: { total: 0, done: 0, tasks: [], results: [] }, isError: true };
      if (registry.active().length + params.tasks.length > MAX_SUBAGENT_CONCURRENCY) return { content: [{ type: "text", text: `Too many concurrent subagents (limit ${MAX_SUBAGENT_CONCURRENCY}).` }], details: { total: 0, done: 0, tasks: [], results: [] }, isError: true };
      const background = params.background === true;
      let publish: () => void = () => undefined;
      const started = params.tasks.map((task) => registry.start(byName.get(task.role)!, task.task, ctx, background, () => publish()));
      const onAbort = () => started.forEach((record) => { if (!isSettled(record)) record.abort.abort(); });
      signal?.addEventListener("abort", onAbort, { once: true });
      publish = () => onUpdate?.({ content: [{ type: "text", text: delegateProgressText(started) }], details: delegateDetails(started) });
      publish();
      if (background) {
        signal?.removeEventListener("abort", onAbort);
        return { content: [{ type: "text", text: `Started ${started.length} subagent(s): ${started.map((record) => `${record.definition.name} (${record.id})`).join(", ")}. Use delegate_wait or delegate_stop.` }], details: delegateDetails(started) };
      }
      await Promise.all(started.map((record) => record.completion));
      signal?.removeEventListener("abort", onAbort);
      for (const record of started) record.delivered = true;
      return { content: [{ type: "text", text: reportBlock(started) }], details: delegateDetails(started) };
    },
  });
  pi.registerTool({
    name: DELEGATE_WAIT_TOOL_NAME,
    label: "Wait for subagents",
    description: "Wait for background subagents to finish and return reports.",
    promptSnippet: "delegate_wait: converge on background subagents",
    parameters: waitParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params, _signal, onUpdate) {
      const publish = (records: DelegationRecord[]) => {
        if (!records.length) return;
        onUpdate?.({ content: [{ type: "text", text: delegateProgressText(records) }], details: { status: "waiting", delegations: records.map(recordSnapshot) } });
      };
      const { status, records } = await registry.wait(params.delegationIds, params.timeoutSeconds, publish);
      return { content: [{ type: "text", text: records.length ? `${status === "timeout" ? "Some subagents are still running.\n\n" : ""}${reportBlock(records)}` : "No matching subagents." }], details: { status, delegations: records.map(recordSnapshot), ...(status === "timeout" ? { pendingIds: records.filter((record) => !isSettled(record)).map((record) => record.id) } : {}) } };
    },
  });
  pi.registerTool({
    name: DELEGATE_LIST_TOOL_NAME,
    label: "List subagents",
    description: "List this session's subagent delegations.",
    promptSnippet: "delegate_list: list subagent status",
    parameters: Type.Object({}),
    renderShell: "self",
    executionMode: "sequential",
    async execute() {
      const records = registry.list();
      return { content: [{ type: "text", text: records.length ? records.map((record) => `${record.definition.name} (${record.id}) — ${statusLabel(record.status)}${record.live ? ` · ${record.live}` : ""}`).join("\n") : "No subagents have been delegated in this session." }], details: { delegations: records.map(recordSnapshot) } };
    },
  });
  pi.registerTool({
    name: DELEGATE_STOP_TOOL_NAME,
    label: "Stop subagents",
    description: "Stop running subagents.",
    promptSnippet: "delegate_stop: stop subagents",
    parameters: stopParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params) {
      const stopped = registry.stop(params.delegationIds);
      await Promise.all(stopped.map((record) => record.completion));
      for (const record of stopped) record.delivered = true;
      return { content: [{ type: "text", text: stopped.length ? stopped.map((record) => `${record.definition.name} (${record.id}) — ${statusLabel(record.status)}`).join("\n") : "No running subagents." }], details: { stopped: stopped.map(recordSnapshot) } };
    },
  });
  pi.registerTool({
    name: DELEGATE_CONTINUE_TOOL_NAME,
    label: "Continue subagent",
    description: "Send a follow-up instruction to a completed local subagent.",
    promptSnippet: "delegate_continue: continue a subagent",
    parameters: continueParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params) {
      const record = registry.continue(params.delegationId, params.message);
      if (!record) return { content: [{ type: "text", text: "Delegation not found or still running." }], details: { delegations: [] }, isError: true };
      await record.completion;
      return { content: [{ type: "text", text: reportBlock([record]) }], details: { delegations: [recordSnapshot(record)] } };
    },
  });
  return registry;
}

function delegateProgressText(records: DelegationRecord[]): string {
  return records.map((record) => `${record.definition.name} (${record.id}) — ${statusLabel(record.status)}${record.live ? ` · ${record.live}` : ""}`).join("\n");
}

export interface RemoteDelegateDeps {
  client: {
    request(action: DelegationAction, payload: DelegationBridgePayload): Promise<unknown>;
    onEvent(listener: (event: DelegationRecordSnapshot) => void): () => void;
  };
  startPayload(definition: SubagentDefinition, task: string, ctx: ExtensionContext): DelegationBridgePayload;
}

export function registerRemoteDelegateTools(pi: ExtensionAPI, deps: RemoteDelegateDeps): void {
  const backgroundDelegations = new Set<string>();
  deps.client.onEvent((event) => {
    if (!backgroundDelegations.has(event.delegationId) || !isDelegationTerminal(event.status)) return;
    backgroundDelegations.delete(event.delegationId);
    try {
      pi.sendUserMessage(
        `A delegated subagent finished. Its report:\n\n${remoteReportBlock([event])}`,
        { deliverAs: "followUp" },
      );
    } catch {
      // The parent session may be shutting down; the persisted child result remains available.
    }
  });

  pi.registerTool({
    name: DELEGATE_TOOL_NAME,
    label: "Delegate",
    description: "Start persistent child sessions managed by TACode and collect their reports.",
    promptSnippet: "delegate: start persistent child sessions",
    promptGuidelines: ["Delegate independent work with self-contained tasks.", "Use background when other work can proceed."],
    parameters: delegateParameters,
    renderShell: "self",
    executionMode: "parallel",
    async execute(_id, params, signal, onUpdate, ctx) {
      const snapshots = new Map<string, DelegationRecordSnapshot>();
      const unsubscribe = deps.client.onEvent((event) => {
        if (!snapshots.has(event.delegationId)) return;
        snapshots.set(event.delegationId, event);
        onUpdate?.({ content: [{ type: "text", text: remoteProgressText([...snapshots.values()]) }], details: remoteDelegateDetails([...snapshots.values()]) });
      });
      try {
        const started: DelegationRecordSnapshot[] = [];
        for (const task of params.tasks) {
          const result = await deps.client.request("start", deps.startPayload({ name: task.role } as SubagentDefinition, task.task, ctx));
          const snapshot = result as DelegationRecordSnapshot;
          snapshots.set(snapshot.delegationId, snapshot);
          started.push(snapshot);
        }
        onUpdate?.({ content: [{ type: "text", text: remoteProgressText(started) }], details: remoteDelegateDetails(started) });
        if (params.background === true) {
          for (const item of started) backgroundDelegations.add(item.delegationId);
          return { content: [{ type: "text", text: `Started ${started.length} persistent subagent session(s): ${started.map((item) => `${item.role} (${item.delegationId})`).join(", ")}. Use delegate_wait to collect reports.` }], details: remoteDelegateDetails(started) };
        }
        const onAbort = () => { void deps.client.request("stop", { delegationIds: started.map((item) => item.delegationId) }); };
        signal?.addEventListener("abort", onAbort, { once: true });
        const waited = await deps.client.request("wait", { delegationIds: started.map((item) => item.delegationId), mode: "all", timeoutSeconds: 7_200 }) as { delegations?: DelegationRecordSnapshot[]; status?: string };
        signal?.removeEventListener("abort", onAbort);
        const results = waited.delegations ?? started;
        return { content: [{ type: "text", text: remoteReportBlock(results) }], details: remoteDelegateDetails(results) };
      } finally { unsubscribe(); }
    },
  });
  pi.registerTool({
    name: DELEGATE_WAIT_TOOL_NAME,
    label: "Wait for subagents",
    description: "Wait for persistent child sessions and return reports.",
    promptSnippet: "delegate_wait: wait for child sessions",
    parameters: waitParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params) {
      const result = await deps.client.request("wait", { ...(params.delegationIds ? { delegationIds: params.delegationIds } : {}), ...(params.timeoutSeconds ? { timeoutSeconds: params.timeoutSeconds } : {}), mode: "all" }) as { status?: string; delegations?: DelegationRecordSnapshot[] };
      const records = result.delegations ?? [];
      return { content: [{ type: "text", text: records.length ? `${result.status === "timeout" ? "Some subagents are still running.\n\n" : ""}${remoteReportBlock(records)}` : "No matching subagents." }], details: { status: result.status, delegations: records, ...(result.status === "timeout" ? { pendingIds: records.filter((item) => !isDelegationTerminal(item.status)).map((item) => item.delegationId) } : {}) } };
    },
  });
  pi.registerTool({
    name: DELEGATE_LIST_TOOL_NAME,
    label: "List subagents",
    description: "List persistent child sessions belonging to this parent.",
    promptSnippet: "delegate_list: list child session status",
    parameters: Type.Object({}),
    renderShell: "self",
    executionMode: "sequential",
    async execute() {
      const records = await deps.client.request("list", { includeCompleted: true }) as DelegationRecordSnapshot[];
      return { content: [{ type: "text", text: records.length ? records.map((item) => `${item.role} (${item.delegationId}) — ${item.status}${item.live ? ` · ${item.live}` : ""}`).join("\n") : "No subagents have been delegated in this session." }], details: { delegations: records } };
    },
  });
  pi.registerTool({
    name: DELEGATE_STOP_TOOL_NAME,
    label: "Stop subagents",
    description: "Stop persistent child sessions that are still running.",
    promptSnippet: "delegate_stop: stop child sessions",
    parameters: stopParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params) {
      const records = await deps.client.request("stop", { ...(params.delegationIds ? { delegationIds: params.delegationIds } : {}) }) as DelegationRecordSnapshot[];
      return { content: [{ type: "text", text: records.length ? records.map((item) => `${item.role} (${item.delegationId}) — ${item.status}`).join("\n") : "No running subagents." }], details: { stopped: records } };
    },
  });
  pi.registerTool({
    name: DELEGATE_CONTINUE_TOOL_NAME,
    label: "Continue subagent",
    description: "Send a follow-up instruction to a persistent child session.",
    promptSnippet: "delegate_continue: continue a child session",
    parameters: continueParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params) {
      const record = await deps.client.request("continue", params) as DelegationRecordSnapshot;
      return { content: [{ type: "text", text: remoteReportBlock([record]) }], details: { delegations: [record] } };
    },
  });
}

function remoteProgressText(records: DelegationRecordSnapshot[]): string {
  return records.map((record) => `${record.role} (${record.delegationId}) — ${record.status}${record.live ? ` · ${record.live}` : ""}`).join("\n");
}

function remoteDelegateDetails(records: DelegationRecordSnapshot[]): Record<string, unknown> {
  const settled = records.filter((record) => isDelegationTerminal(record.status));
  return {
    total: records.length,
    done: settled.length,
    // 任务条目带上 childSessionPath / error / recent / 时间与轮次，失败卡片才有的可看，
    // 而不是只剩一句占位文案（主进程协调器维护 recent 活动缓冲）。
    tasks: records.map((record) => ({
      id: record.delegationId,
      delegationId: record.delegationId,
      role: record.role,
      task: record.task,
      status: record.status,
      ...(record.live ? { live: record.live } : {}),
      ...(record.model ? { model: record.model } : {}),
      ...(record.thinkingLevel ? { thinkingLevel: record.thinkingLevel } : {}),
      ...(record.childSessionPath ? { childSessionPath: record.childSessionPath } : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(record.recent?.length ? { recent: record.recent } : {}),
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    })),
    results: settled.map((record) => ({ role: record.role, task: record.task, output: record.report || record.error || "", success: record.status === "completed" || record.status === "truncated", ...(record.usage ? { usage: record.usage } : {}) })),
  };
}

function remoteReportBlock(records: DelegationRecordSnapshot[]): string {
  return records.map((record) => `## ${record.role} (${record.delegationId}) — ${record.status}\n\n${record.report || record.error || "(no report)"}`).join("\n\n");
}
