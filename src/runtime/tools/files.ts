/**
 * 文件读写与搜索工具（Tether 时代的工具名，界面按这些名字识别工具活动）。
 *
 * 所有路径都经 `Workspace.resolve()` 校验；写入使用同目录临时文件 + rename。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import fg from "fast-glob";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { runProcess } from "./process.js";
import type { Workspace } from "./workspace.js";

const MODEL_TEXT_LIMIT = 6_000;
const DEFAULT_IGNORES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.tether/**",
];

export function clipForModel(text: string, limit = MODEL_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(-Math.floor(limit * 0.25));
  return `${head}\n\n... output truncated (${text.length - limit} chars) ...\n\n${tail}`;
}

export function createFileTools(workspace: Workspace) {
  return [readFileTool(workspace), listFilesTool(workspace), searchFilesTool(workspace), writeFileTool(workspace), editFileTool(workspace)];
}

function readFileTool(workspace: Workspace) {
  return defineTool({
    name: "read_file",
    label: "Read file",
    description:
      "Read a UTF-8 text file inside the workspace. Returns numbered lines. Use line_start and line_end for large files.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative file path" }),
      line_start: Type.Optional(Type.Integer({ minimum: 1, description: "First line, inclusive" })),
      line_end: Type.Optional(Type.Integer({ minimum: 1, description: "Last line, inclusive" })),
    }),
    async execute(_id, params) {
      const absolute = await workspace.resolve(params.path);
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) throw new Error(`Not a file: ${params.path}`);
      if (stat.size > 5_000_000) {
        throw new Error(`File is too large to read (${stat.size} bytes): ${params.path}`);
      }
      const content = await fs.readFile(absolute, "utf8");
      const lines = content.split(/\r?\n/);
      const start = Math.max(1, params.line_start ?? 1);
      const end = Math.min(lines.length, params.line_end ?? Math.min(lines.length, start + 499));
      if (end < start) throw new Error(`Invalid line range: ${start}-${end}`);
      const selected = lines
        .slice(start - 1, end)
        .map((line, index) => `${String(start + index).padStart(6)}\t${line}`)
        .join("\n");
      const suffix =
        end < lines.length ? `\n\n[${lines.length - end} more lines; continue from line ${end + 1}]` : "";
      const text = selected + suffix;
      return {
        content: [{ type: "text", text: clipForModel(text) }],
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
      "List files inside the workspace using a glob. Hidden files are included; common generated directories are excluded.",
    parameters: Type.Object({
      pattern: Type.Optional(Type.String({ description: "Glob pattern relative to workspace, default **/*" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    }),
    async execute(_id, params) {
      const limit = params.limit ?? 500;
      const pattern = params.pattern ?? "**/*";
      assertSafeGlob(pattern);
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

function searchFilesTool(workspace: Workspace) {
  return defineTool({
    name: "search_files",
    label: "Search files",
    description:
      "Search text in workspace files with ripgrep. Returns file paths, line numbers, and matching lines.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Literal text or regular expression" }),
      path: Type.Optional(Type.String({ description: "File or directory to search, default ." })),
      glob: Type.Optional(Type.String({ description: "Optional file glob, e.g. *.ts" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat query as literal text" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    }),
    async execute(_id, params, signal) {
      const searchPath = await workspace.resolve(params.path ?? ".");
      const limit = params.limit ?? 200;
      const args = [
        "--line-number",
        "--column",
        "--color=never",
        "--hidden",
        "--max-count",
        String(limit),
        ...DEFAULT_IGNORES.flatMap((item) => ["--glob", `!${item}`]),
      ];
      if (params.literal ?? false) args.push("--fixed-strings");
      if (params.glob) args.push("--glob", params.glob);
      args.push("--", params.query, searchPath);
      const result = await runProcess("rg", args, {
        cwd: workspace.root,
        signal,
        timeoutMs: 30_000,
        maxOutputBytes: 150_000,
      });
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(result.stderr || `ripgrep exited with code ${result.exitCode}`);
      }
      const output = result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(0, limit)
        .map((line) => line.replaceAll(`${workspace.root}${path.sep}`, ""))
        .join("\n");
      const text = output || "(no matches)";
      return {
        content: [{ type: "text", text: clipForModel(text) }],
        details: { truncated: result.truncated || output.split("\n").length >= limit, text },
      };
    },
  });
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

function assertSafeGlob(pattern: string): void {
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
