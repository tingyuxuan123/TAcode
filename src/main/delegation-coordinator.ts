import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertDelegationTransition,
  boundedDelegationText,
  DELEGATION_REPORT_NUDGE,
  describeAssistantEvidence,
  extractAssistantReport,
  DELEGATION_BRIDGE_EVENT,
  DELEGATION_DEFAULT_TIMEOUT_SECONDS,
  DELEGATION_MAX_CONCURRENCY,
  DELEGATION_MAX_TIMEOUT_SECONDS,
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
import { unknownSubagentMessage, type SubagentDefinition } from "../shared/subagents.js";
import { composeSubagentSystemPrompt } from "../shared/subagent-prompts.js";
import { delegationTurnLimit } from "./delegation-run-options.js";
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
  /** no_report 已自动重试过一次（只重试一次，不无限循环）。 */
  noReportRetried?: boolean;
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
/**
 * 进程内保留的终态委派上限：`entries` 之前没有删除点，长会话里会随历史线性增长
 * （`entriesForParent` 每次 O(n) 过滤）。超过上限时淘汰最旧的终态条目，但
 * **刚结束的**（默认 60s 内）与仍有存活 host 的一律保留，避免打断 `delegate_continue`/对账。
 */
const MAX_RETAINED_TERMINAL_ENTRIES = 200;
const TERMINAL_RETENTION_MS = 60_000;
const MAX_ACTIVITY_TEXT_CHARS = 200;
/** 单次委派完成的兜底超时：超时归类 timeout，不再无限等待。 */
const DEFAULT_COMPLETION_TIMEOUT_MS = 30 * 60_000;
/** 轮数看门狗的轮询间隔；比它更细的意义不大，子代理自己也会按同一上限收口。 */
const TURN_LIMIT_POLL_MS = 500;

