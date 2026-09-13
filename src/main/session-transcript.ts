/**
 * 只读读取某个会话（含子代理子会话）的转录。
 *
 * 子代理子会话文件在 `~/.tacode/sessions/<delegationId>.jsonl`（见
 * `runtime/home.ts` 的 `getTacodeSessionsDir`），**不在项目工作区内**——因此
 * `workspace:read` 的 `resolveInWorkspace` 读不到它，需要这条专用通道。
 * 只允许读会话目录里的 `.jsonl`，不接受任意路径。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { isPathInsideRoot } from "./workspace-path";

/** 单次读取的字节上限：超出只读尾部（转录尾部更有用）。 */
export const SESSION_TRANSCRIPT_MAX_BYTES = 4 * 1024 * 1024;
/** 单次返回的消息条数上限：超出只保留最后 N 条并标记截断。 */
export const SESSION_TRANSCRIPT_MAX_MESSAGES = 2_000;

export interface SessionTranscript {
  sessionPath: string;
  /** 会话 JSONL 里 `type: "message"` 条目的 message（与 `agent:start` 的 snapshot 同一形状）。 */
  messages: unknown[];
  /** 文件里消息条目总数（截断前）。 */
  totalMessages: number;
  truncated: boolean;
}

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
): Promise<SessionTranscript> {
  const sessionPath = assertReadableSessionPath(sessionsDir, requested);
  // 子会话文件由运行时懒创建：委派一注册路径就有了，首轮写入前面板就会来轮询。
  // 文件还没落盘不算错误，返回空转录等下一轮即可，避免面板闪一条 ENOENT 报错。
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(sessionPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return emptyTranscript(sessionPath);
    throw cause;
  }
  if (!stat.isFile()) throw new Error("会话路径不是文件。");
  const oversized = stat.size > SESSION_TRANSCRIPT_MAX_BYTES;
  let text: string;
  if (oversized) {
    const handle = await fsp.open(sessionPath, "r");
    try {
      const buffer = Buffer.alloc(SESSION_TRANSCRIPT_MAX_BYTES);
      await handle.read(buffer, 0, buffer.length, stat.size - buffer.length);
      const tail = buffer.toString("utf8");
      // 起点可能落在某行中间：丢掉第一段残行。
      const firstBreak = tail.indexOf("\n");
      text = firstBreak >= 0 ? tail.slice(firstBreak + 1) : "";
    } finally {
      await handle.close();
    }
  } else {
    text = await fsp.readFile(sessionPath, "utf8");
  }
  const parsed = parseSessionTranscript(text);
  return {
    sessionPath,
    messages: parsed.messages,
    totalMessages: parsed.totalMessages,
    truncated: parsed.truncated || oversized,
  };
}
