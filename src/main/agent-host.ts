import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { getTacodeRpcEntryPath } from "../runtime/index";
import type { AgentEvent, AgentSessionStats, AgentSnapshot, ExtensionUiRequest } from "../shared/types";
import { isAgentUiDialog } from "../shared/agent-ui";
import { ContextStatsTracker } from "./context-stats";
import { parseSkillCommands } from "../shared/skills";
import { CAPABILITIES_REQUEST, CAPABILITIES_RESPONSE, type CapabilityRuntimeStatus, type RuntimeCapabilityReport } from "../shared/capabilities";
import { isCapabilityProjectTrusted } from "../runtime/capability-config";
import type { AgentHostStartOptions } from "./agent-manager";
import { killProcessTree, terminateProcessTree } from "./process-tree";
import { drainUtf8Lines } from "./rpc-lines";
import { IPC_LIMITS, formatBytes, redactSecrets } from "./ipc-validation";
import type { DiagnosticSink } from "./local-logger";
import type { BrowserParams, BrowserRequest, BrowserToolResult } from "../shared/browser-tools";
import {
  DELEGATION_BRIDGE_EVENT,
  DELEGATION_BRIDGE_REQUEST,
  DELEGATION_BRIDGE_RESPONSE,
  type DelegationBridgeEvent,
  type DelegationBridgeRequest,
} from "../shared/delegation";

interface PendingRequest {
  type: string;
  startsTurn?: boolean;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

const DEFAULT_RPC_TIMEOUT_MS = 45_000;
const LONG_RPC_TIMEOUT_MS = 30 * 60_000;
// RPC 语义提示：prompt 是“接收即返回”——preflight 成功即应答，不等整轮生成结束
// （完成契约见 shared/delegation.ts 的 DELEGATION_COMPLETION_CONTRACT）。归入长请求
// 只为放宽超时上限，绝不代表响应到达时子代理已完成；需要等“空闲”的调用方
// （委派判定、/plan execute 等）应改用 waitForIdle()，不要拿 prompt 响应当完成依据。
const LONG_RUNNING_REQUESTS = new Set([
  "prompt",
  "steer",
  "abort",
  "get_entries",
  "get_fork_messages",
  "get_messages",
  "get_session_stats",
  "fork",
  "compact",
]);
/** 刚应答的 prompt 可能还没把 agent_start 事件发出来，等待空闲时给它一个有界宽限窗口。 */
const PROMPT_START_GRACE_MS = 1_500;
const STATS_REFRESH_MS = 500;
const STATS_EVENTS = new Set(["agent_start", "message_start", "message_update", "message_end", "tool_execution_end", "auto_compaction_end", "agent_settled"]);

export class AgentHost {
  private child?: ChildProcessWithoutNullStreams;
  private browserRequests = new Map<string, AbortController>();
  private lineBuffer = Buffer.alloc(0);
  private stderr = "";
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();
  private pendingUi = new Map<string, { request: ExtensionUiRequest; timer?: NodeJS.Timeout }>();
  private static readonly STDERR_CAP = 200_000;
  /** 短期事件回放缓冲：snapshot 期间到达的事件按序号补齐，避免快照与实时流之间出现缺口。 */
  private static readonly REPLAY_CAP = 500;
  /** 回放也按字节限额，避免单个超长工具输出撑大主进程内存。 */
  private static readonly REPLAY_BYTES_CAP = 2 * 1024 * 1024;
  private seq = 0;
  private replayBuffer: AgentEvent[] = [];
  private replaySizes: number[] = [];
  private replayBytes = 0;
  private replayFloorSeq = 0;
  private readonly eventListeners = new Set<(event: AgentEvent) => void>();
  /** 最近一次 snapshot 应答时的事件序号；replay 从它之后开始。 */
  private snapshotSeq = 0;
  /** 启动时交给 worker 的凭据；stderr/错误文本落日志前先脱敏。 */
  private secrets: string[] = [];
  /** 无法解析的 RPC 行只诊断一次，避免坏输出刷屏。 */
  private malformedLines = 0;
  /** 是否正在进行一轮生成（agent_start ~ agent_settled）；供侧边栏“正在运行”徽标与 renderer 重载恢复使用。 */
  private turnActive = false;
  private awaitingTurnStart = false;
  private turnStartTimer?: NodeJS.Timeout;
  /** 等待下一轮开始的等待者（agent_start 到达或宽限超时后放行）。 */
  private startWaiters: Array<(saw: boolean) => void> = [];
  /** 等待本轮结束的等待者（agent_settled 或 worker 退出后放行）。 */
  private settledWaiters: Array<() => void> = [];
  /** 最近一次 worker 退出信息（退出码/信号 + 脱敏 stderr 摘要），委派失败分类用。 */
  private exitInfo?: { code?: number; signal?: string; stderrExcerpt: string };
  private contextStats = new ContextStatsTracker();
  private latestStats?: AgentSessionStats;
  private statsTimer?: NodeJS.Timeout;
  private statsPending = false;
  private statsDirty = false;
  private statsRevision = 0;
  private capabilitiesRevision = 0;
  private appliedCapabilitiesRevision = 0;
  private capabilitiesReload?: Promise<void>;
  private capabilitiesReport?: RuntimeCapabilityReport;
  private capabilitiesError?: string;
  private capabilitiesLoading = false;
  private loadedProjectTrusted = false;
  public requiresCapabilityRestart = false;
  public capabilitiesScheduled = false;
  public capabilitiesBlocked?: () => boolean;
  private stopping?: Promise<void>;
  private stoppingForCapabilities = false;

