import { describe, expect, it } from "vitest";
import { describeKnownProcesses, formatManagedResult, normalizeExecParams, normalizeYieldTimeMs } from "./commands";
import { ManagedProcessRegistry, type ManagedResult } from "./managed-process";

describe("normalizeExecParams", () => {
  it("缺省时使用默认区间", () => {
    const result = normalizeExecParams({});
    expect(result).toMatchObject({ ok: true, yieldTimeMs: 10_000, timeoutMs: 120_000, notes: [] });
  });

  it("超过上限时夹取，并回显传入值、上限与常用组合", () => {
    const result = normalizeExecParams({ timeout_ms: 900_000, yield_time_ms: 180_000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.timeoutMs).toBe(600_000);
    expect(result.yieldTimeMs).toBe(30_000);
    const notes = result.notes.join("\n");
    expect(notes).toContain("timeout_ms=900000");
    expect(notes).toContain("clamped to 600000");
    expect(notes).toContain("yield_time_ms=180000");
    expect(notes).toContain("timeout_ms=600000");
  });

  it("低于下限时报错并回显传入值与期望传参", () => {
    const yieldResult = normalizeYieldTimeMs(-1);
    expect(yieldResult.ok).toBe(false);
    if (yieldResult.ok) return;
    expect(yieldResult.message).toContain("yield_time_ms=-1");
    expect(yieldResult.message).toContain("below the minimum 0");
    expect(yieldResult.message).toContain("yield_time_ms: 0–30000");

    const timeoutResult = normalizeExecParams({ timeout_ms: 500 });
    expect(timeoutResult.ok).toBe(false);
    if (timeoutResult.ok) return;
    expect(timeoutResult.message).toContain("timeout_ms=500");
    expect(timeoutResult.message).toContain("timeout_ms: 1000–600000");
  });

  it("非整数回显传入的原始值", () => {
    const result = normalizeExecParams({ timeout_ms: "long" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('timeout_ms="long"');
  });
});

describe("describeKnownProcesses", () => {
  it("没有受管进程时给出下一步", () => {
    expect(describeKnownProcesses(new ManagedProcessRegistry())).toContain("Run exec_command first");
  });
});

describe("formatManagedResult", () => {
  it("回显 command、warnings 与「已结束」状态", () => {
    const result: ManagedResult = {
      processId: "abc123",
      running: false,
      output: "src/pages/common/n/index.vue:1:webview",
      command: 'rg -rn "webview" src',
      warnings: ["warning: ripgrep parses -rn as shown below"],
      replayed: true,
      exitCode: 0,
      sandbox: "host",
    };
    const text = formatManagedResult(result);
    expect(text).toContain('command: rg -rn "webview" src');
    expect(text).toContain("warning: ripgrep parses -rn");
    expect(text).toContain("already exited before this poll; showing the retained output");
    expect(text).toContain("exit_code: 0");
  });

  it("把 note 放在正文之前", () => {
    const result: ManagedResult = {
      processId: "abc123",
      running: true,
      output: "",
      command: "sleep 60",
      warnings: [],
      sandbox: "host",
    };
    const text = formatManagedResult(result, false, ["note: timeout_ms=900000 was clamped"]);
    expect(text.split("\n")[0]).toContain("note: timeout_ms=900000");
    expect(text).toContain("status: running");
  });

  it("搜索类命令 exit 1 标注为「没有匹配」", () => {
    const result: ManagedResult = {
      processId: "abc123",
      running: false,
      output: "(no matches)",
      command: 'rg -n "inheritAttrs" src',
      warnings: [],
      exitCode: 1,
      sandbox: "host",
    };
    const text = formatManagedResult(result);
    expect(text).toContain("exit_code: 1 (exit 1 means no matches for this search command");
  });

  it("管道与多段命令不把退出码解释成搜索结果", () => {
    for (const command of ['rg -n "x" src | head -5', 'git status && rg -n "x" src', "pnpm test"]) {
      const text = formatManagedResult({
        processId: "abc123",
        running: false,
        output: "",
        command,
        warnings: [],
        exitCode: 1,
        sandbox: "host",
      });
      expect(text).toContain("exit_code: 1");
      expect(text).not.toContain("no matches for this search command");
    }
  });

  it("git grep 也算搜索命令", () => {
    const text = formatManagedResult({
      processId: "abc123",
      running: false,
      output: "",
      command: 'git grep -n "useEffect"',
      warnings: [],
      exitCode: 1,
      sandbox: "host",
    });
    expect(text).toContain("no matches for this search command");
  });
});
