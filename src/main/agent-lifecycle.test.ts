import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager, type AgentHostStartOptions } from "./agent-manager";
import { NO_ACTIVE_SESSION_MESSAGE } from "../shared/agent-protocol";
import type { AgentEvent, AgentSnapshot } from "../shared/types";
import type { AgentHost } from "./agent-host";

/** 最小可用的 AgentHost 替身：只实现 manager 依赖的接口。 */
class FakeHost {
  runtimeId = "";
  sessionKey?: string;
  requestedSessionPath?: string;
  starts = 0;
  stops = 0;
  requests: Array<{ type: string; data?: Record<string, unknown> }> = [];
  uiResponses: Array<{ id: string; response: Record<string, unknown> }> = [];
  running = false;
  turnActive = false;
  /** 每次 start 后由测试设置，模拟底层会话文件。 */
  nextSessionFile?: string;
  private seq = 0;
  private snapshotSeq = 0;
  private buffer: AgentEvent[] = [];

  constructor(
    private readonly options: { file?: (options: AgentHostStartOptions) => string | undefined },
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  isInTurn(): boolean {
    return this.turnActive;
  }

  get lastSnapshotSeq(): number {
    return this.snapshotSeq;
  }

  replaySince(afterSeq: number): AgentEvent[] {
    return this.buffer.filter((event) => (event.__seq ?? 0) > afterSeq);
  }

  /** 模拟底层事件流。 */
  emit(type: string, sessionKey = this.sessionKey): void {
    this.seq += 1;
    this.buffer.push({ type, __seq: this.seq, __sessionId: sessionKey });
    if (this.buffer.length > 50) this.buffer.shift();
  }

  async start(options: AgentHostStartOptions): Promise<AgentSnapshot> {
    this.starts += 1;
    this.requestedSessionPath = options.sessionPath;
    this.running = true;
    this.turnActive = true;
    this.sessionKey = this.options.file?.(options);
    this.emit("agent_start", this.sessionKey);
    this.snapshotSeq = this.seq;
    return { state: {}, messages: [], models: [], thinkingLevels: [], skills: [] };
  }

  async snapshot(): Promise<AgentSnapshot> {
    this.snapshotSeq = this.seq;
    return { state: {}, messages: [], models: [], thinkingLevels: [], skills: [] };
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
    this.turnActive = false;
  }

  async request<T>(type: string, data?: Record<string, unknown>): Promise<T> {
    this.requests.push({ type, ...(data ? { data } : {}) });
    if (this.blocker) {
      const blocker = this.blocker;
      await new Promise<void>((resolve) => {
        blocker.resolve = resolve;
      });
      this.blocker = undefined;
    }
    if (type === "get_session_stats") return { sessionFile: this.sessionKey } as T;
    return {} as T;
  }

  /** 测试用：让下一次 request 挂起，直到 releaseRequest()。 */
  blockNextRequest(): void {
    this.blocker = { resolve: () => undefined };
  }

  releaseRequest(): void {
    this.blocker?.resolve();
    this.blocker = undefined;
  }

  private blocker?: { resolve: () => void };

  async respondToUi(id: string, response: Record<string, unknown>): Promise<void> {
    this.uiResponses.push({ id, response });
  }
}

const asHost = (host: FakeHost): AgentHost => host as unknown as AgentHost;

const options = (sessionPath?: string): AgentHostStartOptions => ({
  cwd: "/tmp/ws",
  provider: "deepseek",
  permission: "auto",
  sandbox: "workspace-write",
  ...(sessionPath ? { sessionPath } : {}),
});

describe("AgentManager", () => {
  let hosts: FakeHost[];
  let manager: AgentManager;

  beforeEach(() => {
    hosts = [];
    manager = new AgentManager({
      createHost: () => {
        const host = new FakeHost({});
        hosts.push(host);
        return asHost(host);
      },
    });
  });

  it("assigns a stable runtimeId and reports it on start", async () => {
    const result = await manager.start(options("/a.jsonl"));
    expect(result.runtimeId).toMatch(/^runtime-/);
    expect(manager.active).toBe(result.runtimeId);
    expect(manager.list()).toEqual([
      expect.objectContaining({ runtimeId: result.runtimeId, running: true }),
    ]);
  });

  it("routes commands by handle, not by the active session", async () => {
    const a = await manager.start(options("/a.jsonl"));
    const b = await manager.start(options("/b.jsonl"));
    expect(manager.active).toBe(b.runtimeId);

    await manager.command(a.runtimeId, "get_state");
    // 旧句柄的命令落在 A 上，不会改写 B（活动句柄仍是 B）。
    expect(hosts[0].requests.map((item) => item.type)).toEqual(["get_state"]);
    expect(hosts[1].requests).toEqual([]);
    expect(manager.active).toBe(b.runtimeId);
  });

  it("rejects commands for an unknown handle instead of falling back to the active session", async () => {
    await manager.start(options("/a.jsonl"));
    await expect(manager.command("runtime-missing", "get_state")).rejects.toThrow(
      NO_ACTIVE_SESSION_MESSAGE,
    );
  });

  it("serializes concurrent starts for the same session path into one host", async () => {
    const [first, second] = await Promise.all([
      manager.start(options("/a.jsonl")),
      manager.start(options("/a.jsonl")),
    ]);
    expect(hosts).toHaveLength(1);
    expect(first.runtimeId).toBe(second.runtimeId);
  });

  it("reuses a running host on resume without spawning another worker", async () => {
    const started = await manager.start(options("/a.jsonl"));
    const resumed = await manager.resume(started.runtimeId);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].starts).toBe(1);
    expect(resumed.runtimeId).toBe(started.runtimeId);
  });

