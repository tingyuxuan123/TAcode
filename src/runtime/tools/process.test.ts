/**
 * `runProcess` 的 maxStdoutLines 早停：搜索类工具靠它把「最多 N 条」变成真实总量上限。
 */

import { describe, expect, it } from "vitest";
import { runProcess } from "./process";

describe("runProcess 的 stdout 行数上限", () => {
  it("到量即终止子进程，不等待命令自然结束", async () => {
    const started = Date.now();
    const result = await runProcess("sh", ["-c", 'printf "a\\nb\\nc\\n"; sleep 30'], {
      cwd: process.cwd(),
      maxStdoutLines: 2,
      timeoutMs: 20_000,
    });
    expect(result.stdoutLineLimitReached).toBe(true);
    expect(result.stdout).toContain("a");
    // 关键：sleep 30 不该被等完（SIGTERM 后立即 close）。
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("未设置上限时全量返回且不标记", async () => {
    const result = await runProcess("sh", ["-c", 'printf "a\\nb\\nc\\n"'], {
      cwd: process.cwd(),
    });
    expect(result.stdoutLineLimitReached).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.split("\n").filter(Boolean)).toEqual(["a", "b", "c"]);
  });
});
