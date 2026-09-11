import { describe, expect, it } from "vitest";
import { seatbeltRules } from "./sandbox";

/**
 * Seatbelt 规则回归：子代理里 `pnpm test` 曾因 `(deny signal)` 无法终止自己的 worker
 * （报 `kill EPERM`），导致 test-runner 角色在沙箱内形同虚设。
 *
 * 实测（scratch 探针，三种规则对比）：
 * - `(target self)`：连直接子进程都杀不掉 → EPERM；
 * - 加 `(target children)`：能杀自己的子进程与孙进程（pnpm → vitest → worker），
 *   且无关进程（Electron 主进程/开发服务器）仍被拒绝；
 * - 再加 `(target pgrp)`：会连带放行同进程组的无关进程，隔离被破坏，故不采用。
 */
describe("seatbeltRules", () => {
  const rules = seatbeltRules("workspace-write", ["/tmp/ws"], false);

  it("放行对自己后代进程发信号（测试/构建能正常收尾）", () => {
    expect(rules).toContain("(allow signal (target children))");
    expect(rules).toContain("(allow signal (target self))");
  });

  it("仍然默认拒绝信号，且不放行同进程组（保护主进程与开发服务器）", () => {
    expect(rules).toContain("(deny signal)");
    expect(rules).not.toContain("(target pgrp)");
  });

  it("文件写入与网络规则不受影响", () => {
    expect(rules).toContain("(deny file-write* (require-not (require-any (subpath \"/tmp/ws\"))))");
    expect(rules).toContain("(deny network*)");
    const readOnly = seatbeltRules("read-only", [], true);
    expect(readOnly).toContain("(deny file-write*)");
    expect(readOnly).not.toContain("(deny network*)");
  });
});
