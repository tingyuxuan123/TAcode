import type { PermissionMode } from "./types.js";

export const DELEGATION_BRIDGE_REQUEST = "tacode:delegation:request" as const;
export const DELEGATION_BRIDGE_RESPONSE = "tacode:delegation:response" as const;
export const DELEGATION_BRIDGE_EVENT = "tacode:delegation:event" as const;

export const DELEGATION_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "truncated",
] as const;

export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

export const DELEGATION_ACTIONS = [
  "start",
  "list",
  "get",
  "wait",
  "get_results",
  "stop",
  "continue",
] as const;

export type DelegationAction = (typeof DELEGATION_ACTIONS)[number];

export const DELEGATION_MAX_TASK_CHARS = 10_000;
/**
 * 子代理报告的唯一上限（单一来源）：本地 `delegate` 工具、桥接协调器落库、
 * 回灌父上下文的 `remoteReportBlock` 全部用它，避免两条路径预算漂移。
 * 12 000 字符 ≈ 父上下文可接受的单次回灌预算。
 */
export const DELEGATION_MAX_REPORT_CHARS = 12_000;
export const DELEGATION_MAX_TIMEOUT_SECONDS = 2 * 60 * 60;
export const DELEGATION_DEFAULT_TIMEOUT_SECONDS = 60 * 60;
/** 本地（进程内）`delegate_wait` 的默认等待秒数；桥接路径用 DEFAULT_TIMEOUT_SECONDS。 */
export const DELEGATION_LOCAL_WAIT_TIMEOUT_SECONDS = 10 * 60;
export const DELEGATION_MAX_CONCURRENCY = 8;

export interface DelegationUsage {
  input: number;
  output: number;
  totalTokens: number;
  cost: number;
}

/** 委派活动缓冲的单条记录（有界，随快照下发给渲染层展示）。 */
export interface DelegationActivity {
  at: number;
  kind: "tool" | "notice" | "report";
  text: string;
  isError?: boolean;
}

/**
 * 委派"完成"的统一定义（两套实现都必须遵守）：
 *
 * pi RPC 的 `prompt` 响应是"接收即返回"——preflight 成功就应答，不等整轮生成结束。
 * 因此判定委派完成绝不能以 prompt 的响应为依据，必须：
 * 1. 等到子代理空闲（一轮生成结束：本地用 `agent.waitForIdle()`，主进程用
 *    `AgentHost.waitForIdle()` 监听 `agent_settled`）；
 * 2. 空闲后取最后一条带文本的 assistant 消息作为最终报告（`extractAssistantReport`）；
 * 3. 空闲且仍无 assistant 文本才算真正的 no_report 失败。
 */
export const DELEGATION_COMPLETION_CONTRACT = "idle-then-last-assistant-text" as const;