  invalidateCapabilities(restart = false): void {
    this.capabilitiesRevision += 1;
    this.requiresCapabilityRestart ||= restart && !this.loadedProjectTrusted;
    this.capabilitiesError = undefined;
    this.capabilitiesChanged();
  }

  get hasPendingUiRequests(): boolean { return this.pendingUi.size > 0; }
  get hasPendingWork(): boolean {
    return this.awaitingTurnStart || this.hasPendingUiRequests || this.browserRequests.size > 0
      || [...this.pending.values()].some((request) => ["prompt", "compact", "fork", "new_session"].includes(request.type));
  }
  get hasCapabilityChanges(): boolean { return this.capabilitiesRevision !== this.appliedCapabilitiesRevision; }

  capabilityStatus(): CapabilityRuntimeStatus {
    return {
      state: this.capabilitiesLoading ? "reloading" : this.capabilitiesError ? "failed" : this.capabilitiesScheduled ? "scheduled"
        : this.requiresCapabilityRestart ? "restart-required" : this.hasCapabilityChanges ? "pending" : "loaded",
      runtimeId: this.runtimeId, revision: this.capabilitiesRevision, appliedRevision: this.appliedCapabilitiesRevision,
      report: this.capabilitiesReport, error: this.capabilitiesError,
    };
  }

  scheduleCapabilities(): void { this.capabilitiesScheduled = true; this.capabilitiesChanged(); }

  beginCapabilityReload(): number {
    this.capabilitiesScheduled = false;
    this.capabilitiesLoading = true;
    this.capabilitiesError = undefined;
    this.capabilitiesChanged();
    return this.capabilitiesRevision;
  }

  finishCapabilityReload(revision: number): void {
    this.appliedCapabilitiesRevision = revision;
    if (revision === this.capabilitiesRevision) { this.requiresCapabilityRestart = false; this.capabilitiesScheduled = false; }
    this.capabilitiesLoading = false;
    if (this.capabilitiesReport) this.emitEvent(this.tagged({ type: "desktop_snapshot_meta", skills: this.capabilitiesReport.skills }));
    this.capabilitiesChanged();
    if (this.capabilitiesScheduled) this.emitEvent(this.tagged({ type: "desktop_capabilities_idle" }));
  }

  failCapabilityReload(error: unknown): void {
    this.capabilitiesLoading = false;
    this.capabilitiesError = redactSecrets(error instanceof Error ? error.message : String(error), this.secrets);
    this.capabilitiesChanged();
  }

  private capabilitiesChanged(): void {
    this.emitEvent(this.tagged({ type: "desktop_capabilities_changed" }));
  }

  async readCapabilities(force = false): Promise<RuntimeCapabilityReport> {
    if (!this.capabilitiesReport || force) {
      const child = this.child;
      const report = await this.request<RuntimeCapabilityReport>("get_capabilities");
      if (child !== this.child) throw new Error("Agent session closed");
      if (!report || !Array.isArray(report.skills) || !Array.isArray(report.mcpTools) || !Array.isArray(report.mcpErrors)
        || !["plan", "ask", "auto", "full"].includes(report.permission)) throw new Error("无法读取会话的能力状态。");
      this.capabilitiesReport = report;
    }
    return this.capabilitiesReport;
  }

