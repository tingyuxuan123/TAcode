import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  assertDelegationTransition,
  boundedDelegationText,
  DELEGATION_BRIDGE_EVENT,
  DELEGATION_MAX_CONCURRENCY,
  isDelegationTerminal,
  isDelegationAction,
  type DelegationAction,
  type DelegationBridgeEvent,
  type DelegationBridgeRequest,
  type DelegationBridgeResponse,
  type DelegationContinuePayload,
  type DelegationRecordSnapshot,
  type DelegationStartPayload,
  type DelegationStatus,
} from "../shared/delegation.js";
import type { AgentSnapshot, PermissionMode } from "../shared/types.js";
import { getTacodeSessionsDir } from "../runtime/home.js";
import { loadEnabledSubagents } from "../runtime/subagents.js";
import {
  TacodeStateStore,
  type DelegatedThreadInput,
} from "../runtime/state.js";
import type { SubagentDefinition } from "../shared/subagents.js";
import type { AgentHostStartOptions } from "./agent-manager.js";

export interface DelegationHost {
  runtimeId: string;
  sessionKey?: string;
  requestedSessionPath?: string;
  isRunning(): boolean;
  start(options: AgentHostStartOptions): Promise<AgentSnapshot>;
  request<T>(type: string, data?: Record<string, unknown>): Promise<T>;
  stop(): Promise<void>;
}

export interface DelegationCoordinatorOptions {
  createHost(runtimeId: string, delegationId: string): DelegationHost;
  findParentHost(sessionPath: string): DelegationHost | undefined;
  buildStartOptions(
    payload: DelegationStartPayload,
    definition: SubagentDefinition,
    sessionPath: string,
  ): Promise<AgentHostStartOptions>;
  stateStore?: TacodeStateStore;
  emitEvent?(parentSessionPath: string, event: DelegationBridgeEvent): void;
}

interface DelegationEntry {
  record: DelegationRecordSnapshot;
  definition?: SubagentDefinition;
  host?: DelegationHost;
  completion: Promise<void>;
  resolveCompletion: () => void;
  stopRequested: boolean;
}

const permissionRank: Record<PermissionMode, number> = {
  plan: 0,
  ask: 1,
  auto: 2,
  full: 3,
};

const permissions = new Set<PermissionMode>(["plan", "ask", "auto", "full"]);
const sandboxes = new Set(["read-only", "workspace-write", "danger-full-access"]);

export class DelegationCoordinator {
  private readonly entries = new Map<string, DelegationEntry>();
  private readonly requestCache = new Map<string, DelegationBridgeResponse>();
  private readonly state: TacodeStateStore;
  private readonly ownsState: boolean;

  constructor(private readonly options: DelegationCoordinatorOptions) {
    this.state = options.stateStore ?? new TacodeStateStore();
    this.ownsState = !options.stateStore;
    this.hydratePersistedEntries();
  }

  async close(): Promise<void> {
    await this.stopAll();
    if (this.ownsState) this.state.close();
  }

  async handleRequest(
    request: DelegationBridgeRequest,
    requester: DelegationHost,
  ): Promise<unknown> {
    const parentSessionPath = path.resolve(request.parentSessionPath);
    if (!isDelegationAction(request.action) || typeof request.requestId !== "string" || request.requestId.length < 1 || request.requestId.length > 256) {
      throw new Error("Invalid delegation bridge request.");
    }
    const parentHost = this.options.findParentHost(parentSessionPath);
    if (!parentHost || parentHost !== requester) {
      throw new Error("Delegation parent session is no longer active.");
    }
    if (!this.isRequesterForSession(requester, parentSessionPath)) {
      throw new Error("Delegation request is not associated with the requesting session.");
    }
    const cacheKey = `${parentSessionPath}:${request.requestId}`;
    const cached = this.requestCache.get(cacheKey);
    if (cached) {
      if (!cached.ok) throw new Error(cached.error ?? "Delegation request failed.");
      return cached.result;
    }

    let result: unknown;
    switch (request.action) {
      case "start":
        result = await this.start(parentSessionPath, request.payload as DelegationStartPayload);
        break;
      case "list":
        result = this.list(parentSessionPath, request.payload as { includeCompleted?: boolean });
        break;
      case "get":
      case "get_results":
        result = this.get(parentSessionPath, request.payload as { delegationIds?: string[] });
        break;
      case "wait":
        result = await this.wait(parentSessionPath, request.payload as {
          delegationIds?: string[];
          mode?: "all" | "any";
          minCompleted?: number;
          timeoutSeconds?: number;
        });
        break;
      case "stop":
        result = await this.stop(parentSessionPath, request.payload as { delegationIds?: string[] });
        break;
      case "continue":
        result = await this.continue(parentSessionPath, request.payload as DelegationContinuePayload);
        break;
      default:
        throw new Error(`Unsupported delegation action: ${String(request.action)}`);
    }
    this.cacheResponse(cacheKey, { type: "tacode:delegation:response", requestId: request.requestId, ok: true, result });
    return result;
  }

