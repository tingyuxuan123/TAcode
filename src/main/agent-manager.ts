import { randomUUID } from "node:crypto";
import { NO_ACTIVE_SESSION_MESSAGE } from "../shared/agent-protocol";
import type {
  AgentEvent,
  AgentRuntimeInfo,
  AgentSnapshot,
  AgentStartOptions,
  AgentStartResult,
} from "../shared/types";
import type { AgentHost } from "./agent-host";
import type { CapabilityRuntimeStatus, RuntimeCapabilityReport } from "../shared/capabilities";

/** 空闲 worker 的硬预算：已结束会话仍可从 JSONL 恢复，不必无限占用进程和内存。 */
export const MAX_IDLE_WORKERS = 8;
/** 长时间没有用户或后台活动的 worker 可提前回收；下次打开会按会话文件恢复。 */
export const IDLE_WORKER_TTL_MS = 5 * 60_000;
const IDLE_REAPER_INTERVAL_MS = 30_000;

/** 从会话快照/命令结果里抽取底层会话文件路径。 */
export function sessionFileFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("sessionFile" in value))
    return undefined;
  return typeof (value as { sessionFile?: unknown }).sessionFile === "string"
    ? (value as { sessionFile: string }).sessionFile
    : undefined;
}

export function sessionFileOf(snapshot: AgentSnapshot): string | undefined {
  return (
    sessionFileFromUnknown(snapshot.stats) ??
    sessionFileFromUnknown(snapshot.state)
  );
}

export interface AgentManagerOptions {
  /** 构造一个新的 RPC 宿主；manager 会立即写入 runtimeId。 */
  createHost(runtimeId: string): AgentHost;
  /** 主会话停止时回收由桌面协调器独立托管的子代理。 */
  stopDelegations?(sessionPath: string): Promise<unknown>;
  hasDelegations?(sessionPath: string): boolean;
}

/**
 * 必须「带外」派发的命令：不能排在按 runtime 串行化的命令队列后面。
 *
 * 队列里可能压着长请求（`compact` / `fork` / 大快照 `get_messages`），而 `abort`
 * 是用户点「停止」后的紧急意图——排在它们后面就意味着停止要等十几秒到几分钟才有反应。
 * 底层 worker 按行并发处理 stdin，所以直接派发不会打乱已发出命令的先后顺序。
 */
const OUT_OF_BAND_COMMANDS = new Set(["abort"]);

/** 主进程启动宿主时补充的壳层参数（扩展路径、桌面服务凭据等）。 */
export type AgentHostStartOptions = AgentStartOptions & {
  cwd: string;
  serviceKey?: string;
  /** 桌面主会话首条消息自动生成短标题。 */
  autoTitle?: boolean;
  visionExtension?: string;
  browserExtension?: string;
  visionConfig?: string;
  visionUploads?: string;
  providerExtension?: string;
  desktopProvider?: { config: unknown; apiKey: string };
};

/**
 * 会话级 Agent 生命周期管理。
 *
 * 每个 RPC worker 对应一个稳定的 `runtimeId`，命令按句柄路由，不再依赖
 * “当前活动会话”这一易变全局量。同一 runtime 的普通命令串行执行，停止走带外通道，
 * 切换会话只改变活动句柄，不会让旧请求改写新会话的状态。
 */
export class AgentManager {
  private readonly runtimes = new Map<string, AgentHost>();
  /** 会话路径 / 请求路径 → runtimeId；rekey 时先清旧别名，避免路径漂移后指向旧 host。 */
  private readonly index = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly startOptions = new Map<string, AgentHostStartOptions>();
  private readonly capabilityReloads = new Map<string, Promise<CapabilityRuntimeStatus>>();
  private readonly lastUsedAt = new Map<string, number>();
  private activeRuntimeId: string | undefined;
  private selection = 0;
  private readonly idleReaper: NodeJS.Timeout;

  constructor(private readonly options: AgentManagerOptions) {
    this.idleReaper = setInterval(() => { void this.reapIdle().catch(() => undefined); }, IDLE_REAPER_INTERVAL_MS);
    this.idleReaper.unref?.();
  }

  get active(): string | undefined {
    return this.activeRuntimeId;
  }

  /** 导航到空白页只解除活动句柄，后台 worker 继续运行。 */
  deactivate(): void {
    this.selection++;
    this.activeRuntimeId = undefined;
  }

  /** 按会话路径（sessionKey 或 requestedSessionPath）查找宿主。 */
  findBySession(sessionPath?: string): AgentHost | undefined {
    if (!sessionPath) return undefined;
    const runtimeId = this.index.get(sessionPath);
    return runtimeId ? this.runtimes.get(runtimeId) : undefined;
  }