  it("rekeys the session index when the worker reports a new session file", async () => {
    const started = await manager.start(options("/requested.jsonl"));
    const host = hosts[0];
    expect(manager.findBySession("/requested.jsonl")).toBeDefined();

    host.sessionKey = "/renamed.jsonl";
    await manager.command(started.runtimeId, "get_session_stats");
    // get_session_stats 返回的 sessionFile 触发 rekey，旧路径别名被清除。
    expect(manager.findBySession("/renamed.jsonl")).toBeDefined();
    expect(manager.findBySession("/requested.jsonl")).toBeUndefined();
  });

  it("stops only the targeted runtime and clears its index", async () => {
    const a = await manager.start(options("/a.jsonl"));
    const b = await manager.start(options("/b.jsonl"));
    await manager.stop(a.runtimeId);
    expect(hosts[0].stops).toBe(1);
    expect(hosts[1].stops).toBe(0);
    expect(manager.findRuntime(a.runtimeId)).toBeUndefined();
    expect(manager.findRuntime(b.runtimeId)).toBeDefined();
    expect(manager.findBySession("/a.jsonl")).toBeUndefined();
  });

  it("replays only events after the snapshot cut", async () => {
    const started = await manager.start(options("/a.jsonl"));
    const host = hosts[0];
    expect(started.lastSeq).toBeGreaterThanOrEqual(1);
    // 快照之后产生的新事件必须能补齐。
    host.emit("message_update");
    const missed = manager.replay(started.runtimeId, started.lastSeq);
    expect(missed.map((event) => event.type)).toEqual(["message_update"]);
    expect(missed[0].__seq).toBeGreaterThan(started.lastSeq);
  });

  it("reports running sessions for renderer recovery", async () => {
    const a = await manager.start(options("/a.jsonl"));
    const b = await manager.start(options("/b.jsonl"));
    hosts[1].turnActive = false;
    const list = manager.list();
    expect(list).toEqual([
      expect.objectContaining({ runtimeId: a.runtimeId, running: true }),
      expect.objectContaining({ runtimeId: b.runtimeId, running: false }),
    ]);
  });

  it("stopAll stops every host exactly once", async () => {
    await manager.start(options("/a.jsonl"));
    await manager.start(options("/b.jsonl"));
    await manager.stopAll();
    expect(hosts.map((host) => host.stops)).toEqual([1, 1]);
    expect(manager.list()).toEqual([]);
    expect(manager.active).toBeUndefined();
  });

  it("forwards ui responses to the addressed runtime", async () => {
    const a = await manager.start(options("/a.jsonl"));
    const b = await manager.start(options("/b.jsonl"));
    await manager.respondToUi(a.runtimeId, "req-1", { value: "ok" });
    expect(hosts[0].uiResponses).toEqual([{ id: "req-1", response: { value: "ok" } }]);
    expect(hosts[1].uiResponses).toEqual([]);
    expect(manager.active).toBe(b.runtimeId);
  });

  it("delivers ui responses while a command on the same runtime is still pending", async () => {
    // 回归：斜杠命令内部的 ctx.ui.confirm 会挂在 prompt 请求上，应答若排在命令队列
    // 后面就会与宿主互相等待。UI 应答必须绕过队列直接下发。
    const started = await manager.start(options("/a.jsonl"));
    hosts[0].blockNextRequest();
    const pending = manager.command(started.runtimeId, "get_state");
    await new Promise((resolve) => setImmediate(resolve));
    expect(hosts[0].requests.map((item) => item.type)).toEqual(["get_state"]);

    await manager.respondToUi(started.runtimeId, "req-blocked", { confirmed: true });
    expect(hosts[0].uiResponses).toEqual([
      { id: "req-blocked", response: { confirmed: true } },
    ]);

    hosts[0].releaseRequest();
    await pending;
  });

  it("does not spawn a duplicate host when start races with an existing running host", async () => {
    const first = await manager.start(options("/a.jsonl"));
    const again = await manager.start(options("/a.jsonl"));
    // 已有运行中 host 时，第二次 start 应复用同一 runtime，而不是再 spawn。
    expect(hosts).toHaveLength(1);
    expect(again.runtimeId).toBe(first.runtimeId);
  });
});

describe("AgentManager error handling", () => {
  it("surfaces worker start failures without registering a stale runtime", async () => {
    const failing = new FakeHost({});
    vi.spyOn(failing, "start").mockRejectedValue(new Error("spawn failed"));
    const manager = new AgentManager({ createHost: () => asHost(failing) });
    await expect(manager.start(options("/a.jsonl"))).rejects.toThrow("spawn failed");
    // 宿主仍在注册表中，但没有任何运行句柄被视为活动。
    expect(manager.active).toBeUndefined();
  });
});
