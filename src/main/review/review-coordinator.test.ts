import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewRun } from "../../shared/review";
import { ReviewCoordinator } from "./review-coordinator";
import type { RangeInput } from "./review-findings";

const goodRange: RangeInput = { label: "未暂存改动", truncated: false, notes: [],
  files: [{ path: "src/alpha.ts", change: "modified", oldLines: 2, newLines: 3, patch: "@@\n-old\n+new\n" }] };
const goodReport = (line = 2) => `\`\`\`json\n${JSON.stringify({ findings: [{ path: "src/alpha.ts", side: "new", line, severity: "medium",
  title: "可能泄漏", evidence: "第 2 行创建后没有关闭", confidence: "inferred" }], coverage: { notes: ["未跑测试"] } })}\n\`\`\``;

describe("AI review coordinator", () => {
  let root: string;
  const build = (overrides: Partial<ConstructorParameters<typeof ReviewCoordinator>[0]> = {}) => new ReviewCoordinator({
    root,
    describeRange: async () => goodRange,
    run: async () => goodReport(),
    ...overrides,
  });
  const request = { projectRoot: "/project-a", comparison: { kind: "unstaged" as const } };

  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-review-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it("records a completed run with validated findings and coverage", async () => {
    const published: ReviewRun[] = [];
    const coordinator = build({ publish: (run) => published.push(run) });
    const started = await coordinator.start({ ...request });
    expect(started.status).toBe("running");
    await coordinator.idle();
    const [run] = await coordinator.list("/project-a");
    expect(run?.status).toBe("completed");
    expect(run?.findings).toEqual([expect.objectContaining({ path: "src/alpha.ts", side: "new", line: 2, severity: "medium" })]);
    expect(run?.coverage).toEqual({ files: 1, truncated: false, notes: ["未跑测试"] });
    expect(published.map((entry) => entry.status)).toEqual(["running", "running", "completed"]);
  });

  it("keeps invalid locations visible in the rejected list and fails a report it cannot parse", async () => {
    const coordinator = build({ run: async () => goodReport(99) });
    await coordinator.start({ ...request });
    await coordinator.idle();
    const [run] = await coordinator.list("/project-a");
    expect(run?.status).toBe("completed");
    expect(run?.findings).toEqual([]);
    expect(run?.rejected[0]?.reason).toMatch(/行号超出范围/);

    const broken = build({ run: async () => "没有 JSON 的报告" });
    await broken.start({ ...request });
    await broken.idle();
    const [failed] = await broken.list("/project-a");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/JSON/);
  });

  it("cancels a running review and records the worker failure separately", async () => {
    const coordinator = build({ run: async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new Error("worker stopped");
    } });
    const run = await coordinator.start({ ...request });
    coordinator.cancel(run.id);
    await coordinator.idle();
    const [cancelled] = await coordinator.list("/project-a");
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.error).toBeUndefined();

    const failing = build({ run: async () => { throw new Error("模型服务不可用"); } });
    await failing.start({ ...request });
    await failing.idle();
    const [failed] = await failing.list("/project-a");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("模型服务不可用");
  });

  it("retries with the same range and requirements, and reads history back from disk", async () => {
    const prompts: string[] = [];
    const coordinator = build({ run: async ({ prompt }) => { prompts.push(prompt); return goodReport(); } });
    const first = await coordinator.start({ ...request, requirements: "重点看并发" });
    await coordinator.idle();
    const retried = await coordinator.retry(first.id);
    expect(retried?.id).not.toBe(first.id);
    expect(retried?.requirements).toBe("重点看并发");
    expect(retried?.comparison).toEqual(first.comparison);
    await coordinator.idle();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("重点看并发");

    // A fresh coordinator sees the same history after a reload.
    const reloaded = build();
    const runs = await reloaded.list("/project-a");
    expect(runs).toHaveLength(2);
    expect(runs[0]!.startedAt).toBeGreaterThanOrEqual(runs[1]!.startedAt);
    expect(await reloaded.list("/project-b")).toEqual([]);
    expect(await reloaded.retry("missing")).toBeUndefined();
    expect(reloaded.cancel("missing")).toBeUndefined();
  });

  it("carries the range coverage into the run and stays idle when the worker never starts", async () => {
    const coordinator = build({ describeRange: async () => ({ ...goodRange, truncated: true, notes: ["补丁超出预算"] }) });
    const run = await coordinator.start({ ...request });
    await coordinator.idle();
    const [recorded] = await coordinator.list("/project-a");
    expect(recorded?.id).toBe(run.id);
    expect(recorded?.coverage).toEqual({ files: 1, truncated: true, notes: ["补丁超出预算", "未跑测试"] });
    const never = build({ run: async ({ signal }) => { expect(signal.aborted).toBe(false); return goodReport(); } });
    await never.idle();
  });

  it("keeps the newest twenty runs per project and keeps publishing", async () => {
    const publish = vi.fn();
    const coordinator = build({ publish });
    for (let index = 0; index < 22; index++) { await coordinator.start({ ...request }); await coordinator.idle(); }
    const runs = await coordinator.list("/project-a");
    expect(runs).toHaveLength(20);
    expect(publish).toHaveBeenCalled();
  });
});