  findRuntime(runtimeId?: string): AgentHost | undefined {
    return runtimeId ? this.runtimes.get(runtimeId) : undefined;
  }

  /** 当前活动句柄对应的宿主；未指定句柄时回退到最近一次成功启动的会话。 */
  activeHost(runtimeId?: string): AgentHost | undefined {
    return this.findRuntime(runtimeId ?? this.activeRuntimeId);
  }

  list(): AgentRuntimeInfo[] {
    return [...this.runtimes.values()].map((host) => ({
      runtimeId: host.runtimeId,
      ...(host.sessionKey ? { sessionKey: host.sessionKey } : {}),
      ...(host.requestedSessionPath
        ? { requestedSessionPath: host.requestedSessionPath }
        : {}),
      running: host.isInTurn(),
    }));
  }

  /** 序号大于 afterSeq 的缓冲事件，用于渲染层补齐快照缺口。 */
  replay(runtimeId: string | undefined, afterSeq: number): AgentEvent[] {
    const host = this.activeHost(runtimeId);
    return host ? host.replaySince(afterSeq) : [];
  }

  /** 回放窗口溢出时取权威快照，避免把有界缓冲的缺口静默交给 renderer。 */
  async replayWithResync(runtimeId: string | undefined, afterSeq: number): Promise<AgentEvent[]> {
    const host = this.activeHost(runtimeId);
    if (!host || !host.isRunning()) return [];
    if (typeof host.replayGap !== "function" || !host.replayGap(afterSeq)) return host.replaySince(afterSeq);
    const snapshot = await host.snapshot();
    return [{
      type: "desktop_replay_snapshot",
      state: snapshot.state,
      messages: snapshot.messages,
      ...(snapshot.stats ? { stats: snapshot.stats } : {}),
      ...(snapshot.skills ? { skills: snapshot.skills } : {}),
      lastSeq: host.lastSeq,
      __seq: host.lastSeq,
      ...(host.runtimeId ? { __runtimeId: host.runtimeId } : {}),
      ...(host.sessionKey ? { __sessionId: host.sessionKey } : {}),
    }];
  }

  async start(options: AgentHostStartOptions): Promise<AgentStartResult> {
    const selection = ++this.selection;
    const reloading = this.findBySession(options.sessionPath);
    if (reloading) await this.capabilityReloads.get(reloading.runtimeId)?.catch(() => undefined);
    const existing = this.findBySession(options.sessionPath);
    if (existing?.isRunning()) return this.snapshotOn(existing, selection);
    // A worker can exit before the renderer gets a chance to call stop(). Do not
    // reuse that dead host: a queued stop followed by a restart could otherwise
    // remove the restarted host from the manager map.
    if (existing) this.removeHost(existing);
    // 没有现存宿主：按请求路径串行化，避免同一会话被并发启动两次。
    const key = `start:${options.sessionPath ?? options.cwd ?? "new"}`;
    return this.enqueue(key, () => {
      const reused = this.findBySession(options.sessionPath);
      if (reused?.isRunning()) return this.snapshotOn(reused, selection);
      if (reused) this.removeHost(reused);
      return this.startOn(this.createHost(), options, selection);
    }).then((result) => { void this.reapIdle().catch(() => undefined); return result; });
  }

  /** 复用已在运行的宿主：只取快照与缺口事件，不重启 worker。 */
  async resume(runtimeId: string): Promise<AgentStartResult> {
    const selection = ++this.selection;
    await this.capabilityReloads.get(runtimeId)?.catch(() => undefined);
    const host = this.findRuntime(runtimeId);
    if (!host || !host.isRunning())
      return Promise.reject(new Error("Agent session is not running"));
    this.touch(host);
    return this.snapshotOn(host, selection);
  }

  private async snapshotOn(host: AgentHost, selection: number): Promise<AgentStartResult> {
    this.touch(host);
    await this.capabilityReloads.get(host.runtimeId);
    // 读取不能排在等待 UI 的 prompt 后，否则连恢复确认卡也会死锁。
    const snapshot = await host.snapshot();
    if (this.findRuntime(host.runtimeId) !== host || !host.isRunning())
      throw new Error("Agent session is not running");
    if (selection === this.selection) this.activeRuntimeId = host.runtimeId;
    const cut = host.lastSnapshotSeq;
    return {
      ...snapshot,
      cwd: host.cwd ?? snapshot.cwd,
      serviceKey: host.serviceKey,
      runtimeId: host.runtimeId,
      lastSeq: cut,
      replay: host.replaySince(cut),
    };
  }

