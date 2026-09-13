/**
 * 只读读取某个会话（含子代理子会话）的转录。
 *
 * 子代理子会话文件在 `~/.tacode/sessions/<delegationId>.jsonl`（见
 * `runtime/home.ts` 的 `getTacodeSessionsDir`），**不在项目工作区内**——因此
 * `workspace:read` 的 `resolveInWorkspace` 读不到它，需要这条专用通道。
 * 只允许读会话目录里的 `.jsonl`，不接受任意路径。
 */

import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isPathInsideRoot } from "./workspace-path";
import type { SessionReadOptions, SessionTranscript } from "../shared/types";
export type { SessionTranscript } from "../shared/types";

/** 每页正文预算；单条超大消息保持完整，更早内容通过游标继续读取。 */
export const SESSION_TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;
/** 每页消息条数上限；默认先返回最近的记录。 */
export const SESSION_TRANSCRIPT_MAX_MESSAGES = 2_000;

/** 校验并解析出可读的会话文件路径；越界/非 jsonl/畸形输入一律抛错。 */
export function assertReadableSessionPath(sessionsDir: string, requested: unknown): string {
  if (typeof requested !== "string" || !requested.trim()) {
    throw new Error("会话路径必须是非空字符串。");
  }
  const target = path.resolve(requested);
  if (path.extname(target).toLowerCase() !== ".jsonl") {
    throw new Error("只支持读取 .jsonl 会话文件。");
  }
  if (!isPathInsideRoot(sessionsDir, target)) {
    throw new Error("只能读取会话目录内的会话文件。");
  }
  return target;
}

const emptyTranscript = (sessionPath: string): SessionTranscript => ({
  sessionPath,
  messages: [],
  totalMessages: 0,
  truncated: false,
});

/** 逐行解析会话 JSONL，只保留 message 条目；超过 limit 时保留最后 limit 条。 */
export function parseSessionTranscript(
  text: string,
  limit = SESSION_TRANSCRIPT_MAX_MESSAGES,
): { messages: unknown[]; totalMessages: number; truncated: boolean } {
  const messages: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // 损坏行（写入中断/手工编辑）直接跳过，不影响其余转录。
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; message?: unknown };
    if (record.type !== "message" || !record.message || typeof record.message !== "object") continue;
    messages.push(record.message);
  }
  const totalMessages = messages.length;
  return totalMessages > limit
    ? { messages: messages.slice(totalMessages - limit), totalMessages, truncated: true }
    : { messages, totalMessages, truncated: false };
}

