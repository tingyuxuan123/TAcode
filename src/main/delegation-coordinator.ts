import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertDelegationTransition,
  boundedDelegationText,
  describeAssistantEvidence,
  extractAssistantReport,
  DELEGATION_BRIDGE_EVENT,
  DELEGATION_MAX_CONCURRENCY,
  isDelegationTerminal,
  isDelegationAction,
  type DelegationAction,
  type DelegationActivity,
  type DelegationBridgeEvent,
  type DelegationBridgeRequest,
  type DelegationBridgeResponse,
  type DelegationContinuePayload,
  type DelegationRecordSnapshot,
  type DelegationStartPayload,
  type DelegationStatus,
} from "../shared/delegation.js";
import type { AgentSnapshot, PermissionMode } from "../shared/types.js";
import { getTacodeSessionsDir, partitionSessionFile } from "../runtime/home.js";
import { loadEnabledSubagents } from "../runtime/subagents.js";
import {
  TacodeStateStore,
  type DelegatedThreadInput,
} from "../runtime/state.js";
import type { SubagentDefinition } from "../shared/subagents.js";
import type { AgentHostStartOptions } from "./agent-manager.js";
import type { DiagnosticSink } from "./local-logger.js";

export interface DelegationHost {
  runtimeId: string;
  sessionKey?: string;
  requestedSessionPath?: string;
  isRunning(): boolean;
  start(options: AgentHostStartOptions): Promise<AgentSnapshot>;
  request<T>(type: string, data?: Record<string, unknown>): Promise<T>;
  stop(): Promise<void>;
  /** 等待 worker 空闲（完成契约见 shared/delegation.ts）；prompt 的响应是“接收即返回”，不能作为完成依据。 */
  waitForIdle(options?: { startGraceMs?: number }): Promise<void>;
  /** 最近一次 worker 退出信息（退出码/信号/stderr 摘要）；仍在运行时为 undefined。 */
  describeExit?(): { code?: number; signal?: string; stderrExcerpt: string } | undefined;
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
  /** 本地诊断日志（主进程注入 LocalLogger；只写本机，不上传）。 */
  log?: DiagnosticSink;
  /** 单次委派完成的兜底超时（毫秒）；默认 30 分钟，超时归类为 timeout 并显式停止子代理。 */
  completionTimeoutMs?: number;
}

interface DelegationEntry {
  record: DelegationRecordSnapshot;
  definition?: SubagentDefinition;
  host?: DelegationHost;
  completion: Promise<void>;
  resolveCompletion: () => void;
  stopRequested: boolean;
  /** 有界活动缓冲：启动/判定/终态证据，随快照下发供失败态展示。 */
  recent: DelegationActivity[];
}

const permissionRank: Record<PermissionMode, number> = {
  plan: 0,
  ask: 1,
  auto: 2,
  full: 3,
};

const permissions = new Set<PermissionMode>(["plan", "ask", "auto", "full"]);
const sandboxes = new Set(["read-only", "workspace-write", "danger-full-access"]);

const MAX_RECENT_ACTIVITIES = 60;
const MAX_ACTIVITY_TEXT_CHARS = 200;
/** 单次委派完成的兜底超时：超时归类 timeout，不再无限等待。 */
const DEFAULT_COMPLETION_TIMEOUT_MS = 30 * 60_000;

export class DelegationCoordinator {
  private readonly entries = new Map<string, DelegationEntry>();
  private readonly requestCache = new Map<string, DelegationBridgeResponse>();
  private readonly state: TacodeStateStore;
  private readonly ownsState: boolean;

