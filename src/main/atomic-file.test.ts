import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupCorruptFile,
  consumeConfigNotices,
  noteConfigRecovered,
  protectedMessageFileName,
  readJsonFile,
  writeFileAtomic,
  writeJsonAtomic,
} from "./atomic-file";

let dir: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tether-atomic-"));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const listTemp = async (): Promise<string[]> =>
  (await fsp.readdir(dir)).filter((name) => name.endsWith(".tmp"));

describe("writeFileAtomic", () => {
  it("writes the file and leaves no temp artifacts", async () => {
    const file = path.join(dir, "settings.json");
    await writeFileAtomic(file, "hello", { fsync: false });
    expect(await fsp.readFile(file, "utf8")).toBe("hello");
    expect(await listTemp()).toEqual([]);
  });

  it("creates missing parent directories", async () => {
    const file = path.join(dir, "nested", "deep", "mcp.json");
    await writeFileAtomic(file, "{}", { fsync: false });
    expect(await fsp.readFile(file, "utf8")).toBe("{}");
  });

  it("serializes concurrent writes so the last one wins with complete content", async () => {
    const file = path.join(dir, "loaded-sessions.json");
    const payloads = Array.from({ length: 12 }, (_, index) =>
      JSON.stringify({ index, body: "x".repeat(50_000) }),
    );
    await Promise.all(payloads.map((body) => writeFileAtomic(file, body, { fsync: false })));
    const raw = await fsp.readFile(file, "utf8");
    expect(raw).toBe(payloads.at(-1));
    expect(JSON.parse(raw)).toEqual({ index: 11, body: "x".repeat(50_000) });
    expect(await listTemp()).toEqual([]);
  });

  it("applies the requested mode", async () => {
    const file = path.join(dir, "secret.json");
    await writeFileAtomic(file, "{}", { mode: 0o600, fsync: false });
    if (process.platform !== "win32") {
      const stat = await fsp.stat(file);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the previous file intact when the write fails", async () => {
    const file = path.join(dir, "recent-workspaces.json");
    await writeFileAtomic(file, "original", { fsync: false });
    // A directory in place of the temp target forces the open to fail.
    const bad = path.join(dir, "target-dir");
    await fsp.mkdir(bad);
    await expect(writeFileAtomic(bad, "nope", { fsync: false })).rejects.toBeTruthy();
    expect(await fsp.readFile(file, "utf8")).toBe("original");
    expect(await listTemp()).toEqual([]);
  });
});

describe("writeJsonAtomic", () => {
  it("round-trips through readJsonFile", async () => {
    const file = path.join(dir, "chat-profiles.json");
    await writeJsonAtomic(file, { profiles: [{ id: "a" }], activeProfileId: "a" });
    const result = await readJsonFile<{ profiles: Array<{ id: string }>; activeProfileId: string }>(
      file,
      () => ({ profiles: [], activeProfileId: "" }),
    );
    expect(result.status).toBe("ok");
    expect(result.value.activeProfileId).toBe("a");
  });
});

describe("readJsonFile", () => {
  it("reports missing files without creating them", async () => {
    const file = path.join(dir, "absent.json");
    const result = await readJsonFile(file, () => ({ safe: true }));
    expect(result.status).toBe("missing");
    expect(result.value).toEqual({ safe: true });
    await expect(fsp.access(file)).rejects.toBeTruthy();
  });

  it("backs up corrupt JSON and returns the fallback", async () => {
    const file = path.join(dir, "vision-config.json");
    await fsp.writeFile(file, '{"apiKey": "sk-1", "profil');
    const result = await readJsonFile(file, () => ({ safe: true }));
    expect(result.status).toBe("recovered");
    expect(result.value).toEqual({ safe: true });
    expect(result.backupPath).toMatch(/vision-config\.json\..+\.corrupt$/);
    expect(await fsp.readFile(result.backupPath!, "utf8")).toBe('{"apiKey": "sk-1", "profil');
    // The corrupt original is moved aside so the next atomic write starts clean.
    await expect(fsp.access(file)).rejects.toBeTruthy();
  });

  it("treats an empty file as a truncated write", async () => {
    const file = path.join(dir, "settings.json");
    await fsp.writeFile(file, "");
    const result = await readJsonFile(file, () => ({}));
    expect(result.status).toBe("recovered");
    expect(result.error).toBe("file is empty");
  });

  it("rejects JSON with an unexpected shape via normalize", async () => {
    const file = path.join(dir, "mcp.json");
    await fsp.writeFile(file, '"not an object"');
    const result = await readJsonFile(file, () => ({ mcpServers: {} }), (raw) =>
      raw && typeof raw === "object" ? (raw as { mcpServers: object }) : undefined,
    );
    expect(result.status).toBe("recovered");
    expect(result.value).toEqual({ mcpServers: {} });
    expect(result.backupPath).toBeTruthy();
  });

  it("accepts valid content through normalize", async () => {
    const file = path.join(dir, "web-search.json");
    await fsp.writeFile(file, '{"provider":"tavily"}');
    const result = await readJsonFile<{ provider: string }>(
      file,
      () => ({} as { provider: string }),
      (raw) => (raw && typeof raw === "object" ? (raw as { provider: string }) : undefined),
    );
    expect(result.status).toBe("ok");
    expect(result.value.provider).toBe("tavily");
  });
});

describe("backupCorruptFile", () => {
  it("uses a timestamped .corrupt suffix", async () => {
    const file = path.join(dir, "providers.json");
    await fsp.writeFile(file, "broken");
    const backup = await backupCorruptFile(file);
    expect(path.basename(backup)).toMatch(/^providers\.json\..+\.corrupt$/);
    expect(await fsp.readFile(backup, "utf8")).toBe("broken");
  });
});

describe("config recovery notices", () => {
  it("queues a notice for recovered files and clears on consume", async () => {
    consumeConfigNotices();
    const file = path.join(dir, "settings.json");
    await fsp.writeFile(file, "{oops");
    const result = await readJsonFile(file, () => ({}));
    noteConfigRecovered("settings.json", result);
    const notices = consumeConfigNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("settings.json");
    expect(notices[0]).toContain(".corrupt");
    expect(consumeConfigNotices()).toEqual([]);
  });

  it("ignores healthy reads", async () => {
    consumeConfigNotices();
    const file = path.join(dir, "settings.json");
    await fsp.writeFile(file, "{}");
    noteConfigRecovered("settings.json", await readJsonFile(file, () => ({})));
    expect(consumeConfigNotices()).toEqual([]);
  });
});

describe("protectedMessageFileName", () => {
  it("is stable and filesystem-safe", () => {
    const name = protectedMessageFileName("/Users/a/.tether/sessions/abc 123.jsonl");
    expect(name).toBe(protectedMessageFileName("/Users/a/.tether/sessions/abc 123.jsonl"));
    expect(name).toMatch(/^[A-Za-z0-9._-]+\.jsonl$/);
  });

  it("does not collide across different session paths", () => {
    const first = protectedMessageFileName("/a/sessions/2026-01-01T00-00-00.jsonl");
    const second = protectedMessageFileName("/b/sessions/2026-01-01T00-00-00.jsonl");
    expect(first).not.toBe(second);
  });

  it("keeps the session basename as a readable prefix", () => {
    expect(protectedMessageFileName("/a/sessions/thread-42.jsonl")).toMatch(/^thread-42-/);
  });
});
