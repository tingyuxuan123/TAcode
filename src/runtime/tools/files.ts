/**
 * 文件读写与搜索工具（沿用改名前的旧工具名，界面按这些名字识别工具活动）。
 *
 * 写入路径经 `Workspace.resolve()` 校验（词法 + realpath，符号链接不得越界）；
 * 读取路径走 `Workspace.resolveForRead()`，不设工作区边界（理由见 workspace.ts
 * 头注释）。写入使用同目录临时文件 + rename。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import fg from "fast-glob";
import { defineTool } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_IGNORES,
  MAX_SEARCH_CONTEXT,
  searchWorkspace,
  type SearchDeps,
  type SearchOutcome,
} from "./search.js";
import type { Workspace } from "./workspace.js";

const MODEL_TEXT_LIMIT = 6_000;
/** 搜索结果按行组织、单行较短，且已有 limit/context 两道闸门，给比 read_file 更宽的预算。 */
const SEARCH_TEXT_LIMIT = 20_000;
const DEFAULT_SEARCH_LIMIT = 200;
const MAX_SEARCH_LIMIT = 1_000;

export function clipForModel(text: string, limit = MODEL_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const lines = text.split("\n");
  const headBudget = Math.floor(limit * 0.7);
  const tailBudget = Math.floor(limit * 0.25);
  // 单行超长（压缩产物、单行 JSON）：只能按字符切，并明确说两个半段不相邻。
  if (lines.length === 1) {
    const head = text.slice(0, headBudget);
    const tail = text.slice(-tailBudget);
    return `${head}\n\n... output truncated (${text.length - head.length - tail.length} chars omitted from one long line; the two halves are not adjacent) ...\n\n${tail}`;
  }
  // 按行取头尾：不把任何一行切成半截，也报出到底丢了几行。
  const headLines: string[] = [];
  let headChars = 0;
  for (const line of lines) {
    if (headLines.length > 0 && headChars + line.length + 1 > headBudget) break;
    headLines.push(line);
    headChars += line.length + 1;
  }
  if (headLines.length >= lines.length) {
    const head = headLines.join("\n").slice(0, limit);
    return `${head}\n\n... output truncated (${text.length - head.length} chars omitted) ...`;
  }
  const tailLines: string[] = [];
  let tailChars = 0;
  for (let index = lines.length - 1; index >= headLines.length; index -= 1) {
    const line = lines[index]!;
    if (tailLines.length > 0 && tailChars + line.length + 1 > tailBudget) break;
    tailLines.unshift(line);
    tailChars += line.length + 1;
  }
  const headText = headLines.join("\n");
  const tailText = tailLines.join("\n");
  const omittedLines = lines.length - headLines.length - tailLines.length;
  const omittedChars = text.length - headText.length - tailText.length;
  return `${headText}\n\n... output truncated (${omittedLines} line(s) / ${omittedChars} chars omitted) ...\n\n${tailText}`;
}

export interface FileToolOptions {
  /** 仅测试注入：用于强制走无 rg 的内置搜索路径。 */
  search?: SearchDeps;
}

export function createFileTools(workspace: Workspace, options: FileToolOptions = {}) {
  return [
    readFileTool(workspace),
    listFilesTool(workspace),
    searchFilesTool(workspace, options.search ?? {}),
    writeFileTool(workspace),
    editFileTool(workspace),
  ];
}

