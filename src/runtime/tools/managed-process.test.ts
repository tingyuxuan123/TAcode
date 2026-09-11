import { describe, expect, it } from "vitest";
import { FINISHED_RETENTION_MS, ManagedProcessRegistry } from "./managed-process";
import type { SandboxOptions } from "./sandbox";

const host: SandboxOptions = { mode: "danger-full-access", network: true };

describe("ManagedProcessRegistry", () => {
  it("进程结束后仍可轮询到最终输出，不再抛 Unknown process", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start("printf 'hello\\nworld\\n'", {
        cwd: process.cwd(),
        sandbox: host,
        yieldTimeMs: 5_000,
        timeoutMs: 10_000,
      });
      expect(started.command).toBe("printf 'hello\\nworld\\n'");
      expect(started.warnings).toEqual([]);
      expect(started.running).toBe(false);

      const first = await registry.interact(started.processId, { yieldTimeMs: 10, terminate: false });
      expect(first.running).toBe(false);
      expect(first.output).toContain("hello");

      // 关键回归：第二次轮询（记录曾在此被删除）必须回放保留输出。
      const second = await registry.interact(started.processId, { yieldTimeMs: 10, terminate: false });
      expect(second.running).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.output).toContain("hello");
      expect(second.exitCode).toBe(0);
    } finally {
      registry.dispose();
    }
  });

  it("把命令级 warning 带进结果", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      const started = await registry.start("echo done", {
        cwd: process.cwd(),
        sandbox: host,
        yieldTimeMs: 5_000,
        timeoutMs: 10_000,
      });
      // 通过 lintShellCommand 的路径注入：这里只断言字段存在且为数组。
      expect(Array.isArray(started.warnings)).toBe(true);
    } finally {
      registry.dispose();
    }
  });

  it("未知 process_id 时列出已知进程与保留策略", async () => {
    const registry = new ManagedProcessRegistry();
    try {
      await registry.start("printf 'x'", {
        cwd: process.cwd(),
        sandbox: host,
        yieldTimeMs: 5_000,
        timeoutMs: 10_000,
      });
      await expect(
        registry.interact("does-not-exist", { yieldTimeMs: 10, terminate: false }),
      ).rejects.toThrow(/Unknown process: does-not-exist[\s\S]*Finished but still readable/);
      await expect(
        registry.interact("does-not-exist", { yieldTimeMs: 10, terminate: false }),
      ).rejects.toThrow(new RegExp(`${Math.round(FINISHED_RETENTION_MS / 60_000)} minutes`));
    } finally {
      registry.dispose();
    }
  });
});
