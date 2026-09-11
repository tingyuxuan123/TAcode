import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSnapshot } from "../shared/types";
import type { DelegationBridgeRequest, DelegationRecordSnapshot, DelegationStartPayload } from "../shared/delegation";
import { DELEGATION_MAX_CONCURRENCY, DELEGATION_MAX_REPORT_CHARS } from "../shared/delegation";
import type { DiagnosticSink } from "./local-logger";
import { TacodeStateStore } from "../runtime/state";
import type { AgentHostStartOptions } from "./agent-manager";
import {
  DelegationCoordinator,
  effectivePermission,
  type DelegationHost,
} from "./delegation-coordinator";

/**
 * 纯逻辑竞态测试：注入假 createHost，绝不真实 spawn worker。
 *
 * 关键点：FakeHost 的 prompt 响应是“接收即返回”，assistant 报告在 reportDelayMs
 * 之后才进入消息列表——这正是生产事故（8/8 误判 failed）的形态。协调器必须等
 * waitForIdle 之后再判定，不能拿 prompt 的响应当完成依据。
 */

vi.mock("../runtime/subagents.js", () => ({
  loadEnabledSubagents: async () => [{
    name: "explorer",
    description: "Explore",
    tools: ["read_file", "list_files", "search_files"],
    prompt: "Inspect and report.",
    thinkingLevel: "medium",
    maxTurns: 40,
    source: "builtin",
  }],
}));

type LogEntry = { level: string; scope: string; message: string; details?: unknown };

function recordingSink(): { sink: DiagnosticSink; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const record =
    (level: string) =>
    (scope: string, message: string, details?: unknown) =>
      entries.push({ level, scope, message, details });
  return { sink: { info: record("info"), warn: record("warn"), error: record("error") }, entries };
}

interface FakeHostOptions {
  reportText?: string;
  reportDelayMs?: number;
  /** prompt 请求本身抛错（模拟 worker 启动即失败）。 */
  promptError?: Error;
  /** 让假 host 忽略 createHost 传入的 runtimeId，复现「注入点漏写 runtimeId」。 */
  runtimeId?: string;
  /** 本次 prompt 产出的 assistant 轮次（默认 1；最后一条带 reportText）。 */
  assistantTurns?: number;
  /** 产出消息后不进入空闲，模拟「子代理没按上限自己收口」。 */
  neverSettle?: boolean;
}

/** 可编程的假 host：完整模拟 pi RPC worker 的“接收即返回 + 迟到报告”语义。 */
class FakeHost implements DelegationHost {
  runtimeId: string;
  sessionKey?: string;
  requestedSessionPath?: string;
  running = true;
  messages: unknown[] = [];
  calls: string[] = [];
  /** stop() 完成的时间戳；断言“先停完再落终态”。 */
  stoppedAt?: number;
  exitInfo?: { code?: number; signal?: string; stderrExcerpt: string };
  /** 最近一次 start 收到的启动选项；用来断言权限/思考等级这类透传字段。 */
  startOptions?: AgentHostStartOptions;

  private readonly reportText: string;
  private readonly reportDelayMs: number;
  private readonly promptError?: Error;
  private readonly assistantTurns: number;
  private readonly neverSettle: boolean;
  private settled = false;
  private idleWaiters: Array<() => void> = [];

