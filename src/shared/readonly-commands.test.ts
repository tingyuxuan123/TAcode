import { describe, expect, it } from "vitest";
import { checkReadOnlyCommand, READONLY_EXEC_HINT } from "./readonly-commands";

/**
 * 只读子代理（explorer）的命令白名单：让它能跑 `wc -l` / `git log` 这类只读命令，
 * 同时挡掉一切写盘与间接执行（重定向、命令替换、解释器）。
 */
describe("checkReadOnlyCommand", () => {
  it("放行常见的只读命令与只读管道", () => {
    for (const command of [
      "wc -l src/renderer/ui.tsx",
      "ls -la src/main",
      "rg -c \"delegate\" src --glob '!node_modules'",
      "git status --short",
      "git log --oneline -20",
      "git diff --stat HEAD~1",
      "find src -name '*.ts' | wc -l",
      "rg -n \"TODO\" src | head -20",
      "cat package.json && git rev-parse HEAD",
      "sort -u < /dev/null",
    ]) {
      // `sort -u < /dev/null` 带重定向，应被拒；其余应通过。
      const verdict = checkReadOnlyCommand(command);
      if (command.includes("<")) expect(verdict.ok, command).toBe(false);
      else expect(verdict.ok, `${command} → ${verdict.reason}`).toBe(true);
    }
  });

  it("拒绝写盘与改动仓库的命令", () => {
    for (const command of [
      "rm -rf src",
      "echo hi > src/main/index.ts",
      "echo hi >> notes.md",
      "git commit -m x",
      "git checkout main",
      "git add -A",
      "git config user.name x",
      "npm install",
      "pnpm test",
      "node -e 'require(\"fs\").rmSync(\"src\",{recursive:true})'",
      "sh -c 'rm -rf /'",
      "python3 -c 'open(\"a\",\"w\")'",
      "cat $(ls)",
      "cat `ls`",
      "rg foo | tee out.txt",
      "find . -name '*.ts' -exec rm {} \\;",
      "xargs rm < list.txt",
      "pkill -f vitest",
      "kill 1234",
      "FOO=1 ls",
      "/usr/bin/rm -rf src",
      "sed -i '' 's/a/b/' file.ts",
    ]) {
      const verdict = checkReadOnlyCommand(command);
      expect(verdict.ok, `${command} 不该被放行`).toBe(false);
      expect(typeof verdict.reason).toBe("string");
    }
  });

  it("拒绝信息里带上可用清单，避免模型反复重试", () => {
    expect(READONLY_EXEC_HINT).toContain("wc");
    expect(READONLY_EXEC_HINT).toContain("git");
  });
});
