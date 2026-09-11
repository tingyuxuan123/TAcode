import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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
    // 子会话在 ~/.tether/sessions，但绝不能借这条通道读任意文件。
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
});