  stop(runtimeId?: string): Promise<void> {
    const closing = this.stopping.get(runtimeId ?? this.activeRuntimeId ?? "");
    if (closing) return closing;
    const host = this.activeHost(runtimeId);
    if (!host) return Promise.resolve();
    const lastUsedAt = this.lastUsedAt.get(host.runtimeId) ?? Date.now();
    // 关闭不能排在尚未返回的命令后面；Host.stop 会拒绝那些未完成请求。
    this.removeHost(host);
    const job = Promise.all([this.stopDelegations(host), host.stop()]).then(() => undefined).catch((error) => {
      if (host.isRunning()) {
        this.runtimes.set(host.runtimeId, host);
        this.lastUsedAt.set(host.runtimeId, lastUsedAt);
        this.reindex(host);
      }
      throw error;
    }).finally(() => { this.stopping.delete(host.runtimeId); });
    this.stopping.set(host.runtimeId, job);
    return job;
  }

  command<T>(
    runtimeId: string | undefined,
    type: string,
    data?: Record<string, unknown>,
  ): Promise<T> {
    const host = this.activeHost(runtimeId);
    if (!host) return Promise.reject(new Error(NO_ACTIVE_SESSION_MESSAGE));
    this.touch(host);
    if (!host.isRunning() && !this.capabilityReloads.has(host.runtimeId)) {
      this.removeHost(host);
      return Promise.reject(new Error(NO_ACTIVE_SESSION_MESSAGE));
    }
    // 停止类命令绕开队列：用户的「停止」不能被队列里的长请求拖住（见 OUT_OF_BAND_COMMANDS）。
    if (OUT_OF_BAND_COMMANDS.has(type)) {
      return Promise.all([this.stopDelegations(host), host.request<T>(type, data)]).then(([, result]) => result);
    }
    return this.enqueue(host.runtimeId, async () => {
      if (this.findRuntime(host.runtimeId) !== host) throw new Error(NO_ACTIVE_SESSION_MESSAGE);
      if (type === "prompt" && host.requiresCapabilityRestart && this.canReloadCapabilities(host)) {
        const reload = this.applyCapabilitiesOn(host);
        this.capabilityReloads.set(host.runtimeId, reload);
        try { await reload; }
        finally { if (this.capabilityReloads.get(host.runtimeId) === reload) this.capabilityReloads.delete(host.runtimeId); }
      }
      if (type === "new_session") await this.stopDelegations(host);
      const result = await host.request<T>(type, data);
      if (
        type === "new_session" ||
        type === "get_state" ||
        type === "get_session_stats"
      ) {
        const file = sessionFileFromUnknown(result);
        if (file) {
          host.sessionKey = file;
          this.reindex(host);
        }
      }
      return result;
    });
  }

  respondToUi(
    runtimeId: string | undefined,
    id: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    const host = this.activeHost(runtimeId);
    if (!host) return Promise.reject(new Error(NO_ACTIVE_SESSION_MESSAGE));
    this.touch(host);
    // UI 应答是宿主正在等待的“带外”回复，必须绕过按 runtime 串行化的命令队列：
    // 触发这次询问的 prompt 命令可能仍挂在队列里（例如斜杠命令内部 await
    // ctx.ui.confirm），若把应答排在它后面就会互相等待死锁。
    return host.respondToUi(id, response);
  }

  /** 退出/关窗时回收全部宿主，每个 host 只 stop 一次。 */
  async stopAll(): Promise<void> {
    clearInterval(this.idleReaper);
    this.deactivate();
    const hosts = [...this.runtimes.values()];
    this.runtimes.clear();
    this.index.clear();
    this.startOptions.clear();
    this.lastUsedAt.clear();
    this.queues.clear();
    this.capabilityReloads.clear();
    this.activeRuntimeId = undefined;
    await Promise.all([...this.stopping.values(), ...hosts.map((host) => Promise.all([this.stopDelegations(host), host.stop()]))].map((job) => job.catch(() => undefined)));
  }

  private async stopDelegations(host: AgentHost): Promise<void> {
    const sessionPath = host.sessionKey ?? host.requestedSessionPath;
    if (sessionPath) await this.options.stopDelegations?.(sessionPath);
  }

  private createHost(): AgentHost {
    const runtimeId = `runtime-${randomUUID()}`;
    const host = this.options.createHost(runtimeId);
    host.runtimeId = runtimeId;
    host.capabilitiesBlocked = () => {
      const session = host.sessionKey ?? host.requestedSessionPath;
      return Boolean(session && this.options.hasDelegations?.(session));
    };
    this.runtimes.set(runtimeId, host);
    this.lastUsedAt.set(runtimeId, Date.now());
    return host;
  }