  /** 空闲会话立即重载；生成中的会话在下一次 prompt 前重载，不中断本轮。 */
  async refreshCapabilities(): Promise<void> {
    if (this.capabilitiesReload) { await this.capabilitiesReload; return; }
    if (!this.isRunning() || this.isInTurn() || this.hasPendingWork || this.capabilitiesBlocked?.() || this.requiresCapabilityRestart || !this.hasCapabilityChanges) return;
    if (!this.capabilitiesReload) {
      const revision = this.beginCapabilityReload();
      this.capabilitiesReload = this.request("prompt", { message: "/reload-capabilities" })
        .then(() => this.readCapabilities(true))
        .then(() => { this.finishCapabilityReload(revision); })
        .catch((error) => { this.failCapabilityReload(error); throw error; })
        .finally(() => { this.capabilitiesReload = undefined; });
    }
    await this.capabilitiesReload;
  }

  /** 壳层分配的稳定句柄；不随会话文件路径变化，命令按它路由。 */
  public runtimeId = "";

  /** 会话标识（Phase 3a）：事件据此路由回对应会话视图。
   * 新建会话在 `start` 拿到 sessionFile 后由 index.ts 设置；复用会话已存在。 */
  public sessionKey?: string;
  /** 请求启动时传入的 sessionPath，用于 resume 时定位已有 host。 */
  public requestedSessionPath?: string;
  public cwd?: string;
  public serviceKey?: string;

  constructor(
    private readonly emitEvent: (event: AgentEvent) => void,
    private readonly emitError: (message: string, sessionKey?: string, runtimeId?: string) => void,
    private readonly executeBrowser?: (tool: string, params: BrowserParams, signal: AbortSignal) => Promise<BrowserToolResult>,
    private readonly resetBrowser?: () => void,
    private readonly log?: DiagnosticSink,
    private readonly handleDelegation?: (request: DelegationBridgeRequest, host: AgentHost) => Promise<unknown>,
  ) {}

  /** 已发出事件的最高序号；snapshot 用它切出需要回放的事件。 */
  get lastSeq(): number {
    return this.seq;
  }

  /** 最近一次 snapshot 的应答序号，回放缺口从这里开始。 */
  get lastSnapshotSeq(): number {
    return this.snapshotSeq;
  }

  /** 序号大于 `afterSeq` 的缓冲事件，用于 snapshot 之后补齐缺口。 */
  replaySince(afterSeq: number): AgentEvent[] {
    return this.replayBuffer.filter(
      (event) => typeof event.__seq === "number" && event.__seq > afterSeq,
    );
  }

  /** snapshot 之后若缺口已经被有界缓冲淘汰，调用方必须重新取快照。 */
  replayGap(afterSeq: number): boolean {
    return afterSeq < this.replayFloorSeq;
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** 给事件附上所属会话 id 与运行句柄，供渲染层按活动会话路由并去重。 */
  private tagged(event: AgentEvent): AgentEvent {
    if (event.type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "tacode") this.capabilitiesReport = undefined;
    // 以 agent_start / agent_settled 驱动“活跃轮次”状态，供重载后恢复徽标：
    // 仅真正生成中的会话显示“正在运行”，空闲但存活的 worker 不再误报。
    // 同时放行 waitForIdle 的等待者（委派判定依赖这两个事件收敛）。
    if (event.type === "agent_start") {
      this.clearTurnStart();
      this.capabilitiesReport = undefined;
      this.turnActive = true;
      this.flushStartWaiters(true);
    } else if (event.type === "agent_settled") {
      this.clearTurnStart();
      this.turnActive = false;
      this.clearPendingUi();
      this.flushSettledWaiters();
    }
    const next: AgentEvent = {
      ...event,
      __seq: ++this.seq,
      ...(this.runtimeId ? { __runtimeId: this.runtimeId } : {}),
      ...(this.sessionKey ? { __sessionId: this.sessionKey } : {}),
    };
    if (isAgentUiDialog(next) && !this.pendingUi.has(next.id)) {
      const timeout = typeof next.timeout === "number" && Number.isFinite(next.timeout) && next.timeout > 0 ? next.timeout : undefined;
      const timer = timeout === undefined ? undefined : setTimeout(() => {
        this.resolvePendingUi(next.id);
      }, timeout);
      timer?.unref?.();
      this.pendingUi.set(next.id, { request: next, timer });
    }
    this.replayBuffer.push(next);
    let eventBytes = 0;
    try { eventBytes = Buffer.byteLength(JSON.stringify(next)); } catch { /* JSON-RPC events are serializable. */ }
    this.replayBytes += eventBytes;
    this.replaySizes.push(eventBytes);
    while (this.replayBuffer.length > AgentHost.REPLAY_CAP || this.replayBytes > AgentHost.REPLAY_BYTES_CAP) {
      const removed = this.replayBuffer.shift();
      if (!removed) break;
      this.replayBytes -= this.replaySizes.shift() ?? 0;
      if (typeof removed.__seq === "number") this.replayFloorSeq = removed.__seq;
    }
    for (const listener of this.eventListeners) {
      try { listener(next); } catch { /* observers must not break the RPC event stream. */ }
    }
    return next;
  }

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null);
  }

