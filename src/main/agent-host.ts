import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { getTacodeRpcEntryPath } from "../runtime/index";
import type { AgentEvent, AgentSessionStats, AgentSnapshot, AgentStartOptions } from "../shared/types";
import { parseSkillCommands } from "../shared/skills";
import { killProcessTree } from "./process-tree";
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

export class AgentHost {
  private child?: ChildProcessWithoutNullStreams;
  private browserRequests = new Map<string, AbortController>();
  private lineBuffer = Buffer.alloc(0);
  private stderr = "";
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();
  private static readonly STDERR_CAP = 200_000;
  /** 短期事件回放缓冲：snapshot 期间到达的事件按序号补齐，避免快照与实时流之间出现缺口。 */
  private static readonly REPLAY_CAP = 500;
  private seq = 0;
  private replayBuffer: AgentEvent[] = [];
  /** 最近一次 snapshot 应答时的事件序号；replay 从它之后开始。 */
  private snapshotSeq = 0;
  /** 启动时交给 worker 的凭据；stderr/错误文本落日志前先脱敏。 */
  private secrets: string[] = [];
  /** 无法解析的 RPC 行只诊断一次，避免坏输出刷屏。 */
  private malformedLines = 0;
  /** 是否正在进行一轮生成（agent_start ~ agent_settled）；供侧边栏“正在运行”徽标与 renderer 重载恢复使用。 */
  private turnActive = false;
  /** 等待下一轮开始的等待者（agent_start 到达或宽限超时后放行）。 */
  private startWaiters: Array<(saw: boolean) => void> = [];
  /** 等待本轮结束的等待者（agent_settled 或 worker 退出后放行）。 */
  private settledWaiters: Array<() => void> = [];
  /** 最近一次 worker 退出信息（退出码/信号 + 脱敏 stderr 摘要），委派失败分类用。 */
  private exitInfo?: { code?: number; signal?: string; stderrExcerpt: string };

  /** 壳层分配的稳定句柄；不随会话文件路径变化，命令按它路由。 */
  public runtimeId = "";

  /** 会话标识（Phase 3a）：事件据此路由回对应会话视图。
   * 新建会话在 `start` 拿到 sessionFile 后由 index.ts 设置；复用会话已存在。 */
  public sessionKey?: string;
  /** 请求启动时传入的 sessionPath，用于 resume 时定位已有 host。 */
  public requestedSessionPath?: string;

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

