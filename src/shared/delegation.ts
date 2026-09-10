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
export const DELEGATION_MAX_REPORT_CHARS = 50_000;
export const DELEGATION_MAX_TIMEOUT_SECONDS = 2 * 60 * 60;
export const DELEGATION_DEFAULT_TIMEOUT_SECONDS = 60 * 60;
export const DELEGATION_MAX_CONCURRENCY = 8;

export interface DelegationUsage {
  input: number;
  output: number;
  totalTokens: number;
  cost: number;
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