  constructor(private readonly options: DelegationCoordinatorOptions) {
    this.state = options.stateStore ?? new TacodeStateStore();
    this.ownsState = !options.stateStore;
    this.hydratePersistedEntries();
    // 启动即对账：历史上被误判为 failed、但子会话里确有报告的记录自动回填自愈。
    void this.reconcilePersistedFailures().catch(() => undefined);
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
      delegationPermission: permission,
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
      // 先等 worker 真正停止，再落终态：不允许“状态 cancelled + 进程仍在跑”并存。
      await entry.host?.stop().catch(() => undefined);
      this.pushActivity(entry, { at: Date.now(), kind: "notice", text: "Stopped by the parent agent.", isError: true });
      this.log("info", "delegation stopped", {
        delegationId: entry.record.delegationId,
        status: entry.record.status,
        childSessionPath: entry.record.childSessionPath,
      });
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
    if (!isDelegationTerminal(entry.record.status)) {
      throw new Error("Delegation is still running.");
    }
    const startedAt = Date.now();
    const definition = entry.definition ?? (await loadEnabledSubagents()).find((item) => item.name === entry.record.role);
    if (!definition) throw new Error(`Subagent definition is no longer available: ${entry.record.role}`);
    entry.definition = definition;
    // worker 不在（应用重启/已被回收/真失败后停止）时原位重启，而不是死代码。
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
      this.pushActivity(entry, { at: Date.now(), kind: "notice", text: "Restarting worker for follow-up." });
      try {
        await host.start(startOptions);
      } catch (error) {
        this.settle(
          entry,
          entry.stopRequested ? "cancelled" : "failed",
          "",
          this.describeFailure("worker_exit", error, entry, startedAt),
        );
        return this.snapshot(entry);
      }
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
    const startedAt = Date.now();
    try {
      this.transition(entry, "running");
      this.pushActivity(entry, { at: startedAt, kind: "notice", text: `Launching worker (${definition.name}).` });
      this.log("info", "delegation launching", {
        delegationId: entry.record.delegationId,
        role: definition.name,
        childSessionPath: entry.record.childSessionPath,
        provider: entry.record.provider,
        model: entry.record.model,
        permission: entry.record.permission,
      });
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
      if (entry.stopRequested) {
        await entry.host?.stop().catch(() => undefined);
        this.settle(entry, "cancelled", "", "Stopped by the parent agent.");
        return;
      }
      const kind = "worker_exit";
      await entry.host?.stop().catch(() => undefined);
      this.settle(
        entry,
        "failed",
        "",
        this.describeFailure(kind, error, entry, startedAt),
      );
    }
  }