export class DelegationCoordinator {
  private readonly entries = new Map<string, DelegationEntry>();
  /** parentSessionPath → 该父会话的委派 id，避免每次 list/wait 全表扫描。 */
  private readonly entriesByParent = new Map<string, Set<string>>();
  /** 已通过上限检查、但尚未建表的同步占位（parentSessionPath → 计数）。 */
  private readonly reservations = new Map<string, number>();
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
    // 上限检查与真正建表之间有 await（读定义/建选项），必须**同步占位**：
    // 否则并发提交的多次 start 会一起通过检查，突破 DELEGATION_MAX_CONCURRENCY。
    const reserved = this.reservations.get(parentSessionPath) ?? 0;
    const active = this.entriesForParent(parentSessionPath).filter(
      (entry) => !isDelegationTerminal(entry.record.status),
    ).length;
    if (active + reserved >= DELEGATION_MAX_CONCURRENCY) {
      throw new Error(`Too many concurrent delegations (limit ${DELEGATION_MAX_CONCURRENCY}).`);
    }
    this.reservations.set(parentSessionPath, reserved + 1);
    try {
      return await this.startReserved(parentSessionPath, normalized);
    } finally {
      const left = (this.reservations.get(parentSessionPath) ?? 1) - 1;
      if (left > 0) this.reservations.set(parentSessionPath, left);
      else this.reservations.delete(parentSessionPath);
    }
  }

  private async startReserved(
    parentSessionPath: string,
    normalized: ReturnType<DelegationCoordinator["validateStartPayload"]>,
  ): Promise<DelegationRecordSnapshot> {
    const definitions = await loadEnabledSubagents();
    const definition = definitions.find((item) => item.name === normalized.role);
    // 模型看不到子代理目录，报错必须附可用清单 + 最接近的名字，否则它会继续猜角色名。
    if (!definition) throw new Error(unknownSubagentMessage(normalized.role, definitions));

    const delegationId = `delegation-${randomUUID()}`;
    const childSessionPath = path.join(getTacodeSessionsDir(), `${delegationId}.jsonl`);
    if (!normalized.permission || !permissions.has(normalized.permission)) {
      // 父权限缺失/非法：按最保守值处理并留痕（相对越权比误拦难排查得多）。
      this.log("warn", "delegation start without usable parent permission", {
        delegationId,
        role: normalized.role,
        parentPermission: normalized.permission,
      });
    }
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
    const timeoutSeconds = payload.timeoutSeconds ?? DELEGATION_DEFAULT_TIMEOUT_SECONDS;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > DELEGATION_MAX_TIMEOUT_SECONDS) {
      throw new Error(`Delegation timeout must be an integer between 1 and ${DELEGATION_MAX_TIMEOUT_SECONDS} seconds.`);
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
      const host = this.createDelegationHost(entry.record.delegationId);
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
        // 定义里的工具集与命令策略：主进程是旧构建时这里会明显不对（真实踩过一次）。
        tools: definition.tools.join(", "),
        execPolicy: definition.execPolicy ?? "full",
      });
      const host = this.createDelegationHost(entry.record.delegationId);
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
    // 轮数预算：角色定义里的 maxTurns（缺省 MAX_SUBAGENT_MAX_TURNS）。
    // 基准按「本次新增的 assistant 轮次」算——`continue` 会在同一 host 上再跑一轮，
    // 用绝对轮次会让续跑立刻撞上限。
    let limit = delegationTurnLimit(entry.definition ?? {});
    let baselineTurns = 0;
    try {
      baselineTurns = await this.assistantTurns(entry);
    } catch {
      // 读不到基准就不启用本轮上限（而不是当作 0 误判）：宁可等兜底超时，也不误杀健康运行。
      this.log("warn", "delegation turn baseline unavailable; turn limit skipped for this run", {
        delegationId: entry.record.delegationId,
      });
      limit = Number.POSITIVE_INFINITY;
    }
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let limitTimer: ReturnType<typeof setInterval> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
      timeoutTimer.unref?.();
    });
    // 看门狗：子代理自己也会按同一个上限收口（runtime 的 turn_end 钩子），这里兜底
    // 「子代理没停」的情况，避免只能等 30 分钟兜底超时。
    const turnLimit = new Promise<"turn_limit">((resolve) => {
      limitTimer = setInterval(() => {
        void this.assistantTurns(entry)
          .then((turns) => {
            if (turns - baselineTurns >= limit) resolve("turn_limit");
          })
          .catch(() => undefined);
      }, TURN_LIMIT_POLL_MS);
      limitTimer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        this.collectReport(entry, message, startedAt, { baselineTurns, limit }).then(() => "done" as const),
        turnLimit,
        timeout,
      ]);
      clearTimeout(timeoutTimer);
      clearInterval(limitTimer);
      if (outcome === "turn_limit") {
        const detail = `The delegated worker exceeded its turn limit (${limit} turns) and was stopped; the report below is what it had produced.`;
        this.pushActivity(entry, { at: Date.now(), kind: "notice", text: detail });
        this.log("warn", "delegation turn limit enforced", {
          delegationId: entry.record.delegationId,
          childSessionPath: entry.record.childSessionPath,
          childRuntimeId: entry.host?.runtimeId,
          limit,
        });
        // 收口而非失败：保留已产出的报告，状态落 truncated（渲染层按完成态展示）。
        const report = await this.bestEffortReport(entry);
        await entry.host?.stop().catch(() => undefined);
        this.settle(entry, "truncated", report);
        return;
      }
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
      clearInterval(limitTimer);
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
  private async collectReport(
    entry: DelegationEntry,
    message: string,
    startedAt: number,
    run: { baselineTurns: number; limit: number },
  ): Promise<void> {
    const host = entry.host;
    if (!host) throw new Error("Delegated worker host is missing.");
    await host.request("prompt", { message });
    this.pushActivity(entry, { at: Date.now(), kind: "notice", text: "Prompt accepted; waiting for the worker to settle." });
    await host.waitForIdle();
    const result = await host.request<{ messages?: unknown[] }>("get_messages");
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    let evidence = describeAssistantEvidence(messages);
    let report = extractAssistantReport(messages);
    const turns = Math.max(0, evidence.turns - run.baselineTurns);
    this.log("info", "delegation completion judged", {
      delegationId: entry.record.delegationId,
      childSessionPath: entry.record.childSessionPath,
      childRuntimeId: host.runtimeId,
      elapsedMs: Date.now() - startedAt,
      ...evidence,
      turns,
      turnLimit: run.limit,
      hasReport: Boolean(report),
    });
    if (turns >= run.limit) {
      // 轮数上限是「收口」而不是失败：子代理自己按同一上限停过（runtime 的 turn_end 钩子），
      // 也可能只留下工具调用没有最终文本——两种都算 truncated 并保留已产出的报告。
      const detail = `The delegated worker reached its turn limit (${run.limit} turns); the report below is what it had produced.`;
      this.pushActivity(entry, { at: Date.now(), kind: "notice", text: detail });
      this.log("warn", "delegation turn limit reached", {
        delegationId: entry.record.delegationId,
        childSessionPath: entry.record.childSessionPath,
        childRuntimeId: host.runtimeId,
        limit: run.limit,
        turns,
      });
      this.settle(entry, "truncated", report);
      await this.state.indexSession(entry.record.childSessionPath!).catch(() => undefined);
      return;
    }
    if (!report) {
      // 空报告不是「没干活」：子会话可能只跑了工具就结束了。先补一次「只回最终报告」的指令，
      // 仍失败才落 failed，并把末尾活动/stderr 一起交给父代理。
      if (!entry.noReportRetried && !entry.stopRequested) {
        entry.noReportRetried = true;
        this.pushActivity(entry, {
          at: Date.now(),
          kind: "notice",
          text: "The worker wrote no report; asking it once more for a final report.",
        });
        this.log("warn", "delegation no_report; retrying once", {
          delegationId: entry.record.delegationId,
          childSessionPath: entry.record.childSessionPath,
        });
        try {
          await host.request("prompt", { message: DELEGATION_REPORT_NUDGE });
          await host.waitForIdle();
          const retry = await host.request<{ messages?: unknown[] }>("get_messages");
          const retryMessages = Array.isArray(retry?.messages) ? retry.messages : [];
          evidence = describeAssistantEvidence(retryMessages);
          report = extractAssistantReport(retryMessages);
        } catch (error) {
          this.log("warn", "delegation no_report retry failed", {
            delegationId: entry.record.delegationId,
            childSessionPath: entry.record.childSessionPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (report) {
          this.pushActivity(entry, {
            at: Date.now(),
            kind: "report",
            text: boundedDelegationText(report, MAX_ACTIVITY_TEXT_CHARS),
          });
          this.log("info", "delegation recovered after a report-only retry", {
            delegationId: entry.record.delegationId,
            childSessionPath: entry.record.childSessionPath,
          });
          this.settle(entry, "completed", report);
          await this.state.indexSession(entry.record.childSessionPath!).catch(() => undefined);
          return;
        }
      }
      if (entry.stopRequested) {
        await host.stop().catch(() => undefined);
        this.settle(entry, "cancelled", "", "Stopped by the parent agent.");
        return;
      }
      const detail = this.describeFailure("no_report", undefined, entry, startedAt, evidence);
      this.pushActivity(entry, { at: Date.now(), kind: "notice", text: detail, isError: true });
      // 空闲后仍无 assistant 文本：停掉 worker 再落终态。
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
      const activity = describeRecentActivity(entry.recent);
      if (activity) parts.push(`lastActivity: ${activity}`);
      if (exit?.stderrExcerpt) parts.push(`stderr: ${exit.stderrExcerpt.slice(-300)}`);
      if (entry.noReportRetried) {
        parts.push("A second report-only instruction was sent; it also produced no assistant text.");
      }
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
    const siblings = this.entriesByParent.get(record.parentSessionPath) ?? new Set<string>();
    siblings.add(record.delegationId);
    this.entriesByParent.set(record.parentSessionPath, siblings);
    this.evictTerminalEntries();
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

  /**
   * 创建子会话 host，并保证诊断字段可对账：`createHost` 由主进程注入，
   * 漏注入 `runtimeId` 时按同一命名规则兜底并告警——否则日志与失败详情里的
   * `childRuntimeId` 恒为空，委派故障无法按 runtimeId 对账。
   * 注意：委派 host 由协调器自己托管，本来就不进 `AgentManager` 的 runtime 表
   * （`agent-manager.ts`），所以诊断只能靠日志字段，不靠运行时查表。
   */
  private createDelegationHost(delegationId: string): DelegationHost {
    const runtimeId = `delegation-runtime-${delegationId}`;
    const host = this.options.createHost(runtimeId, delegationId);
    if (!host.runtimeId) {
      host.runtimeId = runtimeId;
      this.log("warn", "delegation host created without runtimeId", { delegationId, runtimeId });
    }
    return host;
  }

  /** 子会话累计的 assistant 轮次（读不到或 worker 已停时返回 0，交给兜底超时处理）。 */
  private async assistantTurns(entry: DelegationEntry): Promise<number> {
    const host = entry.host;
    if (!host || !host.isRunning()) return 0;
    const result = await host.request<{ messages?: unknown[] }>("get_messages");
    const messages = Array.isArray(result?.messages) ? result.messages : [];
    return describeAssistantEvidence(messages).turns;
  }

  /** 收口用：尽力取出子会话当前的报告文本（失败返回空串，不影响落终态）。 */
  private async bestEffortReport(entry: DelegationEntry): Promise<string> {
    try {
      const result = await entry.host?.request<{ messages?: unknown[] }>("get_messages");
      const messages = Array.isArray(result?.messages) ? result.messages : [];
      return extractAssistantReport(messages);
    } catch {
      return "";
    }
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
      // 截断前后都记：上限改动（50k → 12k）后要能从日志看出报告是否被削过。
      reportChars: entry.record.report.length,
      reportCharsRaw: report.length,
      reportTruncated: entry.record.report.length !== report.length,
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
    const ids = this.entriesByParent.get(normalized);
    if (!ids) return [];
    const found: DelegationEntry[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) found.push(entry);
    }
    return found;
  }

  /** 超过上限时淘汰最旧的终态委派（保留最近的与仍持有 host 的）。 */
  private evictTerminalEntries(): void {
    if (this.entries.size <= MAX_RETAINED_TERMINAL_ENTRIES) return;
    const cutoff = Date.now() - TERMINAL_RETENTION_MS;
    // 终态条目即使还挂着空闲的子 worker 也可淘汰（委派已结束），淘汰时顺手停掉它：
    // 否则「终态 + host 存活」这个常态会让淘汰永远不生效。
    const candidates = [...this.entries.values()]
      .filter((entry) => isDelegationTerminal(entry.record.status))
      .filter((entry) => (entry.record.completedAt ?? entry.record.startedAt) < cutoff)
      .sort((left, right) => (left.record.completedAt ?? left.record.startedAt) - (right.record.completedAt ?? right.record.startedAt));
    let overflow = this.entries.size - MAX_RETAINED_TERMINAL_ENTRIES;
    for (const entry of candidates) {
      if (overflow <= 0) break;
      this.entries.delete(entry.record.delegationId);
      void entry.host?.stop().catch(() => undefined);
      const siblings = this.entriesByParent.get(entry.record.parentSessionPath);
      if (siblings) {
        siblings.delete(entry.record.delegationId);
        if (siblings.size === 0) this.entriesByParent.delete(entry.record.parentSessionPath);
      }
      overflow -= 1;
    }
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
      // 恢复持久化的 permission。旧数据缺失该字段时**不能**猜最保守值：这条记录是
      // 我们自己此前授予的权限（不是父会话的），猜成 plan 会让 fixer 之类的续跑被剥掉
      // 全部写工具、而提示词仍承诺可改文件，直接失败。保留原行为并留痕，正确修法是把
      // 子会话的真实权限取回来（见 docs/subagent-delegation-round2-2026-09-10.md 第 7 节）。
      const restored = thread.delegationPermission && permissions.has(thread.delegationPermission)
        ? thread.delegationPermission
        : undefined;
      if (!restored) {
        this.log("warn", "delegation hydrated without persisted permission", {
          delegationId: thread.sourceDelegationId,
          childSessionPath: thread.sessionPath,
          fallback: "auto",
        });
      }
      const permission: PermissionMode = restored ?? "auto";
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

export function effectivePermission(parent: PermissionMode | undefined, requested: SubagentDefinition["permission"]): PermissionMode {
  // 兜底取最保守值：父权限缺失/非法时回退 `auto` 会让子代理比父会话（可能是 plan）更宽松，
  // 属于相对越权；宁可误拦也不放宽。
  const parentMode = parent && permissions.has(parent) ? parent : "plan";
  if (!requested || requested === "inherit") return parentMode;
  const requestedMode = requested as PermissionMode;
  return permissionRank[requestedMode] <= permissionRank[parentMode] ? requestedMode : parentMode;
}

function composeChildTask(definition: SubagentDefinition, task: string, cwd: string): string {
  return [
    composeSubagentSystemPrompt(definition, cwd),
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

/** 末尾活动摘要：把 recent 里最后几条拼成一行，供 no_report 失败详情使用。 */
function describeRecentActivity(recent: DelegationActivity[]): string {
  const entries = recent.slice(-3);
  if (!entries.length) return "";
  const text = entries.map((entry) => `${entry.kind}: ${entry.text}`).join(" | ");
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
