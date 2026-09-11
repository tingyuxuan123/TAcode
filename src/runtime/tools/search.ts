/**
 * `search_files` 的搜索后端选择、结果规范化与输出整形。
 *
 * 优先用 ripgrep：快、默认遵守 .gitignore、正则语义就是仓库里那套。
 * 找不到 rg 时退回内置 JavaScript 扫描，保证搜索功能在没装 ripgrep 的机器上
 * 依然可用（更慢，且不解析 .gitignore，只按 `DEFAULT_IGNORES` 排除生成目录）。
 *
 * 这里刻意**不做静默下载**：桌面端要遵守 TACode 的 network 权限约定，未经用户
 * 同意不应发起网络请求。需要自定义位置时设置 `TACODE_RG_PATH`。
 *
 * 两个后端都产出同一种 `Entry`，再交给同一套渲染逻辑，因此 `context` / 长行裁剪 /
 * 总量上限的语义完全一致，模型看到的格式也一致。
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";
import { runProcess } from "./process.js";

export const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.tacode/**",
];

export const MAX_SEARCH_LIMIT = 1_000;
export const MAX_SEARCH_CONTEXT = 10;

/** 单行匹配文本的字符上限：超长行（压缩产物、单行 JSON）不能一行吃掉整份结果。 */
const MAX_LINE_CHARS = 500;
/** 渲染后（含上下文行与分隔行）的行数上限，兜住 context × limit 的组合。 */
const MAX_RENDERED_LINES = 2_000;
/** 内置扫描最多读多少个文件/多少字节，避免在没有 rg 的机器上把大仓库扫穿。 */
const BUILTIN_MAX_FILES = 5_000;
const BUILTIN_MAX_FILE_BYTES = 1_000_000;
const BUILTIN_MAX_TOTAL_BYTES = 64_000_000;

const RG_TIMEOUT_MS = 30_000;
/** rg 的 stdout 只拿到总字节预算的 75%，按最长行估出的需求再留 4/3 余量。 */
const RG_BYTES_PER_LINE = 1_600;
const RG_MIN_OUTPUT_BYTES = 150_000;
const RG_MAX_OUTPUT_BYTES = 6_000_000;
/** 上下文块之间的分隔行，与 ripgrep 文本输出一致。 */
const BLOCK_SEPARATOR = "--";

interface Entry {
  kind: "match" | "context";
  path: string;
  line: number;
  text: string;
}

export interface RipgrepProbe {
  /** 可直接 spawn 的 rg 路径；没找到时为 undefined。 */
  command?: string;
  source?: "env" | "path" | "known-directory";
  /** 设置了 `TACODE_RG_PATH` 但该路径不是可执行文件时的原始值。 */
  invalidOverride?: string;
}

export interface SearchRequest {
  /** 工作区根目录（绝对路径）。 */
  root: string;
  /** 搜索起点，绝对路径，可以是文件或目录，必须位于 root 内。 */
  searchPath: string;
  query: string;
  literal: boolean;
  glob?: string;
  ignoreCase: boolean;
  /** 每个命中前后各展示多少行上下文；0 表示只返回命中行。 */
  context: number;
  /** 命中条数的**总量**上限（不含上下文行）。 */
  limit: number;
  signal?: AbortSignal;
}

export interface SearchOutcome {
  /** 已规范化为 `工作区相对路径<:|- >行号<:|- >正文`，最多 `limit` 条命中。 */
  lines: string[];
  /** 渲染出的命中行数（不含上下文行）。 */
  matches: number;
  engine: "ripgrep" | "builtin";
  /** 结果不完整：命中数达到上限、输出超预算，或某些行被裁剪。 */
  truncated: boolean;
  /** 需要附在结果后面的说明，例如「没找到 rg，已用内置搜索」。 */
  notes: string[];
}

export interface SearchDeps {
  /** 覆盖 rg 探测，便于测试内置兜底路径。 */
  probeRipgrep?: () => RipgrepProbe;
}

