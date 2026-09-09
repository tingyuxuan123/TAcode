/**
 * `apply_patch` 的补丁解析与应用。
 *
 * 支持 `*** Add File` / `*** Delete File` / `*** Update File`（含 `*** Move to`），
 * 全部路径与 hunk 先校验，再一次性落盘，避免半途失败留下不一致的工作区。
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "./workspace.js";

export interface PatchHunk {
  header: string;
  lines: string[];
  endOfFile: boolean;
}

export type PatchAction =
  | { type: "add"; path: string; lines: string[] }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; moveTo?: string; hunks: PatchHunk[] };

export interface PatchResult {
  files: string[];
  additions: number;
  deletions: number;
}

export async function applyWorkspacePatch(
  workspace: Workspace,
  input: string,
): Promise<PatchResult> {
  const actions = parsePatch(input);
  const staged = new Map<string, string | null>();
  let additions = 0;
  let deletions = 0;

  const readVirtual = async (absolute: string): Promise<string | null> => {
    if (staged.has(absolute)) return staged.get(absolute) ?? null;
    try {
      return await fs.readFile(absolute, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  };

  for (const action of actions) {
    if (action.type === "add") {
      const absolute = await workspace.resolve(action.path, true);
      if ((await readVirtual(absolute)) !== null) {
        throw new Error(`Cannot add existing file: ${action.path}`);
      }
      const content = action.lines.length > 0 ? `${action.lines.join("\n")}\n` : "";
      staged.set(absolute, content);
      additions += action.lines.length;
      continue;
    }
    const absolute = await workspace.resolve(action.path);
    const original = await readVirtual(absolute);
    if (original === null) throw new Error(`File not found: ${action.path}`);
    if (action.type === "delete") {
      staged.set(absolute, null);
      deletions += splitFile(original).lines.length;
      continue;
    }
    const updated = applyUpdate(original, action);
    for (const hunk of action.hunks) {
      additions += hunk.lines.filter((line) => line.startsWith("+")).length;
      deletions += hunk.lines.filter((line) => line.startsWith("-")).length;
    }
    if (action.moveTo) {
      const destination = await workspace.resolve(action.moveTo, true);
      if (destination !== absolute && (await readVirtual(destination)) !== null) {
        throw new Error(`Move destination already exists: ${action.moveTo}`);
      }
      staged.set(absolute, null);
      staged.set(destination, updated);
    } else {
      staged.set(absolute, updated);
    }
  }

  for (const [absolute, content] of staged) {
    if (content === null) {
      await fs.rm(absolute, { force: true });
    } else {
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await writeFileAtomic(absolute, content);
    }
  }
  return {
    files: [...staged.keys()].map((file) => workspace.relative(file)),
    additions,
    deletions,
  };
}

export function parsePatch(input: string): PatchAction[] {
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "*** Begin Patch") throw new Error("Patch must start with *** Begin Patch");
  const actions: PatchAction[] = [];
  let index = 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line === "*** End Patch") {
      if (actions.length === 0) throw new Error("Patch contains no file actions");
      return actions;
    }
    if (line.startsWith("*** Add File: ")) {
      const file = requireRelativePatchPath(line.slice("*** Add File: ".length));
      index += 1;
      const added: string[] = [];
      while (index < lines.length && !isActionHeader(lines[index])) {
        const addition = lines[index];
        if (!addition.startsWith("+")) {
          throw new Error(`Add file lines must start with +: ${addition}`);
        }
        added.push(addition.slice(1));
        index += 1;
      }
      actions.push({ type: "add", path: file, lines: added });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const file = requireRelativePatchPath(line.slice("*** Delete File: ".length));
      actions.push({ type: "delete", path: file });
      index += 1;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const file = requireRelativePatchPath(line.slice("*** Update File: ".length));
      index += 1;
      let moveTo: string | undefined;
      if (lines[index]?.startsWith("*** Move to: ")) {
        moveTo = requireRelativePatchPath(lines[index].slice("*** Move to: ".length));
        index += 1;
      }
      const hunks: PatchHunk[] = [];
      while (index < lines.length && !isActionHeader(lines[index])) {
        const headerLine = lines[index];
        if (!headerLine.startsWith("@@")) {
          throw new Error(`Expected hunk header in ${file}, got: ${headerLine}`);
        }
        const header = headerLine.replace(/^@@\s?/, "").replace(/\s?@@$/, "");
        index += 1;
        const hunkLines: string[] = [];
        let endOfFile = false;
        while (
          index < lines.length &&
          !lines[index].startsWith("@@") &&
          !isActionHeader(lines[index])
        ) {
          const hunkLine = lines[index];
          if (hunkLine === "*** End of File") {
            endOfFile = true;
            index += 1;
            break;
          }
          if (
            !hunkLine.startsWith(" ") &&
            !hunkLine.startsWith("+") &&
            !hunkLine.startsWith("-")
          ) {
            throw new Error(`Invalid hunk line in ${file}: ${hunkLine}`);
          }
          hunkLines.push(hunkLine);
          index += 1;
        }
        if (hunkLines.length === 0) throw new Error(`Empty hunk in ${file}`);
        hunks.push({ header, lines: hunkLines, endOfFile });
      }
      if (hunks.length === 0 && !moveTo) {
        throw new Error(`Update for ${file} contains no hunks`);
      }
      actions.push({ type: "update", path: file, ...(moveTo ? { moveTo } : {}), hunks });
      continue;
    }
    throw new Error(`Unknown patch directive: ${line}`);
  }
  throw new Error("Patch is missing *** End Patch");
}

function applyUpdate(
  content: string,
  action: { hunks: PatchHunk[] },
): string {
  const file = splitFile(content);
  const output = [...file.lines];
  let cursor = 0;
  for (const hunk of action.hunks) {
    const oldLines = hunk.lines.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
    const newLines = hunk.lines.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
    let matchIndex: number;
    if (oldLines.length === 0) {
      matchIndex = hunk.endOfFile ? output.length : findHeaderPosition(output, hunk.header, cursor);
    } else {
      matchIndex = findSequence(output, oldLines, cursor, hunk.header);
    }
    output.splice(matchIndex, oldLines.length, ...newLines);
    cursor = matchIndex + newLines.length;
  }
  const trailingNewline = file.trailingNewline || action.hunks.some((hunk) => hunk.endOfFile);
  return output.join("\n") + (trailingNewline && output.length > 0 ? "\n" : "");
}

function findSequence(haystack: string[], needle: string[], cursor: number, header: string): number {
  const hinted = parseLineHint(header);
  const starts = hinted === undefined ? [cursor] : [Math.max(cursor, hinted), cursor];
  for (const start of starts) {
    for (const mode of ["exact", "trimEnd", "trim"] as const) {
      for (let index = start; index <= haystack.length - needle.length; index += 1) {
        if (
          needle.every(
            (line, offset) => normalizeLine(haystack[index + offset], mode) === normalizeLine(line, mode),
          )
        ) {
          return index;
        }
      }
    }
  }
  const preview = needle.slice(0, 3).join("\\n");
  throw new Error(`Patch context not found${header ? ` near ${header}` : ""}: ${preview}`);
}

function findHeaderPosition(lines: string[], header: string, cursor: number): number {
  if (!header) return cursor;
  const hint = parseLineHint(header);
  if (hint !== undefined) return Math.max(cursor, Math.min(lines.length, hint));
  const index = lines.findIndex((line, lineIndex) => lineIndex >= cursor && line.includes(header));
  return index === -1 ? cursor : index + 1;
}

function parseLineHint(header: string): number | undefined {
  const match = /^-(\d+)/.exec(header);
  return match ? Math.max(0, Number(match[1]) - 1) : undefined;
}

function normalizeLine(value: string, mode: "exact" | "trimEnd" | "trim"): string {
  if (mode === "trim") return value.trim();
  if (mode === "trimEnd") return value.trimEnd();
  return value;
}

function splitFile(content: string): { lines: string[]; trailingNewline: boolean } {
  const normalized = content.replaceAll("\r\n", "\n");
  const trailingNewline = normalized.endsWith("\n");
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  return { lines: body ? body.split("\n") : [], trailingNewline };
}

function isActionHeader(line: string): boolean {
  return (
    line === "*** End Patch" ||
    line.startsWith("*** Add File: ") ||
    line.startsWith("*** Delete File: ") ||
    line.startsWith("*** Update File: ")
  );
}

function requireRelativePatchPath(value: string): string {
  const file = value.trim();
  if (!file || path.isAbsolute(file) || file === ".." || file.startsWith(`..${path.sep}`)) {
    throw new Error(`Patch path must be workspace-relative: ${value}`);
  }
  return file;
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