  /** 是否正在执行一轮生成（worker 存活但空闲时返回 false）。 */
  isInTurn(): boolean {
    return this.turnActive;
  }

  private clearTurnStart(): void {
    this.awaitingTurnStart = false;
    if (this.turnStartTimer) clearTimeout(this.turnStartTimer);
    this.turnStartTimer = undefined;
  }

  /**
   * 等待 worker 空闲（完成契约见 shared/delegation.ts）。
   *
   * - 已在进行中的一轮：等到 `agent_settled`（或 worker 退出）。
   * - 看似空闲：prompt 是“接收即返回”，`agent_start` 可能尚未到达，
   *   给一个有界宽限窗口；窗口内开始生成则继续等到结束，否则视为空闲返回
   *   （例如 prompt 被拒绝、没有产生轮次）。
   */
  async waitForIdle(options: { startGraceMs?: number } = {}): Promise<void> {
    const graceMs = Math.max(0, options.startGraceMs ?? PROMPT_START_GRACE_MS);
    await this.awaitSettledTurn();
    if (this.turnActive || !this.isRunning()) return;
    const sawStart = await new Promise<boolean>((resolve) => {
      const entry = (saw: boolean): void => resolve(saw);
      const timer = setTimeout(() => {
        const index = this.startWaiters.indexOf(entry);
        if (index >= 0) this.startWaiters.splice(index, 1);
        resolve(false);
      }, graceMs);
      timer.unref?.();
      this.startWaiters.push(entry);
    });
    if (sawStart) await this.awaitSettledTurn();
  }

  /** 最近一次 worker 退出信息；仍在运行或尚未退出过时返回 undefined。 */
  describeExit(): { code?: number; signal?: string; stderrExcerpt: string } | undefined {
    return this.exitInfo;
  }

  private async awaitSettledTurn(): Promise<void> {
    while (this.turnActive && this.isRunning()) {
      await new Promise<void>((resolve) => this.settledWaiters.push(resolve));
    }
  }

  private flushStartWaiters(saw: boolean): void {
    const waiters = this.startWaiters;
    this.startWaiters = [];
    for (const waiter of waiters) waiter(saw);
  }

  private flushSettledWaiters(): void {
    const waiters = this.settledWaiters;
    this.settledWaiters = [];
    for (const waiter of waiters) waiter();
  }

  async snapshot(): Promise<AgentSnapshot> {
    const [state, messages] = await Promise.all([
      this.request<Record<string, unknown>>("get_state"),
      this.request<{ messages: unknown[] }>("get_messages"),
    ]);
    this.contextStats.restore(messages.messages);
    // 快照应答按 stdout 顺序处理：此刻之前解析的事件都已反映在 messages 里，
    // 之后的事件才需要用 replay 补齐，避免 message_start 之类事件重复插入。
    this.snapshotSeq = this.seq;
    void this.emitSnapshotMeta();
    return {
      state,
      messages: messages.messages,
      models: [],
      thinkingLevels: [],
      skills: [],
      pendingUiRequests: [...this.pendingUi.values()].map(({ request }) => request),
      ...(this.latestStats ? { stats: this.latestStats } : {}),
    };
  }

  /** Non-blocking follow-up for models/skills/stats after first paint. */
  private async emitSnapshotMeta(): Promise<void> {
    const child = this.child;
    try {
      const [models, thinkingLevels, stats, commands] = await Promise.all([
        this.request<{ models: AgentSnapshot["models"] }>("get_available_models"),
        this.request<{ levels: string[] }>("get_available_thinking_levels"),
        this.request<AgentSessionStats>("get_session_stats").catch(() => undefined),
        this.request<{
          commands: Array<{
            name: string;
            description?: string;
            source?: string;
            sourceInfo?: { path?: string; baseDir?: string };
          }>;
        }>("get_commands").catch(() => ({ commands: [] })),
      ]);
      if (this.child !== child) return;
      this.emitEvent(this.tagged({
        type: "desktop_snapshot_meta",
        models: models.models,
        thinkingLevels: thinkingLevels.levels,
        skills: parseSkillCommands(commands.commands),
        ...((this.latestStats ?? stats) ? { stats: this.latestStats ?? stats } : {}),
      }));
    } catch {
      // First paint already succeeded; meta is best-effort.
    }
  }