export function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fsSync.statSync(candidate).isFile()) return false;
  } catch {
    return false;
  }
  if (platform === "win32") return true;
  try {
    fsSync.accessSync(candidate, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(executable: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (isExecutableFile(candidate, platform)) return candidate;
  }
  return undefined;
}

/**
 * 常见安装目录。
 *
 * 用户自己装的（cargo / ~/.local）排在系统目录之前：既是常见 PATH 顺序，也让
 * 「用户显式装了一份 rg」优先于系统自带的那个。
 */
function knownRgCandidatePaths(env: NodeJS.ProcessEnv, executable: string): string[] {
  const home = env.HOME ?? os.homedir();
  const directories = [
    path.join(home, ".cargo", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/local/bin",
    "/snap/bin",
  ];
  return directories.map((directory) => path.join(directory, executable));
}

/**
 * 定位 ripgrep：`TACODE_RG_PATH` → PATH → 常见安装目录。
 *
 * `TACODE_RG_PATH` 指向不可执行文件时**不会**回退到 PATH：用户显式指定的位置失效时，
 * 静默换用另一个 rg 会让排错变得困难。此时返回 `invalidOverride`，由调用方说明并走内置搜索。
 */
export function probeRipgrep(
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): RipgrepProbe {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const executable = platform === "win32" ? "rg.exe" : "rg";

  // 这里读传入的 env 对象（默认 process.env），以便测试能完整接管 PATH/HOME 而不用改全局环境。
  const override = env.TACODE_RG_PATH?.trim();
  if (override) {
    return isExecutableFile(override, platform)
      ? { command: override, source: "env" }
      : { invalidOverride: override };
  }

  const onPath = findOnPath(executable, env, platform);
  if (onPath) return { command: onPath, source: "path" };

  for (const candidate of knownRgCandidatePaths(env, executable)) {
    if (isExecutableFile(candidate, platform)) return { command: candidate, source: "known-directory" };
  }

  return {};
}

/* ------------------------------------------------------------------ 渲染层 */

function clipLine(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_LINE_CHARS) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_LINE_CHARS)}…`, truncated: true };
}

function isContiguous(previous: Entry, entry: Entry): boolean {
  return previous.path === entry.path && entry.line === previous.line + 1;
}

function renderEntry(entry: Entry): { text: string; truncated: boolean } {
  const separator = entry.kind === "match" ? ":" : "-";
  const clipped = clipLine(entry.text);
  return { text: `${entry.path}${separator}${entry.line}${separator}${clipped.text}`, truncated: clipped.truncated };
}

interface RenderedResult {
  lines: string[];
  matches: number;
  matchLimitReached: boolean;
  lineLimitReached: boolean;
  linesTruncated: boolean;
}

/**
 * 渲染命中流：按 `limit` 截命中数、按 `MAX_RENDERED_LINES` 截总行数，并插入上下文分隔行。
 *
 * `limit` 只数命中行，不数上下文行——否则开了 context 之后「返回 200 条」会变成
 * 「返回 20 条命中 + 180 行上下文」。
 */
async function renderEntries(
  source: AsyncIterable<Entry> | Iterable<Entry>,
  context: number,
  limit: number,
): Promise<RenderedResult> {
  const lines: string[] = [];
  const result: RenderedResult = {
    lines,
    matches: 0,
    matchLimitReached: false,
    lineLimitReached: false,
    linesTruncated: false,
  };
  let matches = 0;
  let previous: Entry | undefined;
  for await (const entry of source) {
    if (entry.kind === "match") {
      if (matches >= limit) {
        result.matchLimitReached = true;
        break;
      }
      matches += 1;
    }
    if (lines.length >= MAX_RENDERED_LINES) {
      result.lineLimitReached = true;
      break;
    }
    if (context > 0 && previous && !isContiguous(previous, entry)) lines.push(BLOCK_SEPARATOR);
    const rendered = renderEntry(entry);
    if (rendered.truncated) result.linesTruncated = true;
    lines.push(rendered.text);
    previous = entry;
  }
  result.matches = matches;
  return result;
}

function matchLimitNote(limit: number): string {
  return `Only the first ${limit} matches are shown; raise limit or narrow the pattern/glob to see more.`;
}

function lineLimitNote(): string {
  return `Result reached the ${MAX_RENDERED_LINES}-line output budget; lower context/limit or narrow the pattern/glob.`;
}

function clippedLinesNote(): string {
  return `Some lines were truncated to ${MAX_LINE_CHARS} chars; use read_file to see the full lines.`;
}

/* ------------------------------------------------------------------ rg 后端 */

function compileQuery(query: string, ignoreCase: boolean): RegExp {
  try {
    // rg 的默认语义：大小写敏感、无多行；需要 `(?i)` 这类内联开关时由调用方写进 pattern。
    return new RegExp(query, ignoreCase ? "i" : "");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regular expression: ${query} (${detail})`);
  }
}

/** 每命中最多产生 1 + 2*context 行上下文，再加块间的分隔行。 */
function stdoutLineBudget(limit: number, context: number): number {
  const rendered = Math.min(limit * (1 + 2 * context), MAX_RENDERED_LINES) + limit;
  return rendered + 1;
}

