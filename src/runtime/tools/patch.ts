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
  // 容忍文件开头的空行与前导空格：模型多一空行不应该只报一句 Begin Patch。
  let index = 0;
  while (index < lines.length && !lines[index]!.trim()) index += 1;
  const begin = index < lines.length ? lines[index]!.trim() : "";
  if (begin !== "*** Begin Patch") {
    const found = index < lines.length ? truncateText(lines[index]!, 120) : "(empty input)";
    throw new Error(
      `Patch must start with *** Begin Patch (found: ${found}). Re-send the patch beginning exactly with *** Begin Patch.`,
    );
  }
  index += 1;
  const actions: PatchAction[] = [];
  while (index < lines.length) {
    const line = directiveLine(lines[index]!);
    if (line === "*** End Patch") {
      if (actions.length === 0) throw new Error("Patch contains no file actions");
      return actions;
    }
    if (line.startsWith("*** Add File: ")) {
      const file = requireRelativePatchPath(line.slice("*** Add File: ".length));
      index += 1;
      const added: string[] = [];
      while (index < lines.length && !isActionHeader(lines[index])) {
        const addition = lines[index]!;
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
      if (directiveLine(lines[index] ?? "").startsWith("*** Move to: ")) {
        moveTo = requireRelativePatchPath(
          directiveLine(lines[index]!).slice("*** Move to: ".length),
        );
        index += 1;
      }
      const hunks: PatchHunk[] = [];
      while (index < lines.length && !isActionHeader(lines[index])) {
        const headerLine = lines[index]!;
        if (!headerLine.startsWith("@@")) {
          throw new Error(`Expected hunk header in ${file}, got: ${truncateText(headerLine, 120)}`);
        }
        const header = headerLine.replace(/^@@\s?/, "").replace(/\s?@@$/, "");
        index += 1;
        const hunkLines: string[] = [];
        let endOfFile = false;
        while (
          index < lines.length &&
          !lines[index]!.startsWith("@@") &&
          !isActionHeader(lines[index])
        ) {
          const rawLine = lines[index]!;
          const hunkLine = directiveLine(rawLine);
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
            throw new Error(`Invalid hunk line in ${file}: ${truncateText(rawLine, 120)}`);
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
    throw new Error(
      `Unknown patch directive at line ${index + 1}: ${truncateText(lines[index]!, 120)}`,
    );
  }
  const last = lines.at(-1)?.trim();
  throw new Error(
    `Patch is missing *** End Patch (parsed ${actions.length} file action(s); input ended after line ${lines.length}${
      last ? `, last line: ${truncateText(last, 120)}` : ""
    }). Re-send the complete patch including the final *** End Patch line.`,
  );
}

/** 指令行容错：`***` 开头的行允许前导/尾随空白，避免因此判定为未知指令。 */
function directiveLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.startsWith("***") ? trimmed : line;
}

function truncateText(value: string, limit: number): string {
  const normalized = value.replace(/\s+$/u, "");
  return normalized.length > limit ? `${normalized.slice(0, limit)}… (${normalized.length} chars)` : normalized;
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
  // 失败时把最近似位置、行号与首个差异行回给模型，而不是只报一句 context not found。
  throw new Error(describeMissingSequence(haystack, needle, cursor, header));
}

/**
 * 定位失败时的诊断：优先找「第一行完全相同但顺序/行号不符」的块，
 * 否则给出整文件里最相似的一行，并直接对比两侧文本与长度。
 */
function describeMissingSequence(
  haystack: string[],
  needle: string[],
  cursor: number,
  header: string,
): string {
  const preview = needle.slice(0, 3).map((line) => truncateText(line, 120)).join("\\n");
  const parts = [`Patch context not found${header ? ` near ${header}` : ""}: "${preview}"`];
  const first = needle[0] ?? "";
  const exact = findLineMatches(haystack, first);
  if (exact.length) {
    const target = exact.find((index) => index >= cursor) ?? exact[0]!;
    const matched = countBlockMatches(haystack, needle, target);
    parts.push(
      `lines identical to the first context line exist at line ${exact.map((index) => index + 1).join(", ")}; the block starting at line ${target + 1} matches ${matched}/${needle.length} of the hunk lines.`,
    );
    if (target < cursor) {
      parts.push(
        "That block sits before the current cursor, so an earlier hunk already consumed it: check the order of the hunks and the @@ line hint.",
      );
    }
    const mismatch = firstMismatchingLine(haystack, needle, target);
    if (mismatch) parts.push(mismatch);
  } else if (first) {
    const nearest = mostSimilarLine(haystack, first);
    if (nearest) {
      parts.push(
        `no file line equals the first context line; closest is line ${nearest.index + 1} (${Math.round(nearest.ratio * 100)}% character overlap).`,
      );
      parts.push(
        `expected (${first.length} chars): ${truncateText(first, 160)}\n  actual   (${haystack[nearest.index]!.length} chars): ${truncateText(haystack[nearest.index]!, 160)}`,
      );
    } else {
      parts.push(`the file has ${haystack.length} line(s) and none resemble the first context line.`);
    }
  }
  parts.push("Re-read the exact lines with read_file and resend only this hunk.");
  return parts.join("\n");
}

function findLineMatches(haystack: string[], line: string): number[] {
  const matches: number[] = [];
  for (let index = 0; index < haystack.length; index += 1) {
    const candidate = haystack[index]!;
    if (
      candidate === line ||
      candidate.trimEnd() === line.trimEnd() ||
      candidate.trim() === line.trim()
    ) {
      matches.push(index);
    }
  }
  return matches;
}

function countBlockMatches(haystack: string[], needle: string[], start: number): number {
  let matched = 0;
  for (let offset = 0; offset < needle.length; offset += 1) {
    const candidate = haystack[start + offset];
    if (candidate === undefined) break;
    if (candidate === needle[offset] || candidate.trim() === needle[offset]!.trim()) matched += 1;
  }
  return matched;
}

/** 首个不一致行的逐行对比（含字符数与首尾差异），用来一眼看出空白/错字。 */
function firstMismatchingLine(haystack: string[], needle: string[], start: number): string | undefined {
  for (let offset = 0; offset < needle.length; offset += 1) {
    const expected = needle[offset]!;
    const actual = haystack[start + offset];
    if (actual === undefined) {
      return `hunk line ${offset + 1} has no counterpart: the file ends at line ${start + offset}.`;
    }
    if (actual === expected) continue;
    return [
      `first difference at line ${start + offset + 1} (hunk line ${offset + 1}):`,
      `  expected (${expected.length} chars): ${truncateText(expected, 160)}`,
      `  actual   (${actual.length} chars): ${truncateText(actual, 160)}`,
    ].join("\n");
  }
  return undefined;
}

/** 字符多重集重合度：对 CJK 长行也能给出稳定的相似度，且是 O(n)。 */
export function lineSimilarity(left: string, right: string): number {
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  const counts = new Map<string, number>();
  for (const char of shorter) counts.set(char, (counts.get(char) ?? 0) + 1);
  let common = 0;
  for (const char of longer) {
    const remaining = counts.get(char) ?? 0;
    if (remaining > 0) {
      common += 1;
      counts.set(char, remaining - 1);
    }
  }
  return (2 * common) / (left.length + right.length);
}

function mostSimilarLine(haystack: string[], line: string): { index: number; ratio: number } | undefined {
  if (!line || haystack.length === 0 || haystack.length > 20_000) return undefined;
  let best: { index: number; ratio: number } | undefined;
  for (let index = 0; index < haystack.length; index += 1) {
    const ratio = lineSimilarity(haystack[index]!, line);
    if (!best || ratio > best.ratio) best = { index, ratio };
  }
  return best && best.ratio > 0.25 ? best : undefined;
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

function isActionHeader(line: string | undefined): boolean {
  const value = line?.trim() ?? "";
  return (
    value === "*** End Patch" ||
    value.startsWith("*** Add File: ") ||
    value.startsWith("*** Delete File: ") ||
    value.startsWith("*** Update File: ")
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
