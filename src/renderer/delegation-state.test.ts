import { describe, expect, it } from "vitest";
import type { DelegationRecordSnapshot } from "../shared/delegation";
import type { SessionSummary } from "../shared/types";
import { delegateProgress, type ChatMessage } from "./conversation";
import { reconcileDelegationMessages, reconcileDelegationSessions } from "./delegation-state";
import { mergeDelegationSummaries, planDelegationTabs } from "./browser/delegation-tabs";

const record: DelegationRecordSnapshot = {
  delegationId: "delegation-test", parentSessionPath: "/parent.jsonl", childSessionPath: "/child.jsonl",
  title: "检查", role: "explorer", task: "检查状态", permission: "auto", status: "completed",
  startedAt: 1, completedAt: 2, report: "complete\n已核对",
};

describe("authoritative delegation state", () => {
  it("overrides a stale disk row while keeping unrelated sessions intact", () => {
    const child = { path: "/child.jsonl", sourceDelegationId: record.delegationId, delegationStatus: "running" } as SessionSummary;
    const parent = { path: "/parent.jsonl" } as SessionSummary;
    const rows = reconcileDelegationSessions([parent, child], new Map([[record.delegationId, record]]));
    expect(rows[0]).toBe(parent);
    expect(rows[1]).toMatchObject({ delegationStatus: "completed", delegationReport: record.report });
    expect(child.delegationStatus).toBe("running");
  });

  it("updates completed background tool metadata without rewriting transcript text", () => {
    const original: ChatMessage = {
      id: "message", role: "assistant", text: "原消息", images: [], work: [],
      tools: [{ id: "tool", name: "delegate", title: "委派", status: "complete", output: "Started subagent",
        details: { total: 1, done: 0, tasks: [{ ...record, status: "running", completedAt: undefined, report: undefined }] } }],
    };
    const records = new Map([[record.delegationId, record]]);
    const [updated] = reconcileDelegationMessages([original], records);
    expect(delegateProgress(updated.tools[0])).toMatchObject({ done: 1, tasks: [{ status: "completed" }] });
    expect(updated.text).toBe(original.text);
    expect(updated.tools[0].output).toBe(original.tools[0].output);
    expect((original.tools[0].details as { done: number }).done).toBe(0);
    expect(reconcileDelegationMessages([original], records)[0]).toBe(updated);
  });

  it("refreshes background panels without opening other parents' children or taking focus", () => {
    const records = new Map([[record.delegationId, record], ["other", { ...record, delegationId: "other", status: "running" as const }]]);
    const keys = new Set([record.delegationId]);
    const merged = mergeDelegationSummaries([], records, "/another-parent.jsonl", keys);
    expect(merged).toHaveLength(1);
    const plan = planDelegationTabs({ delegations: merged, openKeys: keys, autoOpenedKeys: new Set() });
    expect(plan.requests[0]).toMatchObject({ activate: false, info: { status: "completed", report: record.report } });
    expect(plan.requests[0].info).toHaveProperty("uiRequest", undefined);
    expect(plan.requests[0].info).toHaveProperty("live", undefined);
  });

  it("restores a reopened stale card to the current cancelled state", () => {
    const merged = mergeDelegationSummaries([
      { id: record.delegationId, role: record.role, task: record.task, status: "running", childSessionPath: record.childSessionPath },
    ], new Map([[record.delegationId, { ...record, status: "cancelled" }]]), record.parentSessionPath, new Set([record.delegationId]));
    const plan = planDelegationTabs({ delegations: merged, openKeys: new Set([record.delegationId]), autoOpenedKeys: new Set([record.delegationId]) });
    expect(plan.requests[0]).toMatchObject({ activate: false, info: { status: "cancelled" } });
  });

  it("keeps the parent-derived live step unless the record snapshot carries a fresher one", () => {
    // 旧主进程构建的快照没有 live 字段：父工具进度里推导出的当前步骤不能被 undefined 冲掉。
    const merged = mergeDelegationSummaries([
      { id: record.delegationId, role: record.role, task: record.task, status: "running", childSessionPath: record.childSessionPath, live: "read_file src/main/index.ts" },
    ], new Map([[record.delegationId, { ...record, status: "running" as const }]]), record.parentSessionPath, new Set([record.delegationId]));
    expect(merged[0]?.live).toBe("read_file src/main/index.ts");
    // 协调器快照自带 live（来自子 worker 实时事件）时优先生效。
    const overridden = mergeDelegationSummaries([
      { id: record.delegationId, role: record.role, task: record.task, status: "running", childSessionPath: record.childSessionPath, live: "read_file stale.ts" },
    ], new Map([[record.delegationId, { ...record, status: "running" as const, live: "search_files todo" }]]), record.parentSessionPath, new Set([record.delegationId]));
    expect(overridden[0]?.live).toBe("search_files todo");
  });
});