function readFileTool(workspace: Workspace) {
  return defineTool({
    name: "read_file",
    label: "Read file",
    description:
      "Read a UTF-8 text file. Returns numbered lines (the number is the real file line). The returned range is always contiguous; when it stops early, the tail note names the omitted lines.",
    parameters: Type.Object({
      path: Type.String({
        description:
          "File path: workspace-relative, absolute (may point outside the workspace), or ../ relative",
      }),
      line_start: Type.Optional(Type.Integer({ minimum: 1, description: "First line, inclusive" })),
      line_end: Type.Optional(Type.Integer({ minimum: 1, description: "Last line, inclusive" })),
    }),
    async execute(_id, params) {
      const absolute = workspace.resolveForRead(params.path);
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) throw new Error(`Not a file: ${params.path}`);
      if (stat.size > 5_000_000) {
        throw new Error(`File is too large to read (${stat.size} bytes): ${params.path}`);
      }
      const content = await fs.readFile(absolute, "utf8");
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, params.line_start ?? 1);
      const requestedEnd = Math.min(lines.length, params.line_end ?? Math.min(lines.length, start + 499));
      if (requestedEnd < start) throw new Error(`Invalid line range: ${start}-${requestedEnd}`);
      // 按字符预算反推 end：一次读取永远返回**连续**区间，不制造中段空洞
      // （旧实现是「先取 500 行再首尾按字符硬切」，中间几百行会被无声去掉）。
      const rendered: string[] = [];
      let remaining = MODEL_TEXT_LIMIT;
      for (let line = start; line <= requestedEnd; line += 1) {
        const entry = `${String(line).padStart(6)}\t${lines[line - 1] ?? ""}`;
        const cost = entry.length + 1;
        if (rendered.length > 0 && cost > remaining) break;
        rendered.push(entry);
        remaining -= cost;
      }
      const end = start + rendered.length - 1;
      // 单行就超预算（压缩文件、单行 JSON）：只截断这一行，并说明两个半段不相邻。
      let body = rendered.join("\n");
      const oversizedSingleLine = rendered.length === 1 && remaining < 0;
      if (oversizedSingleLine) body = clipForModel(body, MODEL_TEXT_LIMIT);
      const truncationNote = oversizedSingleLine
        ? `\n\n[line ${start} alone exceeds the ${MODEL_TEXT_LIMIT}-char read budget]`
        : end < requestedEnd
          ? `\n\n[${requestedEnd - end} more line(s) omitted (lines ${end + 1}–${requestedEnd}); continue from line ${end + 1} with line_start]`
          : end < lines.length
            ? `\n\n[${lines.length - end} more lines; continue from line ${end + 1}]`
            : "";
      const text = body + truncationNote;
      return {
        content: [{ type: "text", text }],
        details: { path: workspace.relative(absolute), start, end, totalLines: lines.length, text },
      };
    },
  });
}

function listFilesTool(workspace: Workspace) {
  return defineTool({
    name: "list_files",
    label: "List files",
    description:
      "List files using a glob, relative to the workspace by default. Absolute and ../ patterns list directories outside the workspace. Hidden files are included; common generated directories are excluded.",
    parameters: Type.Object({
      pattern: Type.Optional(
        Type.String({
          description:
            "Glob pattern relative to workspace (default **/*); absolute or ../ patterns list outside the workspace",
        }),
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    }),
    async execute(_id, params) {
      const limit = params.limit ?? 500;
      const pattern = params.pattern ?? "**/*";
      const matches = await fg(pattern, {
        cwd: workspace.root,
        onlyFiles: true,
        dot: true,
        followSymbolicLinks: false,
        ignore: DEFAULT_IGNORES,
        unique: true,
      });
      matches.sort();
      const selected = matches.slice(0, limit);
      const suffix = matches.length > limit ? `\n[${matches.length - limit} more files omitted]` : "";
      const text = selected.join("\n") + suffix || "(no files)";
      return {
        content: [{ type: "text", text: clipForModel(text) }],
        details: { count: selected.length, total: matches.length, text },
      };
    },
  });
}

function searchFilesTool(workspace: Workspace, deps: SearchDeps) {
  return defineTool({
    name: "search_files",
    label: "Search files",
    description:
      "Search text in workspace files with ripgrep, falling back to a built-in scan when ripgrep is unavailable. " +
      "Each match is one line `path:line:text`; context lines use the ripgrep convention `path-line-text`. " +
      "`limit` caps the total number of matches across all files.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Literal text or regular expression" }),
      path: Type.Optional(
        Type.String({
          description:
            "File or directory to search, default .; may be outside the workspace (absolute or ../ relative)",
        }),
      ),
      glob: Type.Optional(Type.String({ description: "Optional file glob, e.g. *.ts" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat query as literal text" })),
      ignore_case: Type.Optional(Type.Boolean({ description: "Case-insensitive match" })),
      context: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: MAX_SEARCH_CONTEXT,
          description: "Surrounding lines to show per match, default 0",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT, description: "Maximum matches in total, default 200" }),
      ),
    }),
    async execute(_id, params, signal) {
      const searchPath = workspace.resolveForRead(params.path ?? ".");
      const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;
      const outcome = await searchWorkspace(
        {
          root: workspace.root,
          searchPath,
          query: params.query,
          literal: params.literal ?? false,
          ignoreCase: params.ignore_case ?? false,
          context: params.context ?? 0,
          ...(params.glob ? { glob: params.glob } : {}),
          limit,
          ...(signal ? { signal } : {}),
        },
        deps,
      );
      const text = formatSearchText(outcome);
      return {
        content: [{ type: "text", text: clipForModel(text, SEARCH_TEXT_LIMIT) }],
        details: {
          truncated: outcome.truncated,
          engine: outcome.engine,
          matches: outcome.matches,
          text,
        },
      };
    },
  });
}