  private touch(host: AgentHost): void {
    this.lastUsedAt.set(host.runtimeId, Date.now());
  }

  private removeHost(host: AgentHost): void {
    this.runtimes.delete(host.runtimeId);
    this.startOptions.delete(host.runtimeId);
    this.lastUsedAt.delete(host.runtimeId);
    for (const [key, id] of this.index)
      if (id === host.runtimeId) this.index.delete(key);
    if (this.activeRuntimeId === host.runtimeId) this.activeRuntimeId = undefined;
  }

  private async startOn(
    host: AgentHost,
    options: AgentHostStartOptions,
    selection: number,
  ): Promise<AgentStartResult> {
    let snapshot: AgentSnapshot;
    host.cwd = options.cwd;
    host.serviceKey = options.serviceKey;
    this.startOptions.set(host.runtimeId, options);
    try {
      snapshot = await host.start(options);
      if (this.findRuntime(host.runtimeId) !== host) throw new Error("Agent session closed");
    } catch (error) {
      this.removeHost(host);
      await host.stop().catch(() => undefined);
      throw error;
    }
    const file = sessionFileOf(snapshot) ?? options.sessionPath;
    if (file) host.sessionKey = file;
    this.reindex(host);
    if (selection === this.selection) this.activeRuntimeId = host.runtimeId;
    const cut = host.lastSnapshotSeq;
    return {
      ...snapshot,
      serviceKey: host.serviceKey,
      runtimeId: host.runtimeId,
      lastSeq: cut,
      replay: host.replaySince(cut),
    };
  }

  /** 重建索引：先清掉该 runtime 的旧路径别名，再写入当前路径。
   * 已知会话文件时只认它，避免旧请求路径继续指向已被 rekey 的会话。 */
  private reindex(host: AgentHost): void {
    for (const [key, id] of this.index)
      if (id === host.runtimeId) this.index.delete(key);
    if (host.sessionKey) this.index.set(host.sessionKey, host.runtimeId);
    else if (host.requestedSessionPath)
      this.index.set(host.requestedSessionPath, host.runtimeId);
  }