/** 从消息数组里提取最后一条带文本的 assistant 消息作为最终报告；没有则返回空串。 */
export function extractAssistantReport(messages: unknown[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    const content = record.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

/** 判定依据的摘要：消息条数、最后一条消息的 role/type、assistant 轮次与工具调用数，供诊断日志与失败详情使用。 */
export function describeAssistantEvidence(messages: unknown[] | undefined): {
  count: number;
  lastRole?: string;
  lastType?: string;
  turns: number;
  toolCalls: number;
} {
  if (!Array.isArray(messages)) return { count: 0, turns: 0, toolCalls: 0 };
  const count = messages.length;
  let turns = 0;
  let toolCalls = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    turns += 1;
    if (Array.isArray(record.content)) {
      for (const part of record.content) {
        if (!part || typeof part !== "object") continue;
        const kind = (part as Record<string, unknown>).type;
        if (typeof kind === "string" && kind.toLowerCase().includes("tool")) toolCalls += 1;
      }
    }
  }
  const last = messages.at(-1);
  if (!last || typeof last !== "object") return { count, turns, toolCalls };
  const record = last as Record<string, unknown>;
  return {
    count,
    turns,
    toolCalls,
    ...(typeof record.role === "string" ? { lastRole: record.role } : {}),
    ...(typeof record.type === "string" ? { lastType: record.type } : {}),
  };
}

/** Serializable metadata shared by main, runtime and renderer. */
export interface DelegationRecordSnapshot {
  delegationId: string;
  parentSessionPath: string;
  childSessionPath?: string;
  cwd?: string;
  provider?: string;
  childRuntimeId?: string;
  title: string;
  role: string;
  task: string;
  permission: PermissionMode;
  model?: string;
  thinkingLevel?: string;
  status: DelegationStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
  report?: string;
  resultSummary?: string;
  live?: string;
  usage?: DelegationUsage;
  /** 有界活动缓冲（最近若干条），供失败态展示判定与运行轨迹。 */
  recent?: DelegationActivity[];
}

export interface DelegationStartPayload {
  title?: string;
  role?: string;
  task: string;
  permission?: PermissionMode;
  model?: string;
  thinkingLevel?: string;
  cwd: string;
  provider: string;
  sandbox: string;
  network: boolean;
  maxTokens?: number;
  baseUrl?: string;
  serviceId?: string;
  writableRoots?: string[];
}

export interface DelegationWaitPayload {
  delegationIds?: string[];
  mode?: "all" | "any";
  minCompleted?: number;
  timeoutSeconds?: number;
}

export interface DelegationGetPayload {
  delegationIds: string[];
}

export interface DelegationListPayload {
  includeCompleted?: boolean;
}

export interface DelegationStopPayload {
  delegationIds?: string[];
}

export interface DelegationContinuePayload {
  delegationId: string;
  message: string;
}

export type DelegationBridgePayload =
  | DelegationStartPayload
  | DelegationWaitPayload
  | DelegationGetPayload
  | DelegationListPayload
  | DelegationStopPayload
  | DelegationContinuePayload
  | Record<string, never>;

export interface DelegationBridgeRequest {
  type: typeof DELEGATION_BRIDGE_REQUEST;
  requestId: string;
  action: DelegationAction;
  parentSessionPath: string;
  payload: DelegationBridgePayload;
}

export interface DelegationBridgeResponse {
  type: typeof DELEGATION_BRIDGE_RESPONSE;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface DelegationBridgeEvent {
  type: typeof DELEGATION_BRIDGE_EVENT;
  event: DelegationRecordSnapshot;
}

export function isDelegationTerminal(status: DelegationStatus): boolean {
  return status !== "pending" && status !== "running";
}

export function isDelegationStatus(value: unknown): value is DelegationStatus {
  return typeof value === "string" && (DELEGATION_STATUSES as readonly string[]).includes(value);
}

export function isDelegationAction(value: unknown): value is DelegationAction {
  return typeof value === "string" && (DELEGATION_ACTIONS as readonly string[]).includes(value);
}

export function boundedDelegationText(value: string, limit = DELEGATION_MAX_REPORT_CHARS): string {
  const text = value.trim();
  if (text.length <= limit) return text;
  const suffix = `\n\n[delegation text truncated: ${text.length - limit} chars]\n\n`;
  if (limit <= suffix.length) return text.slice(0, limit);
  const available = limit - suffix.length;
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${text.slice(0, head)}${suffix}${text.slice(-tail)}`;
}

export function validateDelegationTask(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Delegation task must be a non-empty string.");
  }
  if (value.length > DELEGATION_MAX_TASK_CHARS) {
    throw new Error(`Delegation task exceeds ${DELEGATION_MAX_TASK_CHARS} characters.`);
  }
  return value.trim();
}

export function validateDelegationTimeout(value: unknown): number {
  const timeout = value === undefined ? DELEGATION_DEFAULT_TIMEOUT_SECONDS : value;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1) {
    throw new Error("Delegation timeout must be a positive integer.");
  }
  if (timeout > DELEGATION_MAX_TIMEOUT_SECONDS) {
    throw new Error(`Delegation timeout exceeds ${DELEGATION_MAX_TIMEOUT_SECONDS} seconds.`);
  }
  return timeout;
}

export function assertDelegationTransition(
  previous: DelegationStatus,
  next: DelegationStatus,
): void {
  if (previous === next) return;
  if (isDelegationTerminal(previous)) {
    throw new Error(`Cannot transition terminal delegation ${previous} to ${next}.`);
  }
  if (previous === "pending" && next !== "running" && next !== "cancelled" && next !== "failed") {
    throw new Error(`Invalid delegation transition: ${previous} -> ${next}.`);
  }
  if (previous === "running" && next === "pending") {
    throw new Error(`Invalid delegation transition: ${previous} -> ${next}.`);
  }
}

export function isDelegationBridgeResponse(value: unknown): value is DelegationBridgeResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === DELEGATION_BRIDGE_RESPONSE &&
    typeof record.requestId === "string" &&
    typeof record.ok === "boolean"
  );
}
