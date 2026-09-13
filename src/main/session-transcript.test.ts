import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, appendFile, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_TRANSCRIPT_MAX_MESSAGES,
  assertReadableSessionPath,
  parseSessionTranscript,
  readSessionTranscript,
} from "./session-transcript";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tacode-transcript-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const messageLine = (role: string, text: string): string =>
  JSON.stringify({ type: "message", id: `${role}-${text}`, message: { role, content: [{ type: "text", text }] } });

describe("assertReadableSessionPath", () => {
  const sessions = "/tmp/tacode-sessions";

  it("接受会话目录内的 jsonl", () => {
    expect(assertReadableSessionPath(sessions, `${sessions}/delegation-1.jsonl`))
      .toBe(`${sessions}/delegation-1.jsonl`);
    expect(assertReadableSessionPath(sessions, join(sessions, "nested", "a.jsonl")))
      .toBe(join(sessions, "nested", "a.jsonl"));
  });

  it("拒绝越界路径、非 jsonl 与畸形输入", () => {
    // 子会话在 ~/.tacode/sessions，但绝不能借这条通道读任意文件。
    expect(() => assertReadableSessionPath(sessions, "/etc/passwd")).toThrow();
    expect(() => assertReadableSessionPath(sessions, `${sessions}/../../etc/passwd.jsonl`)).toThrow();
    expect(() => assertReadableSessionPath(sessions, `${sessions}/delegation-1.json`)).toThrow();
    expect(() => assertReadableSessionPath(sessions, "")).toThrow();
    expect(() => assertReadableSessionPath(sessions, undefined)).toThrow();
    expect(() => assertReadableSessionPath(sessions, 42)).toThrow();
  });
});

describe("parseSessionTranscript", () => {
  it("只取 message 条目，跳过头部与畸形行", () => {
    const text = [
      JSON.stringify({ type: "session", version: 3, id: "s1" }),
      messageLine("user", "hello"),
      "{ not json",
      JSON.stringify({ type: "model_change", modelId: "m" }),
      messageLine("assistant", "world"),
    ].join("\n");
    const parsed = parseSessionTranscript(text);
    expect(parsed.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
    ]);
    expect(parsed.totalMessages).toBe(2);
    expect(parsed.truncated).toBe(false);
  });

  it("超过上限时保留最后 N 条并标记截断", () => {
    const text = Array.from({ length: 5 }, (_item, index) => messageLine("assistant", `m${index}`)).join("\n");
    const parsed = parseSessionTranscript(text, 2);
    expect(parsed.totalMessages).toBe(5);
    expect(parsed.truncated).toBe(true);
    expect(parsed.messages).toHaveLength(2);
    expect((parsed.messages[1] as { content: Array<{ text: string }> }).content[0]?.text).toBe("m4");
  });

  it("默认上限是 2000 条", () => {
    expect(SESSION_TRANSCRIPT_MAX_MESSAGES).toBe(2_000);
  });
});