  async start(options: AgentHostStartOptions, lifecycle?: { capabilitiesReload?: boolean; isCurrent?(): boolean }): Promise<AgentSnapshot> {
    this.requestedSessionPath = options.sessionPath;
    this.cwd = options.cwd;
    this.secrets = options.desktopProvider ? [options.desktopProvider.apiKey] : [];
    await this.stop({ capabilitiesReload: lifecycle?.capabilitiesReload });
    if (lifecycle?.isCurrent && !lifecycle.isCurrent()) throw new Error("Agent session closed");
    this.loadedProjectTrusted = isCapabilityProjectTrusted(options.cwd);
    this.capabilitiesReport = undefined;
    this.resetBrowser?.();
    const args = [
      getTacodeRpcEntryPath(),
      "--mode",
      "rpc",
      "--harness",
      "safe",
      "--provider",
      options.provider,
      "--permission",
      options.permission,
      "--sandbox",
      options.sandbox,
    ];
    if (options.network) args.push("--network");
    if (options.model) args.push("--model", options.model);
    if (options.baseUrl) args.push("--base-url", options.baseUrl);
    if (options.maxTokens) args.push("--max-tokens", String(options.maxTokens));
    if (options.effort) args.push("--effort", options.effort);
    args.push("--transport", "chat");
    if (options.activeTools) {
      if (options.activeTools.length) args.push("--tools", options.activeTools.join(","));
      else args.push("--no-tools");
    }
    if (options.sessionPath) args.push("--session", options.sessionPath);
    if (options.visionExtension) args.push("--extension", options.visionExtension);
    if (options.providerExtension) args.push("--extension", options.providerExtension);
    if (options.browserExtension) args.push("--extension", options.browserExtension);

    this.lineBuffer = Buffer.alloc(0);
    this.stderr = "";
    this.exitInfo = undefined;
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
        // 显式覆盖继承值：子代理和旁聊不能意外启动自动命名请求。
        TACODE_AUTO_TITLE: options.autoTitle ? "1" : "0",
        ...(options.desktopProvider ? {
          // The CLI checks built-in auth before loading the service extension.
          // Bootstrap only this worker; the extension supplies the real credential.
          OPENAI_API_KEY: "desktop-session-key",
          TACODE_DESKTOP_PROVIDER_CONFIG: JSON.stringify(options.desktopProvider.config),
          TACODE_DESKTOP_PROVIDER_KEY: options.desktopProvider.apiKey,
        } : {}),
        ...(options.extraModels?.length
          ? { HARNESS_EXTRA_MODELS: options.extraModels.join(",") }
          : {}),
        ...(options.visionConfig ? { HARNESS_VISION_CONFIG: options.visionConfig } : {}),
        ...(options.visionUploads ? { HARNESS_VISION_UPLOADS: options.visionUploads } : {}),
        ...(options.writableRoots?.length
          ? { TACODE_WRITABLE_ROOTS: options.writableRoots.join(path.delimiter) }
          : {}),
        ...(options.delegationDepth !== undefined
          ? { SUBAGENT_DEPTH: String(options.delegationDepth) }
          : {}),
        // 子代理轮数预算：未配置时清除继承值，runtime 不注册轮次上限钩子。
        TACODE_MAX_TURNS: options.maxTurns !== undefined ? String(options.maxTurns) : undefined,
        // 只读命令策略：子 worker 的 exec_command 只允许白名单只读命令。
        ...(options.execPolicy ? { TACODE_EXEC_POLICY: options.execPolicy } : {}),
        ...(options.serviceId ? { TACODE_SERVICE_ID: options.serviceId } : {}),
        ...(this.handleDelegation ? { TACODE_DELEGATION_BRIDGE: "1" } : {}),
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.on("message", (message: unknown) => {
      if (this.child !== child || !message || typeof message !== "object") return;
      const reportMessage = message as { type?: string; id?: string; report?: unknown };
      if (reportMessage.type === CAPABILITIES_RESPONSE && typeof reportMessage.id === "string") {
        this.handleLine(JSON.stringify({ type: "response", id: reportMessage.id, success: true, data: reportMessage.report }));
        return;
      }
      const request = message as
        | BrowserRequest
        | { type: "tacode:browser:cancel"; id: string }
        | DelegationBridgeRequest;
      if (request.type === DELEGATION_BRIDGE_REQUEST && typeof request.requestId === "string") {
        const bridgeRequest = {
          ...request,
          parentSessionPath:
            request.parentSessionPath || this.sessionKey || this.requestedSessionPath || "",
        } as DelegationBridgeRequest;
        void Promise.resolve()
          .then(() => this.handleDelegation?.(bridgeRequest, this))
          .then(
            (result) => {
              if (this.child === child && child.connected) {
                child.send({
                  type: DELEGATION_BRIDGE_RESPONSE,
                  requestId: request.requestId,
                  ok: true,
                  result,
                }, () => {});
              }
            },
            (error) => {
              if (this.child === child && child.connected) {
                child.send({
                  type: DELEGATION_BRIDGE_RESPONSE,
                  requestId: request.requestId,
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                }, () => {});
              }
            },
          );
        return;
      }
      const browserRequest = request as BrowserRequest | { type: "tacode:browser:cancel"; id: string };
      if (typeof browserRequest.id !== "string") return;
      if (browserRequest.type === "tacode:browser:cancel") { this.browserRequests.get(browserRequest.id)?.abort(); return; }
      if (browserRequest.type !== "tacode:browser:request" || !this.executeBrowser || this.browserRequests.has(browserRequest.id)) return;
      const controller = new AbortController();
      this.browserRequests.set(browserRequest.id, controller);
      const reply = (payload: object) => {
        if (this.child === child && child.connected) child.send({ type: "tacode:browser:response", id: browserRequest.id, ...payload }, () => {});
      };
      Promise.resolve().then(() => this.executeBrowser!(browserRequest.tool, browserRequest.params, controller.signal))
        .then((result) => reply({ result }), (error) => reply({ error: error instanceof Error ? error.message : String(error) }))
        .finally(() => this.browserRequests.delete(browserRequest.id));
    });
    child.stdout.on("data", (chunk: Buffer) => { if (this.child === child) this.handleChunk(chunk); });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-AgentHost.STDERR_CAP);
    });
    child.stdin.on("error", (error) => {
      // EPIPE when the RPC worker exits mid-write must not crash the Electron main process.
      if (this.child !== child) return;
      const detail = error instanceof Error ? error.message : String(error);
      if (!/EPIPE|ECONNRESET|broken pipe/i.test(detail)) {
        this.log?.error("worker", `stdin error: ${detail}`, {
          runtimeId: this.runtimeId,
          sessionKey: this.sessionKey,
        });
        this.emitError(detail, this.sessionKey, this.runtimeId);
      }
    });
    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (child.pid !== undefined) void killProcessTree(child.pid).catch(() => undefined);
      this.log?.error("worker", `spawn error: ${redactSecrets(error.message, this.secrets)}`, {
        runtimeId: this.runtimeId,
        sessionKey: this.sessionKey,
      });
      this.handleExit(error);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      // Worker may die before its own wipe; reap leftover shells/delegates.
      if (child.pid !== undefined) void killProcessTree(child.pid).catch(() => undefined);
      this.exitInfo = {
        ...(typeof code === "number" ? { code } : {}),
        ...(signal ? { signal } : {}),
        stderrExcerpt: redactSecrets(this.stderr.trim(), this.secrets).slice(-2_000),
      };
      this.log?.error("worker", `worker exited (code ${code ?? "unknown"}${signal ? `, ${signal}` : ""})`, {
        runtimeId: this.runtimeId,
        sessionKey: this.sessionKey,
      });
      this.handleExit(new Error(`Agent stopped (code ${code ?? "unknown"}${signal ? `, ${signal}` : ""})`));
    });

    return this.snapshot();
  }

  sendDelegationEvent(event: DelegationBridgeEvent): void {
    const child = this.child;
    if (!child || !child.connected) return;
    child.send({ type: DELEGATION_BRIDGE_EVENT, event: event.event }, () => {});
  }

  stop(options: { capabilitiesReload?: boolean } = {}): Promise<void> {
    if (this.stopping) {
      if (this.stoppingForCapabilities && !options.capabilitiesReload) {
        return this.stopping.then(() => { this.emitEvent(this.tagged({ type: "desktop_runtime_stopped" })); });
      }
      return this.stopping;
    }
    this.stoppingForCapabilities = Boolean(options.capabilitiesReload);
    const pending = this.stopNow(Boolean(options.capabilitiesReload));
    this.stopping = pending;
    const done = () => { if (this.stopping === pending) this.stopping = undefined; };
    void pending.then(done, done);
    return pending;
  }

  private async stopNow(capabilitiesReload: boolean): Promise<void> {
    this.clearTurnStart();
    const wasActive = this.turnActive;
    this.clearPendingUi();
    this.clearStatsRefresh();
    this.contextStats = new ContextStatsTracker();
    this.latestStats = undefined;
    this.cancelBrowserRequests();
    this.resetBrowser?.();
    this.turnActive = false;
    // 停 host 也要放行等待者：否则「已退出的 worker 再 stop()」会走下面的早退分支，
    // 让 waitForIdle 的等待者永久挂起（delegate_stop / 超时收口路径都会踩到）。
    this.flushStartWaiters(false);
    this.flushSettledWaiters();
    const child = this.child;
    if (!child) { this.emitEvent(this.tagged({ type: "desktop_runtime_stopped", capabilitiesReload })); return; }
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Agent session closed"));
    }
    this.pending.clear();
    try {
      if (child.exitCode === null && child.pid !== undefined) {
        let finish!: () => void;
        const exited = new Promise<void>((resolve) => { finish = resolve; child.once("exit", resolve); });
        try { await terminateProcessTree(child.pid, { exited }); }
        finally { child.removeListener("exit", finish); }
        if (child.exitCode === null && child.signalCode === null) throw new Error("运行进程尚未退出，请再次停止。");
      }
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) { this.child = child; this.turnActive = wasActive; }
      throw error;
    }
    this.emitEvent(this.tagged({ type: "desktop_runtime_stopped", capabilitiesReload }));
  }

  async request<T>(type: string, data: Record<string, unknown> = {}): Promise<T> {
    if ((type === "prompt" || type === "get_commands") && data.message !== "/reload-capabilities") await this.refreshCapabilities();
    if (type === "abort" || type === "new_session") this.cancelBrowserRequests();
    if (type === "new_session") this.resetBrowser?.();
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("No workspace session is active");
    if (type === "abort" || type === "new_session") {
      // Pi 的交互等待可能先于 abort 返回；先取消全部请求，避免留下不可见的等待。
      for (const id of [...this.pendingUi.keys()]) {
        if (this.pendingUi.has(id)) await this.respondToUi(id, { cancelled: true });
      }
    }
    const id = `desktop_${++this.requestId}`;
    const command = { ...data, type, id };
    const startsTurn = type === "prompt" && data.message !== "/reload-capabilities" && !this.turnActive;
    if (startsTurn) { this.clearTurnStart(); this.awaitingTurnStart = true; }
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        const detail = redactSecrets(this.stderr, this.secrets);
        this.log?.error("rpc", `request timed out: ${type}`, {
          runtimeId: this.runtimeId,
          sessionKey: this.sessionKey,
          stderr: detail.slice(-2_000),
        });
        reject(
          new Error(`TACode did not respond to ${type}. ${detail}`.trim()),
        );
      }, timeoutForRequest(type));
      this.pending.set(id, {
        type,
        startsTurn,
        resolve: (value) => {
          if (this.child === child && type === "get_session_stats" && value && typeof value === "object") {
            this.latestStats = this.contextStats.enrich(value as AgentSessionStats);
            resolve(this.latestStats as T);
          } else {
            if (this.child === child && ["set_model", "compact", "new_session"].includes(type)) {
              if (type === "new_session") {
                this.contextStats = new ContextStatsTracker();
                this.latestStats = undefined;
              }
              if (type === "compact") this.contextStats.handle({ type: "auto_compaction_end" });
              this.scheduleStatsRefresh(true);
            }
            resolve(value as T);
          }
        },
        reject,
        timeout,
      });
      try {
        if (type === "get_capabilities") {
          child.send({ type: CAPABILITIES_REQUEST, id }, (error) => {
            if (!error) return;
            const pending = this.pending.get(id);
            if (!pending) return;
            clearTimeout(pending.timeout);
            this.pending.delete(id);
            pending.reject(error);
          });
        } else child.stdin.write(`${JSON.stringify(command)}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).then((value) => {
      if (startsTurn && this.child === child && this.awaitingTurnStart) {
        this.turnStartTimer = setTimeout(() => {
          this.clearTurnStart();
          if (this.capabilitiesScheduled) this.emitEvent(this.tagged({ type: "desktop_capabilities_idle" }));
        }, PROMPT_START_GRACE_MS);
        this.turnStartTimer.unref?.();
      }
      if (this.capabilitiesScheduled && !this.hasPendingWork) this.emitEvent(this.tagged({ type: "desktop_capabilities_idle" }));
      return value;
    }, (error) => {
      if (startsTurn && this.child === child) this.clearTurnStart();
      if (this.capabilitiesScheduled && !this.hasPendingWork) this.emitEvent(this.tagged({ type: "desktop_capabilities_idle" }));
      throw error;
    });
  }

  async respondToUi(id: string, response: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("No workspace session is active");
    const pending = this.pendingUi.get(id);
    if (!pending) throw new Error("该请求已结束，请查看会话的最新状态。");
    // 先占用请求，重复点击或两个窗口同时答复只能写入一次。
    this.pendingUi.delete(id);
    try {
      child.stdin.write(`${JSON.stringify({ ...response, type: "extension_ui_response", id })}\n`);
    } catch (error) {
      this.pendingUi.set(id, pending);
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.emitEvent(this.tagged({ type: "desktop_ui_request_resolved", id }));
  }

  private resolvePendingUi(id: string): void {
    const pending = this.pendingUi.get(id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingUi.delete(id);
    this.emitEvent(this.tagged({ type: "desktop_ui_request_resolved", id }));
  }

  private clearPendingUi(): void {
    for (const { timer } of this.pendingUi.values()) if (timer) clearTimeout(timer);
    this.pendingUi.clear();
  }

  private handleChunk(chunk: Buffer): void {
    const drained = drainUtf8Lines(this.lineBuffer, chunk, {
      maxLineBytes: IPC_LIMITS.rpcLineBytes,
    });
    this.lineBuffer = Buffer.from(drained.rest);
    if (drained.oversized > 0) {
      const detail = `RPC 输出单行超过 ${formatBytes(IPC_LIMITS.rpcLineBytes)}，已丢弃 ${drained.oversized} 行`;
      this.log?.warn("rpc", detail, { runtimeId: this.runtimeId, sessionKey: this.sessionKey });
      this.emitError(detail, this.sessionKey, this.runtimeId);
    }
    for (const line of drained.lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (this.malformedLines === 0) {
        const detail = `RPC 输出包含无法解析的 JSON，已忽略：${redactSecrets(line.slice(0, 200), this.secrets)}`;
        this.log?.warn("rpc", detail, { runtimeId: this.runtimeId, sessionKey: this.sessionKey });
        this.emitError(detail, this.sessionKey, this.runtimeId);
      }
      this.malformedLines += 1;
      return;
    }
    if (data.type === "response" && typeof data.id === "string") {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(data.id);
      if (data.success === false) pending.reject(new Error(String(data.error ?? "TACode command failed")));
      else pending.resolve(data.data);
      return;
    }
    if (typeof data.type === "string") {
      this.contextStats.handle(data as AgentEvent);
      this.emitEvent(this.tagged(data as AgentEvent));
      if (STATS_EVENTS.has(data.type)) {
        if (data.type !== "message_update") this.statsRevision += 1;
        this.scheduleStatsRefresh(data.type !== "message_update");
      }
    }
  }

  /** One small RPC at a time, coalesced across stream chunks and shared by all renderers. */
  private scheduleStatsRefresh(immediate = false): void {
    if (!this.isRunning()) return;
    this.statsDirty = true;
    if (this.statsPending) return;
    if (this.statsTimer) {
      if (!immediate) return;
      clearTimeout(this.statsTimer);
    }
    this.statsTimer = setTimeout(() => {
      this.statsTimer = undefined;
      void this.refreshStats();
    }, immediate ? 0 : STATS_REFRESH_MS);
    this.statsTimer.unref?.();
  }

  private async refreshStats(): Promise<void> {
    const child = this.child;
    const revision = this.statsRevision;
    this.statsPending = true;
    this.statsDirty = false;
    try {
      const stats = await this.request<AgentSessionStats>("get_session_stats");
      if (this.child === child && revision === this.statsRevision) {
        this.emitEvent(this.tagged({ type: "desktop_session_stats", stats }));
      }
    } catch {
      // Usage must not interrupt a reply or surface an extra error when a worker exits.
    } finally {
      if (this.child === child) {
        this.statsPending = false;
        if (this.statsDirty) this.scheduleStatsRefresh(revision !== this.statsRevision);
      }
    }
  }

  private clearStatsRefresh(): void {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = undefined;
    this.statsPending = false;
    this.statsDirty = false;
  }

  private cancelBrowserRequests(): void {
    for (const controller of this.browserRequests.values()) controller.abort();
    this.browserRequests.clear();
  }

  private handleExit(error: Error): void {
    this.clearStatsRefresh();
    this.clearPendingUi();
    this.turnActive = false;
    this.cancelBrowserRequests();
    // 所有退出路径（exit / spawn error）都必须放行 waitForIdle 的等待者，
    // 否则委派完成判定会永久挂起。
    this.flushStartWaiters(false);
    this.flushSettledWaiters();
    const detail = redactSecrets(this.stderr.trim(), this.secrets);
    const message = detail
      ? `${redactSecrets(error.message, this.secrets)}\n${detail}`
      : redactSecrets(error.message, this.secrets);
    this.log?.error("worker", message.slice(0, 1_000), {
      runtimeId: this.runtimeId,
      sessionKey: this.sessionKey,
    });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.emitError(message, this.sessionKey, this.runtimeId);
  }
}

function timeoutForRequest(type: string): number {
  return LONG_RUNNING_REQUESTS.has(type) ? LONG_RPC_TIMEOUT_MS : DEFAULT_RPC_TIMEOUT_MS;
}