  /**
   * 判定委派完成（契约见 shared/delegation.ts 的 DELEGATION_COMPLETION_CONTRACT）：
   * prompt 的响应是“接收即返回”，必须先等子代理空闲，再提取最后一条 assistant 文本。
   * 失败原因分类：worker_exit / no_report / timeout / cancelled，绝不共用一句文案。
   */
  private async runPrompt(entry: DelegationEntry, message: string): Promise<void> {
    const startedAt = Date.now();
    const timeoutMs = this.options.completionTimeoutMs ?? DEFAULT_COMPLETION_TIMEOUT_MS;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
      timeoutTimer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        this.collectReport(entry, message, startedAt).then(() => "done" as const),
        timeout,
      ]);
      clearTimeout(timeoutTimer);
      if (outcome === "timeout") {
        const detail = this.describeFailure("timeout", undefined, entry, startedAt);
        this.pushActivity(entry, { at: Date.now(), kind: "notice", text: detail, isError: true });
        this.log("warn", "delegation timed out", {
          delegationId: entry.record.delegationId,
          childSessionPath: entry.record.childSessionPath,
          timeoutMs,
        });
        // 超时必须显式停止子代理：不留“状态 timeout + 进程仍在跑”的并存终局。
        await entry.host?.stop().catch(() => undefined);
        this.settle(entry, "failed", "", detail);
      }
    } catch (error) {
      clearTimeout(timeoutTimer);
      const host = entry.host;
      const exit = host?.describeExit?.();
      const workerGone = Boolean(exit) || (host !== undefined && !host.isRunning());
      if (entry.stopRequested) {
        await host?.stop().catch(() => undefined);
        this.settle(entry, "cancelled", "", "Stopped by the parent agent.");
        return;
      }
      const detail = this.describeFailure(workerGone ? "worker_exit" : "worker_error", error, entry, startedAt);
      this.pushActivity(entry, { at: Date.now(), kind: "notice", text: detail, isError: true });
      this.log("warn", "delegation failed", {
        delegationId: entry.record.delegationId,
        reason: workerGone ? "worker_exit" : "worker_error",
        childSessionPath: entry.record.childSessionPath,
        detail,
      });
      // 真失败也要停掉子代理，避免“状态 failed + 进程 running”并存。
      await host?.stop().catch(() => undefined);
      this.settle(entry, "failed", "", detail);
    }
  }

  /** 等待空闲并收集最终报告；失败（RPC 错误/worker 消亡）时抛出，由 runPrompt 分类。 */
  private async collectReport(entry: DelegationEntry, message: string, startedAt: number): Promise<void> {
    const host = entry.host;
    if (!host) throw new Error("Delegated worker host is missing.");
    await host.request("prompt", { message });
    this.pushActivity(entry, { at: Date.now(), kind: "notice", text: "Prompt accepted; waiting for the worker to settle." });
    await host.waitForIdle();
    const result = await host.request<{ messages?: unknown[] }>("get_messages");
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    const evidence = describeAssistantEvidence(messages);
    const report = extractAssistantReport(messages);
    this.log("info", "delegation completion judged", {
      delegationId: entry.record.delegationId,
      childSessionPath: entry.record.childSessionPath,
      childRuntimeId: host.runtimeId,
      elapsedMs: Date.now() - startedAt,
      ...evidence,
      hasReport: Boolean(report),
    });
    if (!report) {
      const detail = this.describeFailure("no_report", undefined, entry, startedAt, evidence);
      this.pushActivity(entry, { at: Date.now(), kind: "notice", text: detail, isError: true });
      // 空闲后仍无 assistant 文本：真正的 no_report。停掉 worker 再落终态。
      await host.stop().catch(() => undefined);
      this.settle(entry, "failed", "", detail);
      return;
    }
    this.pushActivity(entry, { at: Date.now(), kind: "report", text: boundedDelegationText(report, MAX_ACTIVITY_TEXT_CHARS) });
    this.settle(entry, "completed", report);
    await this.state.indexSession(entry.record.childSessionPath!).catch(() => undefined);
  }

  /** 失败详情：分类 + 退出信息 + 判定证据（子会话路径、最后消息、轮次、耗时）。 */
  private describeFailure(
    reason: "worker_exit" | "worker_error" | "no_report" | "timeout",
    error: unknown,
    entry: DelegationEntry,
    startedAt: number,
    evidence?: ReturnType<typeof describeAssistantEvidence>,
  ): string {
    const host = entry.host;
    const exit = host?.describeExit?.();
    const parts: string[] = [];
    if (reason === "worker_exit") {
      parts.push("The delegated worker exited before finishing.");
      if (exit && (exit.code !== undefined || exit.signal)) {
        parts.push(`exit code ${exit.code ?? "unknown"}${exit.signal ? `, signal ${exit.signal}` : ""}`);
      }
      if (exit?.stderrExcerpt) parts.push(`stderr: ${exit.stderrExcerpt.slice(-500)}`);
      if (error instanceof Error && error.message && !error.message.startsWith("Agent stopped")) {
        parts.push(error.message);
      } else if (error !== undefined && !(error instanceof Error)) {
        parts.push(String(error));
      }
    } else if (reason === "no_report") {
      parts.push("The delegated worker finished without writing a report (no assistant text after the turn settled).");
    } else if (reason === "timeout") {
      parts.push(`The delegated worker did not finish within ${Math.round((Date.now() - startedAt) / 1_000)}s and was stopped.`);
    } else {
      parts.push(`The delegated worker failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const turns = evidence?.turns;
    parts.push(
      `[reason=${reason}; childSessionPath=${entry.record.childSessionPath ?? "unknown"}; childRuntimeId=${host?.runtimeId ?? entry.record.childRuntimeId ?? "unknown"}${
        evidence ? `; messages=${evidence.count}; lastMessage=${evidence.lastRole ?? "unknown"}/${evidence.lastType ?? "unknown"}; turns=${turns ?? 0}; toolCalls=${evidence.toolCalls ?? 0}` : ""
      }; elapsedMs=${Date.now() - startedAt}]`,
    );
    return parts.join(" ");
  }

  /** 有界活动缓冲（与 runtime delegate 工具一致的上限与截断）。 */
  private pushActivity(entry: DelegationEntry, activity: DelegationActivity): void {
    entry.recent.push({
      ...activity,
      text: activity.text.length > MAX_ACTIVITY_TEXT_CHARS
        ? `${activity.text.slice(0, MAX_ACTIVITY_TEXT_CHARS)}…`
        : activity.text,
    });
    if (entry.recent.length > MAX_RECENT_ACTIVITIES) {
      entry.recent.splice(0, entry.recent.length - MAX_RECENT_ACTIVITIES);
    }
  }

  private log(level: "info" | "warn" | "error", message: string, details?: unknown): void {
    this.options.log?.[level]("delegation", message, details);
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
      recent: [],
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
    this.log("info", "delegation settled", {
      delegationId: entry.record.delegationId,
      status,
      elapsedMs: entry.record.completedAt - entry.record.startedAt,
      reportChars: entry.record.report.length,
      error: entry.record.error,
      childSessionPath: entry.record.childSessionPath,
    });
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
      ...(entry.recent.length ? { recent: entry.recent.slice(-MAX_RECENT_ACTIVITIES) } : {}),
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
      // 恢复持久化的 permission（旧数据可能缺失，才回退默认值），避免续跑时越权。
      const permission: PermissionMode = thread.delegationPermission && permissions.has(thread.delegationPermission)
        ? thread.delegationPermission
        : "auto";
      const record: DelegationRecordSnapshot = {
        delegationId: thread.sourceDelegationId,
        parentSessionPath: thread.parentSessionPath,
        childSessionPath: thread.sessionPath,
        cwd: thread.cwd,
        ...(thread.provider ? { provider: thread.provider } : {}),
        title: thread.title,
        role: thread.delegationRole ?? "unknown",
        task: thread.delegationGoal ?? "",
        permission,
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

  /**
   * 启动对账：历史上被判 failed、但子会话 JSONL 末尾确有 assistant 报告的记录
   * （完成判定竞态的受害者），回填报告并置为 completed、清除过期的 error。
   * 只处理没有活跃 worker 的水合记录，不干预本进程内的实时判定。
   */
  async reconcilePersistedFailures(): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      if (entry.record.status !== "failed" || entry.host) continue;
      const childSessionPath = entry.record.childSessionPath;
      if (!childSessionPath || entry.record.report) continue;
      const report = await readSessionTrailingAssistantReport(childSessionPath);
      if (!report) continue;
      entry.record.status = "completed";
      entry.record.report = boundedDelegationText(report);
      entry.record.resultSummary = boundedDelegationText(report, 240);
      entry.record.error = undefined;
      if (!entry.record.completedAt) entry.record.completedAt = Date.now();
      this.pushActivity(entry, { at: Date.now(), kind: "notice", text: "Recovered report from the child session after a misjudged failure." });
      this.persist(entry);
      this.publish(entry);
      this.log("info", "delegation failure reconciled to completed", {
        delegationId: entry.record.delegationId,
        childSessionPath,
        reportChars: entry.record.report.length,
      });
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

/**
 * 读取子会话 JSONL 末尾的 assistant 报告（对账回填用）。
 * 与 state.ts 的 parseSession 一致：`{type:"message", message:{role, content}}` 行。
 * 文件缺失/损坏时返回空串（对账是尽力而为，不影响主流程）。
 */
async function readSessionTrailingAssistantReport(sessionPath: string): Promise<string> {
  try {
    const partitioned = await partitionSessionFile(sessionPath);
    const raw = await readFile(partitioned.runtimePath, "utf8");
    const messages: unknown[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).type === "message") {
          messages.push((parsed as Record<string, unknown>).message);
        }
      } catch {
        continue;
      }
    }
    return extractAssistantReport(messages);
  } catch {
    return "";
  }
}