  constructor(runtimeId: string, sessionKey?: string, options: FakeHostOptions = {}) {
    this.runtimeId = options.runtimeId ?? runtimeId;
    this.sessionKey = sessionKey;
    this.requestedSessionPath = sessionKey;
    this.reportText = options.reportText ?? "Found src/main/index.ts:1";
    this.reportDelayMs = options.reportDelayMs ?? 0;
    this.promptError = options.promptError;
    this.assistantTurns = options.assistantTurns ?? 1;
    this.neverSettle = options.neverSettle === true;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(options: AgentHostStartOptions): Promise<AgentSnapshot> {
    this.sessionKey = options.sessionPath;
    this.requestedSessionPath = options.sessionPath;
    this.startOptions = options;
    return { state: {}, messages: [], models: [], thinkingLevels: [] };
  }

  async request<T>(type: string, data: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(`request:${type}`);
    if (!this.running && !this.settled) throw new Error("Agent session closed");
    if (type === "prompt") {
      if (this.promptError) throw this.promptError;
      this.messages.push({ role: "user", content: data.message });
      setTimeout(() => {
        if (!this.running && !this.settled) return;
        const turns = Math.max(1, this.assistantTurns);
        const single = turns === 1;
        for (let index = 0; index < turns; index += 1) {
          const text = index === turns - 1 ? this.reportText : `turn-${index + 1}`;
          // 单轮且没有报告文本时保持原语义：不产出 assistant 消息（no_report 场景）。
          if (single && !text) continue;
          this.messages.push({ role: "assistant", content: text ? [{ type: "text", text }] : [] });
        }
        if (!this.neverSettle) this.settleTurn();
      }, this.reportDelayMs);
      return {} as T;
    }
    if (type === "get_messages") return { messages: this.messages } as T;
    return {} as T;
  }

  /** 完成契约：空闲（报告已产出）时立即返回；否则等到 settleTurn/kill 放行。 */
  async waitForIdle(_options?: { startGraceMs?: number }): Promise<void> {
    if (this.settled || !this.running) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  describeExit(): { code?: number; signal?: string; stderrExcerpt: string } | undefined {
    return this.exitInfo;
  }

  async stop(): Promise<void> {
    this.calls.push("stop");
    await new Promise((done) => setTimeout(done, 20));
    this.running = false;
    this.stoppedAt = Date.now();
    this.releaseIdleWaiters();
  }

  /** 模拟 worker 中途被 kill：不产出报告、状态从“生成中”直接消亡。 */
  kill(code: number, signal = "SIGKILL"): void {
    this.running = false;
    this.exitInfo = { code, signal, stderrExcerpt: "fatal: worker crashed" };
    this.releaseIdleWaiters();
  }

  private settleTurn(): void {
    this.settled = true;
    this.releaseIdleWaiters();
  }

  private releaseIdleWaiters(): void {
    for (const waiter of this.idleWaiters.splice(0)) waiter();
  }
}

const startPayload: DelegationStartPayload = {
  role: "explorer",
  task: "Find the entry point",
  title: "Explore entry point",
  cwd: "/tmp/workspace",
  provider: "deepseek",
  model: "deepseek-chat",
  permission: "auto",
  sandbox: "workspace-write",
  network: false,
};

function startRequest(requestId = "request-1"): DelegationBridgeRequest {
  return {
    type: "tacode:delegation:request",
    requestId,
    action: "start",
    parentSessionPath: "/tmp/parent.jsonl",
    payload: startPayload,
  };
}

interface Fixture {
  coordinator: DelegationCoordinator;
  state: TacodeStateStore;
  logs: LogEntry[];
  hosts: FakeHost[];
  parent: FakeHost;
}

interface FixtureOptions {
  completionTimeoutMs?: number;
  hostOptions?: (index: number) => FakeHostOptions;
  /** 外部注入的 state store（对账/水合测试用），默认新建内存库。 */
  stateStore?: TacodeStateStore;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const state = options.stateStore ?? new TacodeStateStore(":memory:");
  const { sink, entries } = recordingSink();
  const parent = new FakeHost("parent-runtime", "/tmp/parent.jsonl");
  const hosts: FakeHost[] = [];
  const coordinator = new DelegationCoordinator({
    stateStore: state,
    log: sink,
    ...(options.completionTimeoutMs !== undefined ? { completionTimeoutMs: options.completionTimeoutMs } : {}),
    createHost: (runtimeId) => {
      const host = new FakeHost(runtimeId, undefined, options.hostOptions?.(hosts.length) ?? {});
      hosts.push(host);
      return host;
    },
    findParentHost: () => parent,
    buildStartOptions: async (payload, definition, sessionPath) => ({
      provider: "deepseek",
      permission: payload.permission ?? "auto",
      sandbox: "workspace-write",
      network: false,
      cwd: payload.cwd,
      model: payload.model,
      sessionPath,
      activeTools: [...definition.tools],
      delegationDepth: 1,
    }),
    emitEvent: () => undefined,
  });
  return { coordinator, state, logs: entries, hosts, parent };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("condition not reached in time");
};

beforeEach(() => {
  vi.stubEnv("TACODE_HOME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DelegationCoordinator", () => {
  it("creates one persistent child for an idempotent request and returns its report", async () => {
    const { coordinator, state, parent } = await fixture();
    try {
      const first = await coordinator.handleRequest(startRequest(), parent) as { delegationId: string };
      const replay = await coordinator.handleRequest(startRequest("request-1"), parent) as { delegationId: string };
      expect(replay.delegationId).toBe(first.delegationId);

      const waited = await coordinator.wait("/tmp/parent.jsonl", {
        delegationIds: [first.delegationId],
        timeoutSeconds: 5,
      });
      expect(waited.status).toBe("completed");
      expect(waited.delegations[0]).toMatchObject({
        status: "completed",
        report: "Found src/main/index.ts:1",
      });
      expect(state.list({ parentSessionPath: "/tmp/parent.jsonl" })[0]).toMatchObject({
        sourceDelegationId: first.delegationId,
        delegationStatus: "completed",
        delegationReport: "Found src/main/index.ts:1",
      });

      const continued = await coordinator.continue("/tmp/parent.jsonl", {
        delegationId: first.delegationId,
        message: "Check the exact line too",
      });
      expect(continued.status).toBe("running");
      const afterContinue = await coordinator.wait("/tmp/parent.jsonl", {
        delegationIds: [first.delegationId],
        timeoutSeconds: 5,
      });
      expect(afterContinue.delegations[0]?.status).toBe("completed");
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });

  it("waits for the worker to settle before judging completion (delayed report)", async () => {
    // 报告 3 秒后才落盘：误判 bug 的最小复现。prompt 立即应答，此时取消息必然为空。
    const { coordinator, hosts, logs, parent, state } = await fixture({ hostOptions: () => ({ reportDelayMs: 3_000 }) });
    try {
      const snapshot = await coordinator.handleRequest(startRequest(), parent) as DelegationRecordSnapshot;
      expect(snapshot.status).toBe("running");
      await new Promise((done) => setTimeout(done, 200));
      // 关键断言：prompt 已应答但尚未空闲时，不得提前下结论。
      expect(coordinator.get("/tmp/parent.jsonl", { delegationIds: [snapshot.delegationId] })[0]?.status).toBe("running");

      const waited = await coordinator.wait("/tmp/parent.jsonl", {
        delegationIds: [snapshot.delegationId],
        timeoutSeconds: 8,
      });
      expect(waited.status).toBe("completed");
      expect(waited.delegations[0]).toMatchObject({
        status: "completed",
        report: "Found src/main/index.ts:1",
      });
      // 判定依据写入诊断：messages 里含 assistant 报告。
      const judged = logs.find((entry) => entry.message === "delegation completion judged");
      expect(judged).toBeTruthy();
      expect((judged?.details as Record<string, unknown>)).toMatchObject({ hasReport: true });
      expect(hosts[0].calls).toContain("request:prompt");
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  }, 20_000);

  it("classifies a mid-turn worker crash as worker_exit with exit details", async () => {
    // 报告延迟写长：确保 kill 发生在生成中（否则 0ms 的假报告会先落地，变成竞速用例）。
    const { coordinator, logs, parent, state } = await fixture({ hostOptions: () => ({ reportDelayMs: 5_000 }) });
    try {
      const snapshot = await coordinator.handleRequest(startRequest(), parent) as DelegationRecordSnapshot;
      // prompt 已应答、生成进行中时 kill worker。
      const delegated = (coordinator as unknown as { entries: Map<string, { record: DelegationRecordSnapshot; host?: FakeHost }> }).entries;
      const child = [...delegated.values()].find((entry) => entry.record.delegationId === snapshot.delegationId)?.host as FakeHost;
      await waitFor(() => child.calls.includes("request:prompt"));
      child.kill(137);

      const waited = await coordinator.wait("/tmp/parent.jsonl", {
        delegationIds: [snapshot.delegationId],
        timeoutSeconds: 5,
      });
      expect(waited.status).toBe("completed");
      const record = waited.delegations[0];
      expect(record.status).toBe("failed");
      expect(record.error).toContain("worker_exit");
      expect(record.error).toContain("exit code 137");
      expect(record.error).toContain("fatal: worker crashed");
      expect(record.error).toContain("childSessionPath=");
      expect(record.error).toContain("elapsedMs=");
      expect(logs.some((entry) => entry.message === "delegation failed")).toBe(true);
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });

  it("classifies an idle worker without assistant text as no_report and stops the host first", async () => {
    const { coordinator, state, parent } = await fixture({ hostOptions: () => ({ reportText: "", reportDelayMs: 60 }) });
    try {
      const snapshot = await coordinator.handleRequest(startRequest(), parent) as DelegationRecordSnapshot;
      const waited = await coordinator.wait("/tmp/parent.jsonl", {
        delegationIds: [snapshot.delegationId],
        timeoutSeconds: 5,
      });
      expect(waited.status).toBe("completed");
      const record = waited.delegations[0];
      expect(record.status).toBe("failed");
      expect(record.error).toContain("no_report");
      expect(record.error).toContain("without writing a report");
      expect(record.error).toContain("messages=1");
      expect(record.error).toContain("lastMessage=user");
      expect(record.error).toContain("turns=0");
      expect(record.error).toContain("toolCalls=0");
      // 终态之前必须先停 worker：不允许 failed + running 并存。
      const delegated = (coordinator as unknown as { entries: Map<string, { record: DelegationRecordSnapshot; host?: FakeHost }> }).entries;
      const child = [...delegated.values()].find((entry) => entry.record.delegationId === snapshot.delegationId)?.host as FakeHost;
      expect(child.calls).toContain("stop");
      expect(child.stoppedAt).toBeLessThanOrEqual(record.completedAt!);
      expect(child.running).toBe(false);
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });

  it("times out, stops the worker and records a timeout failure", async () => {
    const { coordinator, logs, parent, state } = await fixture({
      completionTimeoutMs: 120,
      hostOptions: () => ({ reportText: "", reportDelayMs: 60_000 }),
    });
    try {
      const snapshot = await coordinator.handleRequest(startRequest(), parent) as DelegationRecordSnapshot;
      const waited = await coordinator.wait("/tmp/parent.jsonl", {
        delegationIds: [snapshot.delegationId],
        timeoutSeconds: 5,
      });
      const record = waited.delegations[0];
      expect(record.status).toBe("failed");
      expect(record.error).toContain("reason=timeout");
      expect(record.error).toContain("was stopped");
      expect(logs.some((entry) => entry.message === "delegation timed out")).toBe(true);
      const delegated = (coordinator as unknown as { entries: Map<string, { record: DelegationRecordSnapshot; host?: FakeHost }> }).entries;
      const child = [...delegated.values()].find((entry) => entry.record.delegationId === snapshot.delegationId)?.host as FakeHost;
      expect(child.calls).toContain("stop");
      expect(child.running).toBe(false);
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });

  it("settles cancelled only after the worker actually stopped", async () => {
    const { coordinator, state, parent } = await fixture({ hostOptions: () => ({ reportText: "", reportDelayMs: 60_000 }) });
    try {
      const snapshot = await coordinator.handleRequest(startRequest(), parent) as DelegationRecordSnapshot;
      const stopped = await coordinator.stop("/tmp/parent.jsonl", { delegationIds: [snapshot.delegationId] });
      const record = stopped[0];
      expect(record.status).toBe("cancelled");
      const delegated = (coordinator as unknown as { entries: Map<string, { record: DelegationRecordSnapshot; host?: FakeHost }> }).entries;
      const child = [...delegated.values()].find((entry) => entry.record.delegationId === snapshot.delegationId)?.host as FakeHost;
      // 终态时间不得早于 worker 停止完成的时间。
      expect(child.stoppedAt).toBeDefined();
      expect(record.completedAt!).toBeGreaterThanOrEqual(child.stoppedAt!);
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });

  it("keeps two concurrent delegations' reports separate", async () => {
    const delays = [400, 100];
    const reports = ["Alpha report", "Beta report"];
    const { coordinator, state, parent } = await fixture({
      hostOptions: (i) => ({ reportText: reports[i], reportDelayMs: delays[i] }),
    });
    try {
      const first = await coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: "Alpha" });
      const second = await coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: "Beta" });
      const waited = await coordinator.wait("/tmp/parent.jsonl", {
        delegationIds: [first.delegationId, second.delegationId],
        timeoutSeconds: 8,
      });
      expect(waited.status).toBe("completed");
      const byTask = new Map(waited.delegations.map((record) => [record.task, record]));
      expect(byTask.get("Alpha")).toMatchObject({ status: "completed", report: "Alpha report" });
      expect(byTask.get("Beta")).toMatchObject({ status: "completed", report: "Beta report" });
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  }, 15_000);

  it("records diagnostics for launch, judgment, failure and settle", async () => {
    const { coordinator, logs, parent, state } = await fixture({ hostOptions: () => ({ reportDelayMs: 40 }) });
    try {
      const snapshot = await coordinator.handleRequest(startRequest(), parent) as DelegationRecordSnapshot;
      await coordinator.wait("/tmp/parent.jsonl", { delegationIds: [snapshot.delegationId], timeoutSeconds: 5 });
      const messages = logs.map((entry) => entry.message);
      expect(messages).toContain("delegation launching");
      expect(messages).toContain("delegation completion judged");
      expect(messages).toContain("delegation settled");
      const launch = logs.find((entry) => entry.message === "delegation launching");
      expect((launch?.details as Record<string, unknown>)).toMatchObject({
        delegationId: snapshot.delegationId,
        childSessionPath: snapshot.childSessionPath,
      });
      expect(logs.every((entry) => entry.scope === "delegation")).toBe(true);
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });

  describe("reconciliation on startup", () => {
    it("recovers misjudged failed records whose child session has an assistant report", async () => {
      const dir = await mkdtemp(join(tmpdir(), "tacode-reconcile-"));
      try {
        const state = new TacodeStateStore(":memory:");
        const childPath = join(dir, "delegation-1.jsonl");
        await writeFile(childPath, [
          JSON.stringify({ type: "session", cwd: "/tmp/workspace", timestamp: "2026-09-10T06:00:00.000Z" }),
          JSON.stringify({ type: "message", message: { role: "user", content: "work" } }),
          JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Recovered report body" }] } }),
        ].join("\n"));
        state.createDelegatedThread({
          id: "child-1",
          sessionPath: childPath,
          cwd: "/tmp/workspace",
          title: "Explore entry point",
          parentSessionPath: "/tmp/parent.jsonl",
          sourceDelegationId: "delegation-1",
          delegationRole: "explorer",
          delegationStatus: "failed",
          delegationDepth: 1,
          delegationGoal: "Find the entry point",
          delegationPermission: "ask",
        });
        state.updateDelegation("delegation-1", {
          delegationStatus: "failed",
          delegationError: "The delegated worker finished without a report.",
          delegationCompletedAt: new Date().toISOString(),
        });

        const { coordinator, logs } = await fixture({ stateStore: state });
        try {
          await coordinator.reconcilePersistedFailures();
          const record = coordinator.get("/tmp/parent.jsonl", { delegationIds: ["delegation-1"] })[0];
          expect(record.status).toBe("completed");
          expect(record.report).toBe("Recovered report body");
          expect(record.error).toBeUndefined();
          expect(state.list({ parentSessionPath: "/tmp/parent.jsonl" })[0]).toMatchObject({
            delegationStatus: "completed",
            delegationReport: "Recovered report body",
          });
          expect(logs.some((entry) => entry.message === "delegation failure reconciled to completed")).toBe(true);
        } finally {
          await coordinator.stopAll();
          state.close();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("keeps failed records when the child session has no assistant text", async () => {
      const dir = await mkdtemp(join(tmpdir(), "tacode-reconcile-empty-"));
      try {
        const state = new TacodeStateStore(":memory:");
        const childPath = join(dir, "delegation-2.jsonl");
        await writeFile(childPath, [
          JSON.stringify({ type: "session", cwd: "/tmp/workspace", timestamp: "2026-09-10T06:00:00.000Z" }),
          JSON.stringify({ type: "message", message: { role: "user", content: "work" } }),
        ].join("\n"));
        state.createDelegatedThread({
          id: "child-2",
          sessionPath: childPath,
          cwd: "/tmp/workspace",
          title: "Explore entry point",
          parentSessionPath: "/tmp/parent.jsonl",
          sourceDelegationId: "delegation-2",
          delegationRole: "explorer",
          delegationStatus: "failed",
          delegationDepth: 1,
          delegationGoal: "Find the entry point",
        });
        const { coordinator, parent } = await fixture({ stateStore: state });
        try {
          await coordinator.reconcilePersistedFailures();
          expect(coordinator.get("/tmp/parent.jsonl", { delegationIds: ["delegation-2"] })[0]?.status).toBe("failed");
        } finally {
          await coordinator.stopAll();
          state.close();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("hydrates the persisted permission instead of defaulting to auto", async () => {
      const state = new TacodeStateStore(":memory:");
      state.createDelegatedThread({
        id: "child-3",
        sessionPath: "/tmp/delegation-3.jsonl",
        cwd: "/tmp/workspace",
        title: "Explore entry point",
        parentSessionPath: "/tmp/parent.jsonl",
        sourceDelegationId: "delegation-3",
        delegationRole: "explorer",
        delegationStatus: "interrupted",
        delegationDepth: 1,
        delegationGoal: "Find the entry point",
        delegationPermission: "ask",
      });
      const { coordinator, parent } = await fixture({ stateStore: state });
      try {
        expect(coordinator.get("/tmp/parent.jsonl", { delegationIds: ["delegation-3"] })[0]?.permission).toBe("ask");
      } finally {
        await coordinator.stopAll();
        state.close();
      }
    });

    it("restarts a hydrated worker on continue and completes the follow-up", async () => {
      const state = new TacodeStateStore(":memory:");
      state.createDelegatedThread({
        id: "child-4",
        sessionPath: "/tmp/delegation-4.jsonl",
        cwd: "/tmp/workspace",
        title: "Explore entry point",
        parentSessionPath: "/tmp/parent.jsonl",
        sourceDelegationId: "delegation-4",
        delegationRole: "explorer",
        delegationStatus: "interrupted",
        delegationDepth: 1,
        delegationGoal: "Find the entry point",
        delegationPermission: "ask",
      });
      const parent = new FakeHost("parent-runtime", "/tmp/parent.jsonl");
      const hosts: FakeHost[] = [];
      const coordinator = new DelegationCoordinator({
        stateStore: state,
        log: undefined,
        createHost: (runtimeId) => {
          const host = new FakeHost(runtimeId, undefined, { reportText: "Follow-up report" });
          hosts.push(host);
          return host;
        },
        findParentHost: () => parent,
        buildStartOptions: async (payload, definition, sessionPath) => ({
          provider: "deepseek",
          permission: payload.permission ?? "auto",
          sandbox: "workspace-write",
          network: false,
          cwd: payload.cwd,
          model: payload.model,
          sessionPath,
          activeTools: [...definition.tools],
          delegationDepth: 1,
        }),
      });
      try {
        // 水合条目没有 host——过去的死代码会直接抛“worker 不可用”。
        const resumed = await coordinator.continue("/tmp/parent.jsonl", {
          delegationId: "delegation-4",
          message: "Check the exact line too",
        });
        expect(resumed.status).toBe("running");
        expect(hosts.length).toBe(1);
        const waited = await coordinator.wait("/tmp/parent.jsonl", { timeoutSeconds: 5 });
        expect(waited.status).toBe("completed");
        expect(waited.delegations[0]).toMatchObject({
          status: "completed",
          report: "Follow-up report",
        });
      } finally {
        await coordinator.stopAll();
        state.close();
      }
    });
  });
});

describe("delegation turn limit", () => {
  it("子代理跑到定义上限时收口为 truncated，并保留已产出的报告", async () => {
    // explorer 定义 maxTurns: 40；正好跑到 40 轮（边界用 >=），随后自行空闲。
    const { coordinator, logs, state } = await fixture({
      hostOptions: () => ({ assistantTurns: 40, reportText: "partial report" }),
    });
    try {
      const started = await coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: "Too long" });
      await coordinator.wait("/tmp/parent.jsonl", { delegationIds: [started.delegationId], timeoutSeconds: 5 });
      expect(logs.some((entry) => entry.message === "delegation turn limit reached")).toBe(true);
      const snapshot = coordinator.get("/tmp/parent.jsonl", { delegationIds: [started.delegationId] })[0];
      expect(snapshot?.status).toBe("truncated");
      // truncated 是收口不是失败：报告仍然回灌，且不当作错误。
      expect(snapshot?.report).toContain("partial report");
      expect(snapshot?.error).toBeUndefined();
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });

  it("子代理没按上限自己收口时，看门狗停掉它并落 truncated", async () => {
    // neverSettle：waitForIdle 永远不返回，只能靠轮数看门狗收口（否则要等 30 分钟兜底超时）。
    const { coordinator, hosts, logs, state } = await fixture({
      hostOptions: () => ({ assistantTurns: 41, neverSettle: true }),
    });
    try {
      const started = await coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: "Runaway" });
      await coordinator.wait("/tmp/parent.jsonl", { delegationIds: [started.delegationId], timeoutSeconds: 15 });
      expect(logs.some((entry) => entry.message === "delegation turn limit enforced")).toBe(true);
      expect(hosts[0]?.isRunning()).toBe(false);
      expect(coordinator.list("/tmp/parent.jsonl")[0]?.status).toBe("truncated");
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  }, 20_000);

  it("上限内的正常完成不受影响", async () => {
    const { coordinator, logs, state } = await fixture({ hostOptions: () => ({ assistantTurns: 3 }) });
    try {
      const started = await coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: "Short" });
      await coordinator.wait("/tmp/parent.jsonl", { delegationIds: [started.delegationId], timeoutSeconds: 5 });
      expect(coordinator.list("/tmp/parent.jsonl")[0]?.status).toBe("completed");
      expect(logs.some((entry) => entry.message === "delegation turn limit reached")).toBe(false);
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });

  it("continue 复用同一 worker 时按「本次运行」重新计预算", async () => {
    // 复现审查发现的缺陷：runtime 侧曾是进程级计数，续跑只能拿到 limit-N 轮，
    // 父侧却按本次新增轮次判定，于是把被提前掐断的续跑记成 completed。
    const { coordinator, state } = await fixture({ hostOptions: () => ({ assistantTurns: 3 }) });
    try {
      const started = await coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: "First" });
      await coordinator.wait("/tmp/parent.jsonl", { delegationIds: [started.delegationId], timeoutSeconds: 5 });
      expect(coordinator.get("/tmp/parent.jsonl", { delegationIds: [started.delegationId] })[0]?.status).toBe("completed");

      // 第二次运行同样产出 3 轮（累计 6 轮）：基准是本次运行前的轮次，不应触发上限。
      const resumed = await coordinator.continue("/tmp/parent.jsonl", { delegationId: started.delegationId, message: "More" });
      await coordinator.wait("/tmp/parent.jsonl", { delegationIds: [resumed.delegationId], timeoutSeconds: 5 });
      expect(coordinator.get("/tmp/parent.jsonl", { delegationIds: [resumed.delegationId] })[0]?.status).toBe("completed");
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });
});

describe("delegation concurrency reservation", () => {
  it("并发提交不会突破上限（检查与建表之间必须同步占位）", async () => {
    // 回归：原来上限检查与 createEntry 之间有 await，9 个并发 start 会全部通过检查。
    const { coordinator, state } = await fixture();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: DELEGATION_MAX_CONCURRENCY + 1 }, (_item, index) =>
          coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: `Task ${index}` })),
      );
      const started = results.filter((result) => result.status === "fulfilled").length;
      expect(started).toBe(DELEGATION_MAX_CONCURRENCY);
      expect(coordinator.list("/tmp/parent.jsonl")).toHaveLength(DELEGATION_MAX_CONCURRENCY);
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      expect(rejected.every((result) => String(result.reason).includes("Too many concurrent delegations"))).toBe(true);
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  }, 20_000);

  it("上限被拒后占位会释放（不会把后续委派永久挡在门外）", async () => {
    const { coordinator, state } = await fixture();
    try {
      const first = await coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: "First" });
      await coordinator.wait("/tmp/parent.jsonl", { delegationIds: [first.delegationId], timeoutSeconds: 5 });
      // 终态的委派不再占用并发额度。
      const next = await coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: "Second" });
      expect(next.delegationId).toBeTruthy();
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  }, 20_000);
});

describe("delegation entry retention", () => {
  it("按 parent 建索引：只返回该父会话的委派", async () => {
    const { coordinator, state } = await fixture();
    try {
      await coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: "A" });
      await coordinator.start("/tmp/other.jsonl", { ...startPayload, task: "B" });
      expect(coordinator.list("/tmp/parent.jsonl").map((item) => item.task)).toEqual(["A"]);
      expect(coordinator.list("/tmp/other.jsonl").map((item) => item.task)).toEqual(["B"]);
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  }, 20_000);

  it("终态委派超上限时淘汰最旧的，且保留刚结束的（continue 仍可用）", async () => {
    const { coordinator, state } = await fixture();
    try {
      const limit = 200; // MAX_RETAINED_TERMINAL_ENTRIES
      // 造 205 条已结算的委派：把 completedAt 手工推老，模拟历史积压。
      for (let index = 0; index < limit + 5; index += 1) {
        const record = await coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: `Task ${index}` });
        const entries = (coordinator as unknown as { entries: Map<string, { record: { status: string; completedAt?: number } }> }).entries;
        const entry = entries.get(record.delegationId)!;
        entry.record.status = "completed";
        entry.record.completedAt = Date.now() - 10 * 60_000; // 10 分钟前结束：可淘汰
        // 新插入时会触发淘汰，这里手动再跑一次，确保超限即收敛。
        (coordinator as unknown as { evictTerminalEntries(): void }).evictTerminalEntries();
      }
      const retained = (coordinator as unknown as { entries: Map<string, unknown> }).entries.size;
      expect(retained).toBeLessThanOrEqual(limit);
      // 最近一条（刚结束、未到保留窗口）仍在，continue 不会因淘汰失效。
      const latest = coordinator.list("/tmp/parent.jsonl").at(-1);
      expect(latest).toBeTruthy();
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  }, 60_000);
});

describe("delegation host diagnostics", () => {
  it("host 漏注入 runtimeId 时按命名规则兜底并告警", async () => {
    const { coordinator, hosts, logs, state } = await fixture({ hostOptions: () => ({ runtimeId: "" }) });
    try {
      const record = await coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: "Diagnose" });
      // 诊断字段不允许为空：否则日志与 describeFailure 里的 childRuntimeId 永远是空串。
      expect(hosts[0]?.runtimeId).toBe(`delegation-runtime-${record.delegationId}`);
      expect(logs.some((entry) => entry.level === "warn" && entry.message === "delegation host created without runtimeId")).toBe(true);
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });

  it("父权限缺失时按最保守的 plan 起步并告警", async () => {
    const { coordinator, hosts, logs, state } = await fixture();
    try {
      await coordinator.start("/tmp/parent.jsonl", { ...startPayload, permission: undefined });
      // 曾经的兜底是 auto：父会话可能是 plan，子代理反而更宽松（相对越权）。
      expect(hosts[0]?.startOptions?.permission).toBe("plan");
      expect(logs.some((entry) => entry.message === "delegation start without usable parent permission")).toBe(true);
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });

  it("超长报告按统一上限截断，日志留下截断前后字符数", async () => {
    const reportText = "y".repeat(DELEGATION_MAX_REPORT_CHARS + 2_000);
    const { coordinator, logs, state } = await fixture({ hostOptions: () => ({ reportText }) });
    try {
      await coordinator.start("/tmp/parent.jsonl", { ...startPayload, task: "Long report" });
      const waited = await coordinator.wait("/tmp/parent.jsonl", { timeoutSeconds: 5 });
      const report = waited.delegations[0]?.report ?? "";
      expect(report.length).toBeLessThanOrEqual(DELEGATION_MAX_REPORT_CHARS);
      expect(report).toContain("delegation text truncated");
      const settled = logs.find((entry) => entry.message === "delegation settled" && (entry.details as { reportTruncated?: boolean } | undefined)?.reportTruncated === true);
      expect((settled?.details as { reportCharsRaw?: number } | undefined)?.reportCharsRaw).toBe(reportText.length);
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });
});

describe("effectivePermission", () => {
  it("父权限缺失或非法时取最保守的 plan", () => {
    // 曾经的兜底是 auto：父会话为 plan 时子代理反而更宽松，属于相对越权。
    expect(effectivePermission(undefined, "inherit")).toBe("plan");
    expect(effectivePermission(undefined, "auto")).toBe("plan");
    expect(effectivePermission("inherited" as never, undefined)).toBe("plan");
  });

  it("永不比父会话更宽松", () => {
    expect(effectivePermission("plan", "auto")).toBe("plan");
    expect(effectivePermission("auto", "full")).toBe("auto");
    expect(effectivePermission("full", "plan")).toBe("plan");
    expect(effectivePermission("auto", "inherit")).toBe("auto");
    expect(effectivePermission("full", undefined)).toBe("full");
  });
});
