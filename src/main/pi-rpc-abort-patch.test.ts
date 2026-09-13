import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * pi RPC abort 补丁的金丝雀（patches/@earendil-works__pi-coding-agent@0.83.0.patch）：
 * abort 在收尾时清空 followUp 队列。pi 原生 abort 不清队列，扩展经 sendUserMessage
 * 排入的委派报告会在用户下一次发消息的回合末尾被消化，把已停止的会话重新唤醒；
 * 用户排队消息走 steering 队列，补丁刻意不碰。补丁被移除（手动删除或升级 pi 时
 * 丢弃）时这条测试第一时间报警。
 */
describe("pi RPC abort patch", () => {
  it("clears the follow-up queue when a turn is aborted", () => {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
    const rpcModePath = path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "rpc", "rpc-mode.js");
    const source = readFileSync(rpcModePath, "utf8");
    const abortCase = source.match(/case "abort": \{[\s\S]*?\n            \}/);
    expect(abortCase).toBeTruthy();
    expect(abortCase?.[0]).toContain("await session.abort()");
    expect(abortCase?.[0]).toContain("clearFollowUpQueue()");
    // steering 里的用户排队必须保留：不能顺手调用 session.clearQueue()。
    expect(abortCase?.[0]).not.toContain("session.clearQueue()");
  });
});