/** 命中行在前、说明在后，中间空行分隔，模型与界面都能直接读懂。 */
function formatSearchText(outcome: SearchOutcome): string {
  const body = outcome.lines.join("\n") || "(no matches)";
  if (outcome.notes.length === 0) return body;
  return `${body}\n\n${outcome.notes.join("\n")}`;
}

function writeFileTool(workspace: Workspace) {
  return defineTool({
    name: "write_file",
    label: "Write file",
    description:
      "Create or completely overwrite a UTF-8 text file inside the workspace. Prefer edit_file for focused changes.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path" }),
      content: Type.String({ description: "Complete new file content" }),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const absolute = await workspace.resolve(params.path, true);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await writeFileAtomic(absolute, params.content);
      return {
        content: [
          { type: "text", text: `Wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}` },
        ],
        details: { path: workspace.relative(absolute), bytes: Buffer.byteLength(params.content) },
      };
    },
  });
}

function editFileTool(workspace: Workspace) {
  return defineTool({
    name: "edit_file",
    label: "Edit file",
    description:
      "Replace an exact text block in a workspace file. By default old_text must occur exactly once.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path" }),
      old_text: Type.String({ minLength: 1, description: "Exact text to replace" }),
      new_text: Type.String({ description: "Replacement text" }),
      replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence" })),
    }),
    executionMode: "sequential",
    async execute(_id, params) {
      const absolute = await workspace.resolve(params.path);
      const content = await fs.readFile(absolute, "utf8");
      const occurrences = countOccurrences(content, params.old_text);
      if (occurrences === 0) throw new Error(`old_text was not found in ${params.path}`);
      if (occurrences > 1 && !(params.replace_all ?? false)) {
        throw new Error(
          `old_text occurs ${occurrences} times in ${params.path}; provide more context or set replace_all`,
        );
      }
      const updated = params.replace_all
        ? content.split(params.old_text).join(params.new_text)
        : content.replace(params.old_text, params.new_text);
      await writeFileAtomic(absolute, updated);
      return {
        content: [
          {
            type: "text",
            text: `Updated ${params.path} (${params.replace_all ? occurrences : 1} replacement)`,
          },
        ],
        details: {
          path: workspace.relative(absolute),
          replacements: params.replace_all ? occurrences : 1,
        },
      };
    },
  });
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  for (;;) {
    const index = content.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tacode-${process.pid}-${Date.now()}.tmp`,
  );
  let mode: number | undefined;
  try {
    mode = (await fs.stat(target)).mode;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error;
}
