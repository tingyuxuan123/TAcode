/**
 * shell 命令的静态检查：只把明显的误用回给模型，不改变执行行为。
 *
 * 真实踩过的坑：
 * 1. `rg -rn "…" src`：`-r` 是 `--replace`，簇写短选项时 `-rn` 被解析成 `-r n`，
 *    匹配文本被替换成 `n`，退出码仍是 0，模型会把改写后的输出当成真实内容。
 *    因此这里回显「实际解析 argv」和「大概率想要的命令」。
 * 2. 长任务接 `| tail`：管道会缓冲，进程结束前任何轮询都拿不到进度，
 *    看起来像卡死。提示改用 process_id + write_stdin 轮询，或重定向到日志再过滤。
 * 3. zsh 的 `=` 展开（EQUALS）：`echo ===` 会把 `===`当成命令 `==`，整条命令失败；
 *    写在 `&&` 链里还会短路掉后面的命令，把「分隔符没打印」误读成「后面的命令没匹配」。
 * 4. `$PIPESTATUS` 是 bash 专有：zsh 里展开为空字符串，退出码静默丢失，
 *    zsh 要用 `${pipestatus[1]}`（小写、下标从 1 开始）。
 *
 * 注意：`grep -rn` 是合法的递归搜索，这里只对 `rg` 生效；`=` 展开与 `PIPESTATUS`
 * 只在 zsh 下告警（bash / POSIX sh 下这两种写法都是正常的）。
 */

/** 长任务特征：装依赖、构建、测试、类型检查这类几分钟量级的命令。 */
const LONG_RUNNING_PATTERN =
  /\b(?:pnpm|npm|yarn|bun)\s+(?:i|install|ci|add|run|build|test|typecheck|lint|pack|dev)\b|\bnpx\b|\bnx\s|\btsc\b|\bvitest\b|\bjest\b|\bvite\s+build\b|\bmake\b|\bgradle\b|\bmvn\b|\bcargo\s+(?:build|test|run|check)\b|\bgo\s+(?:build|test|run)\b|\bdocker\s+(?:build|pull)\b|\bpip3?\s+install\b|\bplaywright\s+install\b|\bnext\s+build\b|\belectron-builder\b|\bxcodebuild\b/u;

const TAIL_PIPE_PATTERN = /\|\s*(?:tail|head)\b/u;

/** zsh 的 `=word` 展开：单个 `=` 是安全的字面量，两个以上就会去找同名命令。 */
const EQUALS_WORD_PATTERN = /^=.+/u;

const PIPESTATUS_PATTERN = /\$\{?PIPESTATUS\b/u;

export interface CommandWord {
  /** 去掉引号后的词，用于识别命令名与选项。 */
  text: string;
  /** 原样子串（含引号），用于回显。 */
  raw: string;
}

export interface CommandSegment {
  words: CommandWord[];
  /** 该命令段的原样子串。 */
  raw: string;
}

/**
 * 轻量 shell 分词：按空白切分、识别引号与转义，并在未加引号的 `;` `|` `&`
 * 处切开命令段。目标只是找出命令名与短选项，不追求完整 shell 语法。
 */
export function splitCommandSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let words: CommandWord[] = [];
  let current = "";
  let rawStart = -1;
  let rawEnd = -1;
  let started = false;
  let quote: '"' | "'" | null = null;
  let segmentStart = 0;

  const pushWord = (): void => {
    if (started) {
      words.push({ text: current, raw: rawStart >= 0 ? command.slice(rawStart, rawEnd + 1) : current });
    }
    current = "";
    rawStart = -1;
    rawEnd = -1;
    started = false;
  };
  const pushSegment = (end: number): void => {
    pushWord();
    if (words.length) segments.push({ words, raw: command.slice(segmentStart, end).trim() });
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote) {
      if (char === "\\" && quote === '"' && next !== undefined) {
        current += next;
        rawEnd = index + 1;
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        rawEnd = index;
        continue;
      }
      current += char;
      rawEnd = index;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      if (rawStart < 0) rawStart = index;
      rawEnd = index;
      continue;
    }
    if (char === "\\" && next !== undefined) {
      current += next;
      started = true;
      if (rawStart < 0) rawStart = index;
      rawEnd = index + 1;
      index += 1;
      continue;
    }
    if (/\s/u.test(char)) {
      pushWord();
      continue;
    }
    if (char === ";" || char === "|" || char === "&") {
      // `2>&1`、`&>file`、`&1`：重定向里的 & 不是分隔符。
      if (char === "&" && (next === ">" || (next !== undefined && /\d/u.test(next)))) {
        current += char;
        started = true;
        if (rawStart < 0) rawStart = index;
        rawEnd = index;
        continue;
      }
      pushSegment(index);
      const doubled = (char === "&" && next === "&") || (char === "|" && next === "|");
      if (doubled) index += 1;
      segmentStart = index + 1;
      continue;
    }
    current += char;
    started = true;
    if (rawStart < 0) rawStart = index;
    rawEnd = index;
  }
  pushSegment(command.length);
  return segments;
}