describe("readSessionTranscript", () => {
  it("pages beyond 4 MiB and 2000 messages without losing Unicode or repeated messages", async () => {
    const sessions = await tempDir();
    const file = join(sessions, "large.jsonl");
    const lines = Array.from({ length: 2101 }, (_, i) => messageLine("assistant", `${i} ${"历史".repeat(700)}`));
    await writeFile(file, lines.join("\n"));
    const all: unknown[] = [];
    let before: string | undefined;
    do {
      const page = await readSessionTranscript(sessions, file, { before, limit: 137 });
      expect(page.totalMessages).toBe(2101);
      all.unshift(...page.messages);
      before = page.nextCursor;
      expect(page.truncated).toBe(Boolean(before));
    } while (before);
    expect(all).toHaveLength(2101);
    expect(all.map((message) => (message as { content: { text: string }[] }).content[0]!.text))
      .toEqual(lines.map((line) => JSON.parse(line).message.content[0].text));
  });

  it("follows the active branch and retains records before compaction", async () => {
    const sessions = await tempDir();
    const file = join(sessions, "branches.jsonl");
    const message = (id: string, parentId: string | null) => ({ type: "message", id, parentId, message: { role: "user", content: id } });
    await writeFile(file, [message("root", null), message("abandoned", "root"), message("chosen", "root"),
      { type: "compaction", id: "compact", parentId: "chosen", firstKeptEntryId: "chosen", summary: "之前的摘要", tokensBefore: 1000 },
      message("latest", "compact")].map((entry) => JSON.stringify(entry)).join("\n"));
    const page = await readSessionTranscript(sessions, file, { limit: 2 });
    expect(page.messages.map((message) => (message as { content: string }).content)).toEqual(["chosen", "latest"]);
    expect(page.compaction).toEqual({ summary: "之前的摘要", tokensBefore: 1000 });
    const first = await readSessionTranscript(sessions, file, { before: page.nextCursor });
    expect(first.messages.map((message) => (message as { content: string }).content)).toEqual(["root"]);
    expect(first.truncated).toBe(false);
  });

  it("returns a message larger than a page in full", async () => {
    const sessions = await tempDir();
    const file = join(sessions, "single-large.jsonl");
    const content = "中文".repeat(800_000);
    await writeFile(file, messageLine("assistant", content));
    const page = await readSessionTranscript(sessions, file);
    expect(page.messages).toHaveLength(1);
    expect((page.messages[0] as { content: { text: string }[] }).content[0]!.text).toBe(content);
    expect(page.truncated).toBe(false);
  });

  it("resolves a missing runtime link through storage without recreating it", async () => {
    const sessions = await tempDir();
    const runtime = join(sessions, "runtime.jsonl");
    const storage = join(sessions, "stored.jsonl");
    await writeFile(storage, messageLine("user", "stored"));
    expect((await readSessionTranscript(sessions, runtime, { storagePath: storage, strict: true })).totalMessages).toBe(1);
    await expect(stat(runtime)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps cursors valid through appends and rejects a different branch cursor", async () => {
    const sessions = await tempDir();
    const file = join(sessions, "append.jsonl");
    await writeFile(file, [messageLine("user", "one"), messageLine("assistant", "two")].join("\n") + "\n");
    const page = await readSessionTranscript(sessions, file, { limit: 1 });
    await appendFile(file, messageLine("user", "three") + "\n");
    const older = await readSessionTranscript(sessions, file, { before: page.nextCursor, limit: 1 });
    expect(older.totalMessages).toBe(3);
    expect((older.messages[0] as { content: { text: string }[] }).content[0]!.text).toBe("one");
    await writeFile(file, messageLine("user", "replacement"));
    await expect(readSessionTranscript(sessions, file, { before: page.nextCursor })).rejects.toThrow(/已变化/);
  });

  it("rejects symlink escapes, invalid paging and missing known histories", async () => {
    const root = await tempDir();
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    const outside = join(root, "outside.jsonl");
    await writeFile(outside, messageLine("user", "private"));
    const link = join(sessions, "link.jsonl");
    await symlink(outside, link);
    await expect(readSessionTranscript(sessions, link)).rejects.toThrow(/会话目录/);
    await expect(readSessionTranscript(sessions, link, { limit: -1 })).rejects.toThrow(/分页/);
    await expect(readSessionTranscript(sessions, join(sessions, "missing.jsonl"), { strict: true })).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("读出会话消息且不区分会话类型", async () => {
    const home = await tempDir();
    const sessions = join(home, "sessions");
    await mkdir(sessions, { recursive: true });
    const file = join(sessions, "delegation-abc.jsonl");
    await writeFile(file, `${messageLine("user", "subagent task")}\n${messageLine("assistant", "done")}\n`);
    const transcript = await readSessionTranscript(sessions, file);
    expect(transcript.sessionPath).toBe(file);
    expect(transcript.totalMessages).toBe(2);
    expect(transcript.truncated).toBe(false);
  });

  it("拒绝读会话目录之外的文件（即使存在）", async () => {
    const home = await tempDir();
    const sessions = join(home, "sessions");
    await mkdir(sessions, { recursive: true });
    const outside = join(home, "secret.jsonl");
    await writeFile(outside, messageLine("user", "nope"));
    await expect(readSessionTranscript(sessions, outside)).rejects.toThrow();
  });

  it("文件未落盘时返回空转录而不是报错（子会话文件是懒创建的）", async () => {
    const home = await tempDir();
    const sessions = join(home, "sessions");
    await mkdir(sessions, { recursive: true });
    const missing = join(sessions, "delegation-not-yet.jsonl");
    const transcript = await readSessionTranscript(sessions, missing);
    expect(transcript.sessionPath).toBe(missing);
    expect(transcript.messages).toEqual([]);
    expect(transcript.totalMessages).toBe(0);
    expect(transcript.truncated).toBe(false);
  });
});