/** 读取会话转录（只读，不启动任何 worker、不改变活动会话）。 */
export async function readSessionTranscript(
  sessionsDir: string,
  requested: unknown,
  rawOptions?: unknown,
): Promise<SessionTranscript> {
  const requestedPath = assertReadableSessionPath(sessionsDir, requested);
  const options = readOptions(rawOptions);
  const fallback = options.storagePath ? assertReadableSessionPath(sessionsDir, options.storagePath) : undefined;
  let sessionPath = requestedPath;
  let handle: fsp.FileHandle;
  try {
    // realpath 校验阻止借会话目录中的符号链接读取目录外文件。
    const root = await fsp.realpath(sessionsDir);
    const open = async (file: string) => {
      const real = await fsp.realpath(file);
      if (!isPathInsideRoot(root, real)) throw new Error("只能读取会话目录内的会话文件。");
      return fsp.open(real, "r");
    };
    try { handle = await open(sessionPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !fallback) throw error;
      sessionPath = fallback;
      handle = await open(sessionPath);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT" && !options.strict) return emptyTranscript(requestedPath);
    throw cause;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("会话路径不是文件。");
    const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    let index = indexes.get(sessionPath);
    if (index?.signature !== signature) {
      index = { signature, value: buildIndex(handle, stat.size) };
      indexes.delete(sessionPath);
      indexes.set(sessionPath, index);
      while (indexes.size > 16) indexes.delete(indexes.keys().next().value!);
    }
    let indexed: TranscriptIndex;
    try { indexed = await index.value; }
    catch (error) { if (indexes.get(sessionPath) === index) indexes.delete(sessionPath); throw error; }
    const branch = indexed.messages;
    const end = options.before === undefined ? branch.length : branch.findIndex((entry) => entry.cursor === options.before);
    if (end < 0) throw new Error("会话记录已变化，请重新打开后加载历史。");
    let start = end;
    let bytes = 0;
    const limit = options.limit ?? SESSION_TRANSCRIPT_MAX_MESSAGES;
    while (start > 0 && end - start < limit) {
      const previous = branch[start - 1]!;
      // 单条大消息完整返回；4 MiB 限额只控制分页，不丢弃或剪断正文。
      if (start < end && bytes + previous.bytes > SESSION_TRANSCRIPT_MAX_BYTES) break;
      bytes += previous.bytes;
      start--;
    }
    const messages = await Promise.all(branch.slice(start, end).map(async (entry) => {
      const buffer = Buffer.alloc(entry.bytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, entry.offset);
      if (bytesRead !== buffer.length) throw new Error("会话记录已变化，请重新打开后加载历史。");
      const record = JSON.parse(buffer.toString("utf8"));
      return { ...record.message, __entryId: entry.id };
    }));
    return {
      sessionPath: requestedPath, messages, totalMessages: branch.length, truncated: start > 0,
      ...(start > 0 ? { nextCursor: branch[start]!.cursor } : {}),
      ...(indexed.compaction ? { compaction: indexed.compaction } : {}),
    };
  } finally {
    await handle.close();
  }
}

type EntryOffset = { id: string; cursor: string; parentId?: string; offset: number; bytes: number; message: boolean; compaction?: SessionTranscript["compaction"] };
type TranscriptIndex = { messages: EntryOffset[]; compaction?: SessionTranscript["compaction"] };
// 只缓存偏移与分支关系，正文按页读取。大小按最近访问的会话数限制。
const indexes = new Map<string, { signature: string; value: Promise<TranscriptIndex> }>();

function readOptions(value: unknown): SessionReadOptions {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("读取选项无效。");
  const options = value as SessionReadOptions;
  if (options.before !== undefined && (typeof options.before !== "string" || !options.before || options.before.length > 256)) throw new Error("历史游标无效。");
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > SESSION_TRANSCRIPT_MAX_MESSAGES)) throw new Error("历史分页大小无效。");
  if (options.strict !== undefined && typeof options.strict !== "boolean") throw new Error("读取选项无效。");
  return options;
}

async function buildIndex(handle: fsp.FileHandle, size: number): Promise<TranscriptIndex> {
  const entries = new Map<string, EntryOffset>();
  let previousId: string | undefined;
  let offset = 0;
  let pending = Buffer.alloc(0);
  const consume = (line: Buffer, bytes: number) => {
    try {
      const record = JSON.parse(line.toString("utf8"));
      if (record && typeof record === "object" && typeof record.type === "string" && record.type !== "session") {
        const id = typeof record.id === "string" ? record.id : `offset-${offset}`;
        const entry: EntryOffset = {
          id, offset, bytes: line.length, cursor: `${offset}:${createHash("sha256").update(id).digest("hex").slice(0, 16)}`,
          // 老版线性转录没有 parentId；显式 null 则是真正的分支根。
          parentId: record.parentId === null ? undefined : typeof record.parentId === "string" ? record.parentId : previousId,
          message: record.type === "message" && Boolean(record.message && typeof record.message === "object"),
          ...(record.type === "compaction" && typeof record.summary === "string"
            ? { compaction: { summary: record.summary, ...(typeof record.tokensBefore === "number" ? { tokensBefore: record.tokensBefore } : {}) } } : {}),
        };
        entries.set(id, entry);
        previousId = id;
      }
    } catch { /* 保留其余完整记录；文件末尾可能正在写入。 */ }
    offset += bytes;
  };
  if (size) for await (const chunk of handle.createReadStream({ start: 0, end: size - 1, autoClose: false })) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    let end: number;
    while ((end = pending.indexOf(10, start)) >= 0) {
      consume(pending.subarray(start, end), end - start + 1);
      start = end + 1;
    }
    pending = Buffer.from(pending.subarray(start));
  }
  if (pending.length) consume(pending, pending.length);
  const branch: EntryOffset[] = [];
  const seen = new Set<string>();
  let entry = previousId ? entries.get(previousId) : undefined;
  let compaction: SessionTranscript["compaction"];
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id);
    if (entry.message) branch.push(entry);
    compaction ??= entry.compaction;
    entry = entry.parentId ? entries.get(entry.parentId) : undefined;
  }
  return { messages: branch.reverse(), ...(compaction ? { compaction } : {}) };
}