  private enqueue<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(action, action);
    let tracked: Promise<unknown>;
    const finalized = next.then(
      (value) => {
        if (this.queues.get(key) === tracked) this.queues.delete(key);
        return value;
      },
      (error) => {
        if (this.queues.get(key) === tracked) this.queues.delete(key);
        throw error;
      },
    );
    tracked = finalized.catch(() => undefined);
    this.queues.set(key, tracked);
    return finalized;
  }

  /**
   * 回收可恢复的空闲 worker。活动会话、生成中、等待审批/浏览器请求、有子任务、
   * 能力重载和仍在命令队列中的 host 一律保留。先按数量收敛，再按 TTL 淘汰。
   */
  async reapIdle(now = Date.now()): Promise<number> {
    const idle = [...this.runtimes.values()]
      .filter((host) => host.runtimeId !== this.activeRuntimeId)
      .filter((host) => host.isRunning() && !host.isInTurn() && !host.hasPendingWork)
      .filter((host) => !this.hasDelegations(host))
      .filter((host) => !host.capabilitiesScheduled && !host.requiresCapabilityRestart && !host.hasCapabilityChanges)
      .filter((host) => !this.capabilityReloads.has(host.runtimeId) && !this.stopping.has(host.runtimeId))
      .filter((host) => !this.queues.has(host.runtimeId))
      .sort((left, right) => (this.lastUsedAt.get(left.runtimeId) ?? 0) - (this.lastUsedAt.get(right.runtimeId) ?? 0));
    const evict = idle.filter((host, index) => index < Math.max(0, idle.length - MAX_IDLE_WORKERS)
      || now - (this.lastUsedAt.get(host.runtimeId) ?? now) >= IDLE_WORKER_TTL_MS);
    await Promise.all(evict.map((host) => this.stop(host.runtimeId).catch(() => undefined)));
    return evict.length;
  }

  invalidateCapabilities(cwd?: string, trustChanged = false): void {
    for (const host of this.runtimes.values()) {
      if (cwd && host.cwd !== cwd) continue;
      host.invalidateCapabilities(trustChanged);
      if (!host.requiresCapabilityRestart) void this.reloadCapabilities(host.runtimeId, false).catch(() => undefined);
    }
  }

  private canReloadCapabilities(host: AgentHost): boolean {
    const session = host.sessionKey ?? host.requestedSessionPath;
    return !host.isInTurn() && !host.hasPendingWork && !this.hasDelegations(host);
  }

  private hasDelegations(host: AgentHost): boolean {
    const session = host.sessionKey ?? host.requestedSessionPath;
    return Boolean(session && this.options.hasDelegations?.(session));
  }

  /** No polling: settlement, resolved approvals and child completion retry a scheduled reload. */
  flushScheduledCapabilities(runtimeId: string): void {
    const host = this.findRuntime(runtimeId);
    if (host?.capabilitiesScheduled && this.canReloadCapabilities(host)) void this.reloadCapabilities(runtimeId, false).catch(() => undefined);
  }

  reloadCapabilities(runtimeId: string, manual = true): Promise<CapabilityRuntimeStatus> {
    const running = this.capabilityReloads.get(runtimeId);
    if (running) return running;
    const host = this.findRuntime(runtimeId);
    if (!host) return Promise.reject(new Error(NO_ACTIVE_SESSION_MESSAGE));
    if (manual && !host.hasCapabilityChanges) host.invalidateCapabilities();
    host.scheduleCapabilities();
    if (!this.canReloadCapabilities(host)) return Promise.resolve(host.capabilityStatus());
    const appliedBefore = host.capabilityStatus().appliedRevision;
    const job = this.enqueue(runtimeId, () => this.applyCapabilitiesOn(host));
    this.capabilityReloads.set(runtimeId, job);
    const finish = () => {
      if (this.capabilityReloads.get(runtimeId) === job) this.capabilityReloads.delete(runtimeId);
      if (host.capabilitiesScheduled && host.capabilityStatus().appliedRevision !== appliedBefore) this.flushScheduledCapabilities(runtimeId);
    };
    void job.then(finish, finish);
    return job;
  }

  private async applyCapabilitiesOn(host: AgentHost): Promise<CapabilityRuntimeStatus> {
    const isCurrent = () => this.findRuntime(host.runtimeId) === host;
    if (!isCurrent()) throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    if (!this.canReloadCapabilities(host)) { host.scheduleCapabilities(); return host.capabilityStatus(); }
    if (!host.requiresCapabilityRestart) {
      await host.refreshCapabilities();
      return host.capabilityStatus();
    }
    let revision: number | undefined;
    try {
      const previous = this.startOptions.get(host.runtimeId);
      if (!previous) throw new Error("无法恢复会话启动配置，请重新打开此会话。");
      const [state, report] = host.isRunning() ? await Promise.all([
        host.request<{ model?: { id?: string }; thinkingLevel?: string; isStreaming?: boolean; isCompacting?: boolean; pendingMessageCount?: number; autoCompactionEnabled?: boolean; steeringMode?: string; followUpMode?: string }>("get_state"),
        host.readCapabilities(true),
      ]) : [{}, host.capabilityStatus().report] as const;
      if (!isCurrent()) throw new Error(NO_ACTIVE_SESSION_MESSAGE);
      if (!this.canReloadCapabilities(host) || state.isStreaming || state.isCompacting || state.pendingMessageCount) {
        host.scheduleCapabilities();
        return host.capabilityStatus();
      }
      const options: AgentHostStartOptions = {
        ...previous, sessionPath: host.sessionKey ?? host.requestedSessionPath,
        model: state.model?.id ?? previous.model,
        effort: state.thinkingLevel ?? previous.effort,
        permission: (report as RuntimeCapabilityReport | undefined)?.permission ?? previous.permission,
      };
      if (!options.sessionPath) throw new Error("会话尚未保存，发送第一条消息后再重载。");
      this.startOptions.set(host.runtimeId, options);
      revision = host.beginCapabilityReload();
      await host.start(options, { capabilitiesReload: true, isCurrent });
      if (!isCurrent()) { await host.stop(); throw new Error(NO_ACTIVE_SESSION_MESSAGE); }
      if (typeof state.autoCompactionEnabled === "boolean") await host.request("set_auto_compaction", { enabled: state.autoCompactionEnabled });
      if (state.steeringMode) await host.request("set_steering_mode", { mode: state.steeringMode });
      if (state.followUpMode) await host.request("set_follow_up_mode", { mode: state.followUpMode });
      await host.readCapabilities(true);
      host.finishCapabilityReload(revision);
      this.reindex(host);
      return host.capabilityStatus();
    } catch (error) {
      if (isCurrent()) {
        host.failCapabilityReload(error);
        if (revision !== undefined && !host.isRunning()) await host.stop();
      }
      throw error;
    }
  }
}