  list(parentSessionPath: string, payload: { includeCompleted?: boolean } = {}): DelegationRecordSnapshot[] {
    const records = this.entriesForParent(parentSessionPath);
    return records
      .filter((entry) => payload.includeCompleted !== false || !isDelegationTerminal(entry.record.status))
      .map((entry) => this.snapshot(entry));
  }

  get(parentSessionPath: string, payload: { delegationIds?: string[] } = {}): DelegationRecordSnapshot[] {
    const ids = payload.delegationIds;
    return this.entriesForParent(parentSessionPath)
      .filter((entry) => !ids?.length || ids.includes(entry.record.delegationId))
      .map((entry) => this.snapshot(entry));
  }

  async start(parentSessionPath: string, payload: DelegationStartPayload): Promise<DelegationRecordSnapshot> {
    const normalized = this.validateStartPayload(payload);
    if (this.isDelegatedSession(parentSessionPath)) {
      throw new Error("Delegated sessions cannot create further delegations.");
    }
    const active = this.entriesForParent(parentSessionPath).filter(
      (entry) => !isDelegationTerminal(entry.record.status),
    ).length;
    if (active >= DELEGATION_MAX_CONCURRENCY) {
      throw new Error(`Too many concurrent delegations (limit ${DELEGATION_MAX_CONCURRENCY}).`);
    }
    const definitions = await loadEnabledSubagents();
    const definition = definitions.find((item) => item.name === normalized.role);
    if (!definition) throw new Error(`Unknown subagent: ${normalized.role}`);

    const delegationId = `delegation-${randomUUID()}`;
    const childSessionPath = path.join(getTacodeSessionsDir(), `${delegationId}.jsonl`);
    const permission = effectivePermission(normalized.permission, definition.permission);
    const childProvider = definition.model?.providerId ?? normalized.provider;
    const childModel = definition.model?.modelId ?? normalized.model;
    const childPayload: DelegationStartPayload = {
      ...normalized,
      permission,
      provider: childProvider,
      ...(childModel ? { model: childModel } : {}),
    };
    const record: DelegationRecordSnapshot = {
      delegationId,
      parentSessionPath,
      childSessionPath,
      cwd: normalized.cwd,
      provider: childProvider,
      title: normalized.title,
      role: definition.name,
      task: normalized.task,
      permission,
      ...(childModel ? { model: childModel } : {}),
      ...(normalized.thinkingLevel ? { thinkingLevel: normalized.thinkingLevel } : {}),
      status: "pending",
      startedAt: Date.now(),
    };
    const input: DelegatedThreadInput = {
      id: delegationId,
      sessionPath: childSessionPath,
      cwd: normalized.cwd,
      title: normalized.title,
      ...(childProvider ? { provider: childProvider } : {}),
      ...(childModel ? { model: childModel } : {}),
      parentSessionPath,
      sourceDelegationId: delegationId,
      delegationRole: definition.name,
      delegationStatus: "pending",
      delegationDepth: 1,
      delegationGoal: normalized.task,
      createdAt: record.startedAt,
    };
    this.state.createDelegatedThread(input);
    const entry = this.createEntry(record, definition);
    this.publish(entry);
    void this.launch(entry, childPayload, definition);
    return this.snapshot(entry);
  }