  /** 给事件附上所属会话 id 与运行句柄，供渲染层按活动会话路由并去重。 */
  private tagged(event: AgentEvent): AgentEvent {
    // 以 agent_start / agent_settled 驱动“活跃轮次”状态，供重载后恢复徽标：
    // 仅真正生成中的会话显示“正在运行”，空闲但存活的 worker 不再误报。
    // 同时放行 waitForIdle 的等待者（委派判定依赖这两个事件收敛）。
    if (event.type === "agent_start") {
      this.turnActive = true;
      this.flushStartWaiters(true);
    } else if (event.type === "agent_settled") {
      this.turnActive = false;
      this.flushSettledWaiters();
    }
    const next: AgentEvent = {
      ...event,
      __seq: ++this.seq,
      ...(this.runtimeId ? { __runtimeId: this.runtimeId } : {}),
      ...(this.sessionKey ? { __sessionId: this.sessionKey } : {}),
    };
    this.replayBuffer.push(next);
    if (this.replayBuffer.length > AgentHost.REPLAY_CAP)
      this.replayBuffer.splice(0, this.replayBuffer.length - AgentHost.REPLAY_CAP);
    return next;
  }

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null);
  }

  /** 是否正在执行一轮生成（worker 存活但空闲时返回 false）。 */
  isInTurn(): boolean {
    return this.turnActive;
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
    };
  }

  /** Non-blocking follow-up for models/skills/stats after first paint. */
  private async emitSnapshotMeta(): Promise<void> {
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
      this.emitEvent(this.tagged({
        type: "desktop_snapshot_meta",
        models: models.models,
        thinkingLevels: thinkingLevels.levels,
        skills: parseSkillCommands(commands.commands),
        ...(stats ? { stats } : {}),
      }));
    } catch {
      // First paint already succeeded; meta is best-effort.
    }
  }

  async start(options: AgentStartOptions & {
    cwd: string;
    visionExtension?: string;
    browserExtension?: string;
    visionConfig?: string;
    visionUploads?: string;
    providerExtension?: string;
    desktopProvider?: { config: unknown; apiKey: string };
  }): Promise<AgentSnapshot> {
    this.requestedSessionPath = options.sessionPath;
    this.secrets = options.desktopProvider ? [options.desktopProvider.apiKey] : [];
    await this.stop();
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
        ...(options.desktopProvider ? {
          // The CLI checks built-in auth before loading the service extension.
          // Bootstrap only this worker; the extension supplies the real credential.
          OPENAI_API_KEY: "desktop-session-key",
          TETHER_DESKTOP_PROVIDER_CONFIG: JSON.stringify(options.desktopProvider.config),
          TETHER_DESKTOP_PROVIDER_KEY: options.desktopProvider.apiKey,
        } : {}),
        ...(options.extraModels?.length
          ? { HARNESS_EXTRA_MODELS: options.extraModels.join(",") }
          : {}),
        ...(options.visionConfig ? { HARNESS_VISION_CONFIG: options.visionConfig } : {}),
        ...(options.visionUploads ? { HARNESS_VISION_UPLOADS: options.visionUploads } : {}),
        ...(options.writableRoots?.length
          ? { TETHER_WRITABLE_ROOTS: options.writableRoots.join(path.delimiter) }
          : {}),
        ...(options.delegationDepth !== undefined
          ? { SUBAGENT_DEPTH: String(options.delegationDepth) }
          : {}),
        // 子代理轮数预算：runtime 侧到上限主动 abort（见 runtime/extension.ts 的 turn_end 钩子）。
        ...(options.maxTurns ? { TACODE_MAX_TURNS: String(options.maxTurns) } : {}),
        ...(options.serviceId ? { TACODE_SERVICE_ID: options.serviceId } : {}),
        ...(this.handleDelegation ? { TACODE_DELEGATION_BRIDGE: "1" } : {}),
      },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.on("message", (message: unknown) => {
      if (this.child !== child || !message || typeof message !== "object") return;
      const request = message as
        | BrowserRequest
        | { type: "tether:browser:cancel"; id: string }
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
      const browserRequest = request as BrowserRequest | { type: "tether:browser:cancel"; id: string };
      if (typeof browserRequest.id !== "string") return;
      if (browserRequest.type === "tether:browser:cancel") { this.browserRequests.get(browserRequest.id)?.abort(); return; }
      if (browserRequest.type !== "tether:browser:request" || !this.executeBrowser || this.browserRequests.has(browserRequest.id)) return;
      const controller = new AbortController();
      this.browserRequests.set(browserRequest.id, controller);
      const reply = (payload: object) => {
        if (this.child === child && child.connected) child.send({ type: "tether:browser:response", id: browserRequest.id, ...payload }, () => {});
      };
      Promise.resolve().then(() => this.executeBrowser!(browserRequest.tool, browserRequest.params, controller.signal))
        .then((result) => reply({ result }), (error) => reply({ error: error instanceof Error ? error.message : String(error) }))
        .finally(() => this.browserRequests.delete(browserRequest.id));
    });
    child.stdout.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
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
      if (child.pid !== undefined) killProcessTree(child.pid, "SIGTERM");
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
      if (child.pid !== undefined) killProcessTree(child.pid, "SIGTERM");
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

  async stop(): Promise<void> {
    this.cancelBrowserRequests();
    this.turnActive = false;
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Agent session closed"));
    }
    this.pending.clear();
    if (child.exitCode !== null || child.pid === undefined) return;
    // Kill the whole RPC tree (delegate explorers, shells, sandboxes) before the
    // desktop process exits — a plain child.kill() leaves detached orphans.
    killProcessTree(child.pid, "SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.pid !== undefined) {
          killProcessTree(child.pid, "SIGKILL");
        }
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async request<T>(type: string, data: Record<string, unknown> = {}): Promise<T> {
    if (type === "abort" || type === "new_session") this.cancelBrowserRequests();
    if (type === "new_session") this.resetBrowser?.();
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("No workspace session is active");
    const id = `desktop_${++this.requestId}`;
    const command = { ...data, type, id };
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
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      try {
        child.stdin.write(`${JSON.stringify(command)}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async respondToUi(id: string, response: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed) throw new Error("No workspace session is active");
    try {
      child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...response })}\n`);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
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
    if (typeof data.type === "string") this.emitEvent(this.tagged(data as AgentEvent));
  }

  private cancelBrowserRequests(): void {
    for (const controller of this.browserRequests.values()) controller.abort();
    this.browserRequests.clear();
  }

  private handleExit(error: Error): void {
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
