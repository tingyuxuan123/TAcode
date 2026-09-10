import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSnapshot } from "../shared/types";
import type { DelegationBridgeRequest, DelegationRecordSnapshot, DelegationStartPayload } from "../shared/delegation";
import type { DiagnosticSink } from "./local-logger";
import { TacodeStateStore } from "../runtime/state";
import type { AgentHostStartOptions } from "./agent-manager";
import {
  DelegationCoordinator,
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

  private readonly reportText: string;
  private readonly reportDelayMs: number;
  private readonly promptError?: Error;
  private settled = false;
  private idleWaiters: Array<() => void> = [];

  constructor(runtimeId: string, sessionKey?: string, options: FakeHostOptions = {}) {
    this.runtimeId = runtimeId;
    this.sessionKey = sessionKey;
    this.requestedSessionPath = sessionKey;
    this.reportText = options.reportText ?? "Found src/main/index.ts:1";
    this.reportDelayMs = options.reportDelayMs ?? 0;
    this.promptError = options.promptError;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(options: AgentHostStartOptions): Promise<AgentSnapshot> {
    this.sessionKey = options.sessionPath;
    this.requestedSessionPath = options.sessionPath;
    return { state: {}, messages: [], models: [], thinkingLevels: [] };
  }

  async request<T>(type: string, data: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(`request:${type}`);
    if (!this.running && !this.settled) throw new Error("Agent session closed");
    if (type === "prompt") {
      if (this.promptError) throw this.promptError;
      this.messages.push({ role: "user", content: data.message });
      if (this.reportText) {
        setTimeout(() => {
          if (!this.running && !this.settled) return;
          this.messages.push({ role: "assistant", content: [{ type: "text", text: this.reportText }] });
          this.settleTurn();
        }, this.reportDelayMs);
      } else {
        setTimeout(() => this.settleTurn(), this.reportDelayMs);
      }
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
  vi.stubEnv("TETHER_HOME", "");
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
    const { coordinator, logs, parent, state } = await fixture();
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