  async wait(
    parentSessionPath: string,
    payload: {
      delegationIds?: string[];
      mode?: "all" | "any";
      minCompleted?: number;
      timeoutSeconds?: number;
    } = {},
  ): Promise<{ status: "completed" | "timeout"; delegations: DelegationRecordSnapshot[] }> {
    const entries = this.entriesForParent(parentSessionPath).filter(
      (entry) => !payload.delegationIds?.length || payload.delegationIds.includes(entry.record.delegationId),
    );
    if (entries.length === 0) return { status: "completed", delegations: [] };
    const target = payload.mode === "any"
      ? Math.max(1, Math.min(payload.minCompleted ?? 1, entries.length))
      : entries.length;
    const timeoutSeconds = payload.timeoutSeconds ?? 3_600;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 7_200) {
      throw new Error("Delegation timeout must be an integer between 1 and 7200 seconds.");
    }
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const waitForTarget = new Promise<void>((resolve) => {
      const poll = (): void => {
        const completed = entries.filter((entry) => isDelegationTerminal(entry.record.status)).length;
        if (completed >= target) resolve();
        else pollTimer = setTimeout(poll, 25);
      };
      poll();
    });
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutTimer = setTimeout(() => resolve("timeout"), timeoutSeconds * 1_000);
      timeoutTimer.unref?.();
    });
    const result = await Promise.race([waitForTarget.then(() => "completed" as const), timeout]);
    if (pollTimer) clearTimeout(pollTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    return { status: result, delegations: entries.map((entry) => this.snapshot(entry)) };
  }

  async stop(parentSessionPath: string, payload: { delegationIds?: string[] } = {}): Promise<DelegationRecordSnapshot[]> {
    const entries = this.entriesForParent(parentSessionPath).filter(
      (entry) => !payload.delegationIds?.length || payload.delegationIds.includes(entry.record.delegationId),
    );
    await Promise.all(entries.map(async (entry) => {
      if (isDelegationTerminal(entry.record.status)) return;
      entry.stopRequested = true;
      await entry.host?.stop().catch(() => undefined);
      this.settle(entry, "cancelled", "", "Stopped by the parent agent.");
    }));
    return entries.map((entry) => this.snapshot(entry));
  }

  async continue(parentSessionPath: string, payload: DelegationContinuePayload): Promise<DelegationRecordSnapshot> {
    if (!payload || typeof payload.delegationId !== "string" || typeof payload.message !== "string") {
      throw new Error("Delegation continue requires delegationId and message.");
    }
    const entry = this.entriesForParent(parentSessionPath).find(
      (candidate) => candidate.record.delegationId === payload.delegationId,
    );
    if (!entry) throw new Error("Delegation not found for this parent session.");
    if (!entry.host || !entry.host.isRunning()) {
      throw new Error("Delegation worker is no longer available; start a new delegation.");
    }
    if (!isDelegationTerminal(entry.record.status)) {
      throw new Error("Delegation is still running.");
    }
    const definition = entry.definition ?? (await loadEnabledSubagents()).find((item) => item.name === entry.record.role);
    if (!definition) throw new Error(`Subagent definition is no longer available: ${entry.record.role}`);
    entry.definition = definition;
    if (!entry.host || !entry.host.isRunning()) {
      const host = this.options.createHost(`delegation-runtime-${entry.record.delegationId}`, entry.record.delegationId);
      entry.host = host;
      const startPayload: DelegationStartPayload = {
        role: definition.name,
        title: entry.record.title,
        task: entry.record.task,
        cwd: entry.record.cwd ?? path.dirname(entry.record.parentSessionPath),
        provider: entry.record.provider ?? "deepseek",
        ...(entry.record.model ? { model: entry.record.model } : {}),
        permission: entry.record.permission,
        sandbox: "workspace-write",
        network: false,
      };
      const startOptions = await this.options.buildStartOptions(
        startPayload,
        definition,
        entry.record.childSessionPath!,
      );
      await host.start(startOptions);
    }
    entry.stopRequested = false;
    this.resetCompletion(entry);
    entry.record.status = "pending";
    entry.record.error = undefined;
    entry.record.report = "";
    this.transition(entry, "running");
    entry.record.task = `${entry.record.task}\n\nFollow-up: ${payload.message.trim()}`;
    this.persist(entry);
    this.publish(entry);
    void this.runPrompt(entry, payload.message.trim());
    return this.snapshot(entry);
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        if (!isDelegationTerminal(entry.record.status)) this.settle(entry, "interrupted", "", "Application stopped.");
        await entry.host?.stop().catch(() => undefined);
      }),
    );
  }

  private async launch(
    entry: DelegationEntry,
    payload: DelegationStartPayload,
    definition: SubagentDefinition,
  ): Promise<void> {
    try {
      this.transition(entry, "running");
      const host = this.options.createHost(`delegation-runtime-${entry.record.delegationId}`, entry.record.delegationId);
      entry.host = host;
      const startOptions = await this.options.buildStartOptions(
        payload,
        definition,
        entry.record.childSessionPath!,
      );
      await host.start(startOptions);
      await this.runPrompt(entry, composeChildTask(definition, entry.record.task, payload.cwd));
    } catch (error) {
      this.settle(
        entry,
        entry.stopRequested ? "cancelled" : "failed",
        "",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async runPrompt(entry: DelegationEntry, message: string): Promise<void> {
    try {
      await entry.host!.request("prompt", { message });
      const result = await entry.host!.request<{ messages?: unknown[] }>("get_messages");
      const report = extractAssistantReport(result?.messages);
      if (!report) {
        this.settle(entry, "failed", "", "The delegated worker finished without a report.");
        return;
      }
      this.settle(entry, "completed", report);
      await this.state.indexSession(entry.record.childSessionPath!).catch(() => undefined);
    } catch (error) {
      this.settle(
        entry,
        entry.stopRequested ? "cancelled" : "failed",
        "",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private createEntry(record: DelegationRecordSnapshot, definition?: SubagentDefinition): DelegationEntry {
    let resolveCompletion = (): void => undefined;
    const entry: DelegationEntry = {
      record,
      definition,
      completion: new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      }),
      resolveCompletion: () => resolveCompletion(),
      stopRequested: false,
    };
    this.entries.set(record.delegationId, entry);
    return entry;
  }

  private resetCompletion(entry: DelegationEntry): void {
    entry.completion = new Promise<void>((resolve) => {
      entry.resolveCompletion = resolve;
    });
  }

  private transition(entry: DelegationEntry, status: DelegationStatus): void {
    assertDelegationTransition(entry.record.status, status);
    entry.record.status = status;
    this.persist(entry);
    this.publish(entry);
  }

  private settle(entry: DelegationEntry, status: DelegationStatus, report: string, error?: string): void {
    if (isDelegationTerminal(entry.record.status)) return;
    this.transition(entry, status);
    entry.record.report = boundedDelegationText(report);
    entry.record.resultSummary = boundedDelegationText(report, 240);
    if (error) entry.record.error = boundedDelegationText(error, 4_000);
    entry.record.completedAt = Date.now();
    this.persist(entry);
    this.publish(entry);
    entry.resolveCompletion();
  }

  private persist(entry: DelegationEntry): void {
    this.state.updateDelegation(entry.record.delegationId, {
      title: entry.record.title,
      delegationStatus: entry.record.status,
      delegationGoal: entry.record.task,
      ...(entry.record.report !== undefined ? { delegationReport: entry.record.report } : {}),
      ...(entry.record.error !== undefined ? { delegationError: entry.record.error } : {}),
      ...(entry.record.completedAt
        ? { delegationCompletedAt: new Date(entry.record.completedAt).toISOString() }
        : {}),
      ...(entry.record.resultSummary !== undefined ? { preview: entry.record.resultSummary } : {}),
    });
  }

  private publish(entry: DelegationEntry): void {
    this.options.emitEvent?.(entry.record.parentSessionPath, {
      type: DELEGATION_BRIDGE_EVENT,
      event: this.snapshot(entry),
    });
  }

  private snapshot(entry: DelegationEntry): DelegationRecordSnapshot {
    return {
      ...entry.record,
      ...(entry.host?.runtimeId ? { childRuntimeId: entry.host.runtimeId } : {}),
      ...(entry.record.report ? { report: boundedDelegationText(entry.record.report) } : {}),
    };
  }

  private entriesForParent(parentSessionPath: string): DelegationEntry[] {
    const normalized = path.resolve(parentSessionPath);
    return [...this.entries.values()].filter((entry) => entry.record.parentSessionPath === normalized);
  }

  private isDelegatedSession(parentSessionPath: string): boolean {
    return [...this.entries.values()].some(
      (entry) => entry.record.childSessionPath && path.resolve(entry.record.childSessionPath) === path.resolve(parentSessionPath),
    );
  }

  private isRequesterForSession(requester: DelegationHost, parentSessionPath: string): boolean {
    return [requester.sessionKey, requester.requestedSessionPath]
      .filter((value): value is string => typeof value === "string")
      .some((value) => path.resolve(value) === parentSessionPath);
  }

  private validateStartPayload(payload: DelegationStartPayload): DelegationStartPayload & { role: string; title: string; task: string } {
    if (!payload || typeof payload !== "object") throw new Error("Invalid delegation payload.");
    if (typeof payload.task !== "string" || !payload.task.trim()) throw new Error("Delegation task is required.");
    if (payload.task.length > 10_000) throw new Error("Delegation task is too long.");
    if (typeof payload.role !== "string" || !payload.role.trim()) throw new Error("Delegation role is required.");
    if (typeof payload.cwd !== "string" || !path.isAbsolute(payload.cwd)) throw new Error("Delegation cwd must be absolute.");
    if (typeof payload.provider !== "string" || !payload.provider) throw new Error("Delegation provider is required.");
    if (typeof payload.sandbox !== "string" || !sandboxes.has(payload.sandbox)) throw new Error("Invalid delegation sandbox.");
    if (typeof payload.network !== "boolean") throw new Error("Delegation network must be boolean.");
    if (payload.permission !== undefined && !permissions.has(payload.permission)) throw new Error("Invalid delegation permission.");
    return {
      ...payload,
      task: payload.task.trim(),
      role: payload.role.trim(),
      title: typeof payload.title === "string" && payload.title.trim() ? payload.title.trim().slice(0, 200) : payload.role.trim(),
    };
  }

  private cacheResponse(key: string, response: DelegationBridgeResponse): void {
    this.requestCache.set(key, response);
    if (this.requestCache.size > 512) {
      const first = this.requestCache.keys().next().value;
      if (typeof first === "string") this.requestCache.delete(first);
    }
  }

  private hydratePersistedEntries(): void {
    for (const thread of this.state.list({ includeArchived: true })) {
      if (!thread.sourceDelegationId || !thread.parentSessionPath || !thread.delegationStatus) continue;
      let status = thread.delegationStatus;
      if (status === "pending" || status === "running") status = "interrupted";
      const record: DelegationRecordSnapshot = {
        delegationId: thread.sourceDelegationId,
        parentSessionPath: thread.parentSessionPath,
        childSessionPath: thread.sessionPath,
        cwd: thread.cwd,
        ...(thread.provider ? { provider: thread.provider } : {}),
        title: thread.title,
        role: thread.delegationRole ?? "unknown",
        task: thread.delegationGoal ?? "",
        permission: "auto",
        ...(thread.model ? { model: thread.model } : {}),
        status,
        startedAt: Date.parse(thread.createdAt),
        ...(thread.delegationCompletedAt ? { completedAt: Date.parse(thread.delegationCompletedAt) } : {}),
        ...(thread.delegationReport ? { report: thread.delegationReport } : {}),
        ...(thread.delegationError ? { error: thread.delegationError } : {}),
        ...(thread.preview ? { resultSummary: thread.preview } : {}),
      };
      const entry = this.createEntry(record);
      if (status !== thread.delegationStatus) this.persist(entry);
      entry.resolveCompletion();
    }
  }
}

function effectivePermission(parent: PermissionMode | undefined, requested: SubagentDefinition["permission"]): PermissionMode {
  const parentMode = parent && permissions.has(parent) ? parent : "auto";
  if (!requested || requested === "inherit") return parentMode;
  const requestedMode = requested as PermissionMode;
  return permissionRank[requestedMode] <= permissionRank[parentMode] ? requestedMode : parentMode;
}

function composeChildTask(definition: SubagentDefinition, task: string, cwd: string): string {
  return [
    `You are the ${definition.name} subagent inside TACode. You cannot ask questions or delegate further.`,
    `Use only these tools: ${definition.tools.join(", ") || "none"}.`,
    definition.prompt,
    `Working directory: ${cwd}`,
    "Return a concise, self-contained final report with exact paths and line numbers where relevant.",
    "Delegated task:",
    task,
  ].filter((part) => part.trim()).join("\n\n");
}

function extractAssistantReport(messages: unknown[] | undefined): string {
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