function rgOutputBudgetBytes(lineBudget: number): number {
  const needed = lineBudget * RG_BYTES_PER_LINE;
  return Math.min(Math.max(needed, RG_MIN_OUTPUT_BYTES), RG_MAX_OUTPUT_BYTES);
}

/**
 * `-H -0` 让每行固定输出 `路径\0行号<分隔符>正文`。
 *
 * 只用 `--line-number` 的话，路径里出现 `-数字-`（例如 `report-2024-01-01.md`）时，
 * 上下文行与命中行无法可靠区分；用 NUL 结束路径字段后，行号一定是剩下那段的开头。
 * 缺少 NUL 的行（旧版本 rg 或异常输出）直接跳过，而不是猜。
 */
function parseRgEntry(rawLine: string, root: string): Entry | undefined {
  const nul = rawLine.indexOf("\0");
  if (nul === -1) return undefined;
  const rawPath = rawLine.slice(0, nul);
  const rest = rawLine.slice(nul + 1);
  const parsed = /^(\d+)([:-])(.*)$/u.exec(rest);
  if (!parsed) return undefined;
  const [, lineNumber, separator, text] = parsed;
  const absolute = path.isAbsolute(rawPath) ? rawPath : path.join(root, rawPath);
  return {
    kind: separator === ":" ? "match" : "context",
    path: toPosixPath(path.relative(root, absolute)),
    line: Number(lineNumber),
    text: text ?? "",
  };
}

function* rgEntries(stdout: string, root: string): IterableIterator<Entry> {
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine || rawLine === BLOCK_SEPARATOR) continue;
    const entry = parseRgEntry(rawLine, root);
    if (entry) yield entry;
  }
}