function baseName(word: string): string {
  const trimmed = word.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** 取命令名的 basename，供其它模块判断命令类型。 */
export function commandBaseName(word: string): string {
  return baseName(word);
}

export interface RipgrepReplaceMisuse {
  /** 触发告警的原始命令段，例如 `rg -rn "webview" src`。 */
  command: string;
  /** 短选项簇，例如 `-rn`。 */
  cluster: string;
  /** 实际被当作替换文本的值，例如 `n`。 */
  replacement: string;
  /** shell 实际展开出的 argv，例如 `rg -r n "webview" src`。 */
  parsed: string;
  /** 大概率想要的命令，例如 `rg -n "webview" src`。 */
  intended: string;
}

/**
 * 找出命令里对 ripgrep 的 `-r`（`--replace`）误用。
 * 只处理 `rg`：`grep -rn` 的 `-r` 是递归，属于正常写法。
 */
export function detectRipgrepReplaceMisuse(command: string): RipgrepReplaceMisuse[] {
  const misuses: RipgrepReplaceMisuse[] = [];
  for (const segment of splitCommandSegments(command)) {
    if (baseName(segment.words[0]?.text ?? "") !== "rg") continue;
    const display = (index: number): string => {
      const word = segment.words[index];
      return word ? word.raw || word.text : "";
    };
    for (let index = 1; index < segment.words.length; index += 1) {
      const entry = segment.words[index]!;
      // 只有原样以 `-` 开头的词才是旗标：引号内或转义后的 `-rn` 只是搜索模式。
      if (!entry.raw.startsWith("-")) continue;
      const word = entry.text;
      if (word === "--") break;
      if (!/^-[A-Za-z0-9]/u.test(word)) continue;
      const cluster = word.slice(1);
      const position = cluster.indexOf("r");
      if (position === -1) continue;
      const before = cluster.slice(0, position);
      const inline = cluster.slice(position + 1);
      const consumedNext = inline.length === 0 && index + 1 < segment.words.length;
      const replacement = inline || (consumedNext ? display(index + 1) : "");
      const tail = segment.words.slice(consumedNext ? index + 2 : index + 1).map((item) => item.raw || item.text);
      // 去掉误用的 r 与其取值后剩下的旗标，才是原本想要的搜索参数。
      const intendedFlags = `${before}${inline}`;
      misuses.push({
        command: segment.raw,
        cluster: word,
        replacement,
        parsed: ["rg", ...(before ? [`-${before}`] : []), "-r", ...(replacement ? [replacement] : []), ...tail].join(" "),
        intended: ["rg", intendedFlags ? `-${intendedFlags}` : "-n", ...tail].join(" "),
      });
    }
  }
  return misuses;
}

export function formatRipgrepReplaceMisuse(misuse: RipgrepReplaceMisuse): string {
  const meaning = /[A-Za-z0-9]/u.test(misuse.replacement)
    ? `-r (--replace) consumed "${misuse.replacement}" as the replacement text, so every match was rewritten to "${misuse.replacement}" and the exit code stays 0.`
    : "-r (--replace) consumed the next argument as the replacement text, so the output does not reflect the real file contents.";
  return [
    `warning: ripgrep parses ${misuse.cluster} as shown below — ${meaning}`,
    `  command:  ${misuse.command}`,
    `  parsed:   ${misuse.parsed}`,
    `  intended: ${misuse.intended}`,
    "  (rg -r only rewrites matches in its output; use -n for line numbers and write --replace explicitly only when you really want substitution.)",
  ].join("\n");
}

export function formatTailPipeWarning(): string {
  return [
    "warning: this long-running command pipes its output into tail/head, which buffers until the process exits.",
    "  Polling it will look stuck with no output, and the buffered text only appears at the very end.",
    "  Run it without the pipe, keep the process_id, and poll with write_stdin (yield_time_ms around 30000),",
    '  or redirect to a log and filter afterwards: cmd > /tmp/run.log 2>&1; rg -n "error" /tmp/run.log',
  ].join("\n");
}

/** zsh 把以 `=` 开头的裸词展开成命令路径（EQUALS），`===` 会被当成命令 `==`。 */
export interface EqualsWordMisuse {
  /** 触发告警的命令段。 */
  command: string;
  /** 原样回显的裸词，例如 `===`。 */
  word: string;
  /** 加引号后的写法。 */
  intended: string;
}

export function detectEqualsWordMisuse(command: string): EqualsWordMisuse[] {
  const misuses: EqualsWordMisuse[] = [];
  for (const segment of splitCommandSegments(command)) {
    for (const entry of segment.words) {
      // 加引号或转义过的 `=` 是安全的字面量；单个 `=` 也不会触发展开。
      if (!entry.raw.startsWith("=")) continue;
      if (!EQUALS_WORD_PATTERN.test(entry.text)) continue;
      misuses.push({ command: segment.raw, word: entry.raw, intended: `"${entry.text}"` });
    }
  }
  return misuses;
}

export function formatEqualsWordWarning(misuse: EqualsWordMisuse): string {
  return [
    `warning: zsh expands a bare word starting with \`=\` as a command path, so ${misuse.word} is run as a command instead of being printed.`,
    `  command:  ${misuse.command}`,
    `  zsh:      \`${misuse.word}\` runs \`${misuse.word.slice(1)}\` → "not found", exit 1, nothing is printed;`,
    "            in an `a && echo === && b` chain this short-circuits and `b` never runs — the exit code 1 is from the separator, not from `b`.",
    `  intended: use quotes — ${misuse.intended}`,
  ].join("\n");
}

export function formatPipestatusWarning(command: string): string {
  return [
    "warning: $PIPESTATUS is bash-only; zsh exposes `pipestatus` (lowercase) with 1-based indexes.",
    `  command:  ${oneLineCommand(command)}`,
    "  zsh:      ${PIPESTATUS[0]} expands to an empty string, so the pipeline status is silently lost.",
    "  intended: use ${pipestatus[1]} for the first command in the pipeline (zsh arrays start at 1).",
  ].join("\n");
}

function oneLineCommand(command: string): string {
  return command.trim().replace(/\s+/gu, " ");
}

/** 从 shell 路径里取名字（`/bin/zsh` → `zsh`），未知时按 POSIX sh 处理。 */
export function shellName(shell: string | undefined): string {
  const value = (shell ?? process.env.SHELL ?? "/bin/sh").trim();
  if (!value) return "sh";
  const slash = value.lastIndexOf("/");
  return (slash === -1 ? value : value.slice(slash + 1)).toLowerCase();
}

export interface ShellLintOptions {
  /** 宿主 shell 路径或名字；默认取 `$SHELL`。zsh 专属规则只在 zsh 下启用。 */
  shell?: string;
}

/** 命令级的静态提示；没有可疑写法时返回空数组。 */
export function lintShellCommand(command: string, options: ShellLintOptions = {}): string[] {
  const warnings = detectRipgrepReplaceMisuse(command).map(formatRipgrepReplaceMisuse);
  if (TAIL_PIPE_PATTERN.test(command) && LONG_RUNNING_PATTERN.test(command)) {
    warnings.push(formatTailPipeWarning());
  }
  // `=word` 展开与 `PIPESTATUS` 都是 zsh 专有行为：在 bash / POSIX sh 下它们能正常工作。
  if (shellName(options.shell) === "zsh") {
    warnings.push(...detectEqualsWordMisuse(command).map(formatEqualsWordWarning));
    if (PIPESTATUS_PATTERN.test(command)) warnings.push(formatPipestatusWarning(command));
  }
  return warnings;
}
