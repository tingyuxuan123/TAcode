/**
 * 只读子代理可以执行的命令白名单。
 *
 * 背景：explorer / code-reviewer 这类只读角色原本连 `wc -l`、`git log` 都跑不了，
 * 只能靠 read_file 的截断提示反推行数，token 成本高且证据弱（见 docs 里的子代理实测汇总）。
 *
 * 这里刻意保守：只放行「读」类命令与只读 git 子命令；管道/`&&`/`;` 允许，但**每一段**的
 * 命令都必须命中白名单；重定向、命令替换、解释器（node/python/sh）、打包/删除类工具一律拒绝。
 */

/** 只读命令（第一段 token 必须命中；`git` 另见只读子命令表）。 */
export const READONLY_COMMANDS: readonly string[] = [
  "wc",
  "ls",
  "cat",
  "head",
  "tail",
  "find",
  "rg",
  "grep",
  "sort",
  "uniq",
  "cut",
  "tr",
  "stat",
  "du",
  "df",
  "file",
  "basename",
  "dirname",
  "realpath",
  "diff",
  "tree",
  "git",
];

/** `git` 只读子命令。 */
export const READONLY_GIT_SUBCOMMANDS: readonly string[] = [
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "shortlog",
  "blame",
  "grep",
  "describe",
  "cat-file",
];

/** 明确危险/会写盘的形态：出现在命令任意位置就拒绝。 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /[<>]/, reason: "重定向输入/输出" },
  { pattern: /`/, reason: "反引号命令替换" },
  { pattern: /\$\(/, reason: "命令替换" },
  { pattern: /\$\[/, reason: "命令替换" },
  { pattern: /(^|[^&])&([^&]|$)/, reason: "后台执行" },
  { pattern: /\b(pkill|kill|killall|xargs|tee|dd|cp|mv|rm|mkdir|rmdir|touch|chmod|chown|ln|truncate|install|sudo|su|env|nohup|nice|open|git)\s+(commit|push|checkout|reset|clean|apply|add|stash|merge|rebase|switch|restore|cherry-pick|init|tag|rm|mv|config)\b/, reason: "会改动仓库/文件的命令" },
];
/** 任意位置出现即拒绝的独立词（`find … -exec rm`、`… | xargs rm` 这类绕过）。 */
const FORBIDDEN_WORDS = ["pkill", "killall", "xargs", "tee", "dd", "rm", "mv", "chmod", "chown", "sudo", "nohup"];

/** 每个命令会「写盘或执行外部程序」的参数（按命令精确列，避免误伤 `rg -o`）。 */
const DANGEROUS_FLAGS: Record<string, readonly string[]> = {
  sort: ["-o", "--output"],
  find: ["-exec", "-execdir", "-delete", "-ok", "-fprintf", "-fls"],
  rg: ["--pre", "--pre-glob"],
  git: ["-c", "--output", "--exec-path"],
};

export interface ReadonlyCommandVerdict {
  ok: boolean;
  /** 拒绝原因（直接回给模型，避免它反复重试）。 */
  reason?: string;
}

/** 允许的命令提示，附在拒绝信息里。 */
export const READONLY_EXEC_HINT =
  `Allowed read-only commands: ${READONLY_COMMANDS.join(", ")}`
  + ` (git: ${READONLY_GIT_SUBCOMMANDS.join("|")}); pipes and && are fine, but redirection, `
  + `command substitution, interpreters (node/python/sh) and anything that writes are rejected.`;

/** 校验一条命令是否只读；`readOnly` 模式下不通过就拒绝执行。 */
export function checkReadOnlyCommand(command: string): ReadonlyCommandVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: "Empty command." };
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) return { ok: false, reason };
  }
  // 按管道/链式分隔符切段，每一段都必须命中白名单。
  const segments = trimmed
    .split(/\|\||&&|[|;\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return { ok: false, reason: "Empty command." };
  for (const segment of segments) {
    const words = segment.split(/\s+/).filter(Boolean);
    const binary = words[0] ?? "";
    const forbidden = FORBIDDEN_WORDS.find((word) => words.includes(word));
    if (forbidden) return { ok: false, reason: `${forbidden} can modify the workspace` };
    if (!READONLY_COMMANDS.includes(binary)) {
      return { ok: false, reason: `${binary || segment} is not in the read-only allowlist` };
    }
    if (binary === "git") {
      const sub = words.find((word, index) => index > 0 && !word.startsWith("-")) ?? "";
      if (!READONLY_GIT_SUBCOMMANDS.includes(sub)) {
        return { ok: false, reason: `git ${sub || "(no subcommand)"} is not read-only` };
      }
    }
    const dangerous = (DANGEROUS_FLAGS[binary] ?? []).find((flag) => words.includes(flag));
    if (dangerous) return { ok: false, reason: `${binary} ${dangerous} can write files or run programs` };
  }
  return { ok: true };
}
