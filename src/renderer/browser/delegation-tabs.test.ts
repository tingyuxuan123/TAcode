import { describe, expect, it } from "vitest";
import { collectDelegations, planDelegationTabs, type DelegationSummary } from "./delegation-tabs";
import type { ChatMessage } from "../conversation";

const delegateMessage = (
  tasks: Array<Record<string, unknown>>,
  status: ChatMessage["tools"][number]["status"] = "running",
): ChatMessage => ({
  id: "msg-delegate",
  role: "assistant",
  text: "",
  images: [],
  work: [],
  tools: [{
    id: "tool-delegate",
    name: "delegate",
    title: "委托",
    status,
    args: { tasks: tasks.map((task) => ({ role: task.role, task: task.task })) },
    details: { total: tasks.length, done: 0, tasks, results: [] },
  }],
});

const summary = (overrides: Partial<DelegationSummary> = {}): DelegationSummary => ({
  id: "delegation-1",
  role: "explorer",
  task: "分析委派链路",
  status: "running",
  childSessionPath: "/sessions/delegation-1.jsonl",
  ...overrides,
});

describe("collectDelegations", () => {
  it("从会话消息里抽出委派子任务（含子会话路径与状态）", () => {
    const messages = [delegateMessage([
      { delegationId: "delegation-1", role: "explorer", task: "分析", status: "running", childSessionPath: "/sessions/delegation-1.jsonl", toolCalls: 3 },
    ])];
    expect(collectDelegations(messages)).toEqual([
      { id: "delegation-1", role: "explorer", task: "分析", status: "running", childSessionPath: "/sessions/delegation-1.jsonl", toolCalls: 3 },
    ]);
  });

  it("同一委派的多次快照只留最后状态", () => {
    const first = delegateMessage([{ delegationId: "delegation-1", role: "explorer", task: "分析", status: "running", childSessionPath: "/a.jsonl" }]);
    const second = delegateMessage([{ delegationId: "delegation-1", role: "explorer", task: "分析", status: "completed", childSessionPath: "/a.jsonl" }]);
    const merged: ChatMessage = { ...first, tools: [...first.tools, ...second.tools] };
    const collected = collectDelegations([merged]);
    expect(collected).toHaveLength(1);
    expect(collected[0]?.status).toBe("completed");
  });
});

describe("planDelegationTabs", () => {
  it("正在执行的委派首次出现时自动开标签并抢焦点", () => {
    const plan = planDelegationTabs({
      delegations: [summary()],
      openKeys: new Set(),
      autoOpenedKeys: new Set(),
    });
    expect(plan.autoOpened).toEqual(["delegation-1"]);
    expect(plan.requests).toEqual([
      {
        key: "delegation-1",
        activate: true,
        info: {
          role: "explorer",
          title: "分析委派链路",
          task: "分析委派链路",
          sessionPath: "/sessions/delegation-1.jsonl",
          status: "running",
        },
      },
    ]);
  });

  it("历史已完成委派不自动弹标签（重开会话不会开一堆）", () => {
    const plan = planDelegationTabs({
      delegations: [summary({ status: "completed" })],
      openKeys: new Set(),
      autoOpenedKeys: new Set(),
    });
    expect(plan.requests).toEqual([]);
    expect(plan.autoOpened).toEqual(["delegation-1"]);
  });

  it("已开着的标签只做实时刷新、不抢焦点", () => {
    const plan = planDelegationTabs({
      delegations: [summary({ toolCalls: 9, live: "正在读取 index.ts" })],
      openKeys: new Set(["delegation-1"]),
      autoOpenedKeys: new Set(["delegation-1"]),
    });
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0]?.activate).toBe(false);
    expect(plan.requests[0]?.info.toolCalls).toBe(9);
    expect(plan.requests[0]?.info.live).toBe("正在读取 index.ts");
  });

  it("用户手动关掉后不再自动重开", () => {
    const plan = planDelegationTabs({
      delegations: [summary()],
      openKeys: new Set(),
      autoOpenedKeys: new Set(["delegation-1"]),
    });
    expect(plan.requests).toEqual([]);
  });

  it("进程内委派（没有子会话文件）不自动开面板", () => {
    const plan = planDelegationTabs({
      delegations: [summary({ childSessionPath: undefined })],
      openKeys: new Set(),
      autoOpenedKeys: new Set(),
    });
    expect(plan.requests).toEqual([]);
    expect(plan.autoOpened).toEqual([]);
  });

  it("只有路径没有 id 时也能归一到同一个 key（与侧栏/卡片去重口径一致）", () => {
    const plan = planDelegationTabs({
      delegations: [summary({ id: undefined })],
      openKeys: new Set(["delegation-1"]),
      autoOpenedKeys: new Set(["delegation-1"]),
    });
    expect(plan.requests[0]?.key).toBe("delegation-1");
  });
});