function runRipgrep(request: SearchRequest, command: string): Promise<RenderedResult> {
  const args = [
    "--line-number",
    "--color=never",
    "--hidden",
    "--with-filename",
    "--null",
    // 不传 `--max-count`：那是**每个文件**的上限，与「最多返回 limit 条」不是一回事。
    // 真正的总量上限由 maxStdoutLines 在收集到足够多行时终止进程来实现。
    ...DEFAULT_IGNORES.flatMap((item) => ["--glob", `!${item}`]),
  ];
  if (request.ignoreCase) args.push("--ignore-case");
  if (request.context > 0) args.push("--context", String(request.context));
  if (request.literal) args.push("--fixed-strings");
  if (request.glob) args.push("--glob", request.glob);
  args.push("--", request.query, request.searchPath);

  const lineBudget = stdoutLineBudget(request.limit, request.context);
  return runProcess(command, args, {
    cwd: request.root,
    signal: request.signal,
    timeoutMs: RG_TIMEOUT_MS,
    maxOutputBytes: rgOutputBudgetBytes(lineBudget),
    maxStdoutLines: lineBudget,
  }).then(async (result) => {
    // 达到行数上限时是我们主动 SIGTERM 的，exitCode 为 null，属于正常结束。
    if (result.exitCode !== 0 && result.exitCode !== 1 && !result.stdoutLineLimitReached) {
      throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`);
    }
    const rendered = await renderEntries(rgEntries(result.stdout, request.root), request.context, request.limit);
    if (result.truncated) {
      rendered.linesTruncated = true;
    }
    return rendered;
  });
}

/* --------------------------------------------------------- 内置兜底搜索后端 */

/** 把 `--glob` 风格的 basename 模式换算成 fast-glob 需要的「任意层级」模式。 */
function toFastGlobPattern(glob: string | undefined): string {
  if (!glob) return "**/*";
  return glob.includes("/") ? glob : `**/${glob}`;
}

async function* listFallbackFiles(request: SearchRequest): AsyncGenerator<string> {
  const stat = await fs.stat(request.searchPath);
  if (stat.isFile()) {
    yield toPosixPath(path.relative(request.root, request.searchPath));
    return;
  }
  const scope = toPosixPath(path.relative(request.root, request.searchPath));
  const prefix = scope === "" || scope === "." ? "" : `${scope}/`;
  const matches = await fg(`${prefix}${toFastGlobPattern(request.glob)}`, {
    cwd: request.root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: DEFAULT_IGNORES,
    unique: true,
  });
  matches.sort();
  for (const relative of matches) yield relative;
}

interface BuiltinStats {
  scannedFiles: number;
  scannedBytes: number;
  scanLimitReached: boolean;
}

function matchesQuery(line: string, request: SearchRequest, pattern: RegExp | undefined): boolean {
  if (request.literal) {
    return request.ignoreCase
      ? line.toLowerCase().includes(request.query.toLowerCase())
      : line.includes(request.query);
  }
  return pattern?.test(line) ?? false;
}

/** 逐文件产出命中与其上下文；读取量由扫描上限兜住。 */
async function* builtinEntries(request: SearchRequest, stats: BuiltinStats): AsyncGenerator<Entry> {
  const pattern = request.literal ? undefined : compileQuery(request.query, request.ignoreCase);

  for await (const relative of listFallbackFiles(request)) {
    if (request.signal?.aborted) break;
    if (stats.scannedFiles >= BUILTIN_MAX_FILES || stats.scannedBytes >= BUILTIN_MAX_TOTAL_BYTES) {
      stats.scanLimitReached = true;
      break;
    }
    const absolute = path.join(request.root, relative);
    let size: number;
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    if (size > BUILTIN_MAX_FILE_BYTES) continue;
    let content: string;
    try {
      content = await fs.readFile(absolute, "utf8");
    } catch {
      continue;
    }
    // 含 NUL 视为二进制；rg 默认也会跳过这类文件。
    if (content.includes("\0")) continue;
    stats.scannedFiles += 1;
    stats.scannedBytes += size;

    const fileLines = content.split(/\r?\n/);
    const matchLines = new Set<number>();
    for (let index = 0; index < fileLines.length; index += 1) {
      if (matchesQuery(fileLines[index] ?? "", request, pattern)) matchLines.add(index + 1);
    }
    if (matchLines.size === 0) continue;

    let emitted = 0;
    for (const lineNumber of [...matchLines].sort((left, right) => left - right)) {
      const start = Math.max(1, lineNumber - request.context);
      const end = Math.min(fileLines.length, lineNumber + request.context);
      for (let current = start; current <= end; current += 1) {
        if (current <= emitted) continue;
        yield {
          kind: matchLines.has(current) ? "match" : "context",
          path: relative,
          line: current,
          text: fileLines[current - 1] ?? "",
        };
        emitted = current;
      }
    }
  }
}

async function runBuiltin(request: SearchRequest): Promise<RenderedResult & { stats: BuiltinStats }> {
  const stats: BuiltinStats = { scannedFiles: 0, scannedBytes: 0, scanLimitReached: false };
  const rendered = await renderEntries(builtinEntries(request, stats), request.context, request.limit);
  return { ...rendered, stats };
}

/* ------------------------------------------------------------------ 入口 */

/**
 * 执行一次搜索：选后端、渲染结果、给出可操作的说明。
 *
 * 两个后端都会多取一条命中再截断，因此 `truncated` 表示「确实还有更多」，
 * 而不是「正好取满」——后者会让提示误导模型去调大 limit。
 */
export async function searchWorkspace(
  request: SearchRequest,
  deps: SearchDeps = {},
): Promise<SearchOutcome> {
  const probe = (deps.probeRipgrep ?? probeRipgrep)();
  const notes: string[] = [];
  if (probe.invalidOverride) {
    notes.push(
      `TACODE_RG_PATH points at "${probe.invalidOverride}", which is not an executable file; used the built-in search instead.`,
    );
  }

  let engine: SearchOutcome["engine"] = probe.command ? "ripgrep" : "builtin";
  let rendered: RenderedResult;
  if (probe.command) {
    rendered = await runRipgrep(request, probe.command);
  } else {
    const builtin = await runBuiltin(request);
    rendered = builtin;
    engine = "builtin";
    notes.push(
      "ripgrep (rg) was not found; used TACode's built-in JavaScript search (slower, and it does not apply .gitignore rules). Install ripgrep or set TACODE_RG_PATH to use the fast path.",
    );
    if (builtin.stats.scanLimitReached) {
      notes.push(
        `Stopped after scanning ${builtin.stats.scannedFiles} files (${Math.round(builtin.stats.scannedBytes / 1_000_000)}MB); narrow path or glob to search the rest.`,
      );
    }
  }

  if (rendered.matchLimitReached) notes.push(matchLimitNote(request.limit));
  if (rendered.lineLimitReached) notes.push(lineLimitNote());
  if (rendered.linesTruncated) notes.push(clippedLinesNote());

  return {
    lines: rendered.lines,
    matches: rendered.matches,
    engine,
    truncated: rendered.matchLimitReached || rendered.lineLimitReached || rendered.linesTruncated,
    notes,
  };
}

/** 工具层需要的 glob 越界校验（`list_files` 与内置搜索共用）。 */
export function assertSafeGlob(pattern: string): void {
  const normalized = pattern.replaceAll("\\", "/");
  if (
    path.isAbsolute(pattern) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(`Glob escapes workspace: ${pattern}`);
  }
}
