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
 * “当前活动会话”这一易变全局量。同一 runtime 的 start/stop/command 串行执行，
 * 切换会话只改变活动句柄，不会让旧请求改写新会话的状态。
 */
export class AgentManager {
  private readonly runtimes = new Map<string, AgentHost>();
  /** 会话路径 / 请求路径 → runtimeId；rekey 时先清旧别名，避免路径漂移后指向旧 host。 */
  private readonly index = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private activeRuntimeId: string | undefined;

  constructor(private readonly options: AgentManagerOptions) {}

  get active(): string | undefined {
    return this.activeRuntimeId;
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

  async start(options: AgentHostStartOptions): Promise<AgentStartResult> {
    const existing = this.findBySession(options.sessionPath);
    if (existing?.isRunning()) return this.enqueue(existing.runtimeId, () => this.startOn(existing, options));
    // A worker can exit before the renderer gets a chance to call stop(). Do not
    // reuse that dead host: a queued stop followed by a restart could otherwise
    // remove the restarted host from the manager map.
    if (existing) this.removeHost(existing);
    // 没有现存宿主：按请求路径串行化，避免同一会话被并发启动两次。
    const key = `start:${options.sessionPath ?? options.cwd ?? "new"}`;
    return this.enqueue(key, () => {
      const reused = this.findBySession(options.sessionPath);
      return this.startOn(reused ?? this.createHost(), options);
    });
  }

  /** 复用已在运行的宿主：只取快照与缺口事件，不重启 worker。 */
  resume(runtimeId: string): Promise<AgentStartResult> {
    const host = this.findRuntime(runtimeId);
    if (!host || !host.isRunning())
      return Promise.reject(new Error("Agent session is not running"));
    return this.enqueue(host.runtimeId, async () => {
      const snapshot = await host.snapshot();
      this.activeRuntimeId = host.runtimeId;
      const cut = host.lastSnapshotSeq;
      return {
        ...snapshot,
        runtimeId: host.runtimeId,
        lastSeq: cut,
        replay: host.replaySince(cut),
      };
    });
  }

  stop(runtimeId?: string): Promise<void> {
    const host = this.activeHost(runtimeId);
    if (!host) return Promise.resolve();
    return this.enqueue(host.runtimeId, async () => {
      this.removeHost(host);
      await host.stop();
    });
  }

  command<T>(
    runtimeId: string | undefined,
    type: string,
    data?: Record<string, unknown>,
  ): Promise<T> {
    const host = this.activeHost(runtimeId);
    if (!host) return Promise.reject(new Error(NO_ACTIVE_SESSION_MESSAGE));
    if (!host.isRunning()) {
      this.removeHost(host);
      return Promise.reject(new Error(NO_ACTIVE_SESSION_MESSAGE));
    }
    // 停止类命令绕开队列：用户的「停止」不能被队列里的长请求拖住（见 OUT_OF_BAND_COMMANDS）。
    if (OUT_OF_BAND_COMMANDS.has(type)) return host.request<T>(type, data);
    return this.enqueue(host.runtimeId, async () => {
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
    if (!host) return Promise.resolve();
    // UI 应答是宿主正在等待的“带外”回复，必须绕过按 runtime 串行化的命令队列：
    // 触发这次询问的 prompt 命令可能仍挂在队列里（例如斜杠命令内部 await
    // ctx.ui.confirm），若把应答排在它后面就会互相等待死锁。
    return host.respondToUi(id, response);
  }

  /** 退出/关窗时回收全部宿主，每个 host 只 stop 一次。 */
  async stopAll(): Promise<void> {
    const hosts = [...this.runtimes.values()];
    this.runtimes.clear();
    this.index.clear();
    this.activeRuntimeId = undefined;
    await Promise.all(hosts.map((host) => host.stop().catch(() => undefined)));
  }

  private createHost(): AgentHost {
    const runtimeId = `runtime-${randomUUID()}`;
    const host = this.options.createHost(runtimeId);
    host.runtimeId = runtimeId;
    this.runtimes.set(runtimeId, host);
    return host;
  }

  private removeHost(host: AgentHost): void {
    this.runtimes.delete(host.runtimeId);
    for (const [key, id] of this.index)
      if (id === host.runtimeId) this.index.delete(key);
    if (this.activeRuntimeId === host.runtimeId) this.activeRuntimeId = undefined;
  }

  private async startOn(
    host: AgentHost,
    options: AgentHostStartOptions,
  ): Promise<AgentStartResult> {
    const snapshot = await host.start(options);
    const file = sessionFileOf(snapshot) ?? options.sessionPath;
    if (file) host.sessionKey = file;
    this.reindex(host);
    this.activeRuntimeId = host.runtimeId;
    const cut = host.lastSnapshotSeq;
    return {
      ...snapshot,
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
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }
}
