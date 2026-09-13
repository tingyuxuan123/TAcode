import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTacodeHome, initializeTacodeHome, maintainTacodeHome, migrateLegacyHome, partitionSessionFile } from "./home";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tacode-home-"));
  roots.push(root);
  return root;
}

/** 一次迁移场景：返回 root 下的旧目录与新目录。 */
async function renameFixture(): Promise<{ legacy: string; home: string }> {
  const root = await tempRoot();
  return { legacy: path.join(root, ".tether"), home: path.join(root, ".tacode") };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("deferred, resumable history organization", () => {
  it("loads legacy settings before the window without importing its old migration marker", async () => {
    const root = await tempRoot();
    vi.spyOn(os, "homedir").mockReturnValue(root);
    vi.stubEnv("TACODE_HOME", undefined);
    vi.stubEnv("TACODE_SESSIONS_DIR", undefined);
    const legacy = path.join(root, ".tether");
    const home = path.join(root, ".tacode");
    await fsp.mkdir(path.join(legacy, "sessions"), { recursive: true });
    await fsp.writeFile(path.join(legacy, "settings.json"), '{"theme":"paper"}');
    await fsp.writeFile(path.join(legacy, ".migrated.json"), '{"from":"older-app"}');
    await fsp.writeFile(path.join(legacy, "sessions", "a.jsonl"), JSON.stringify({ type: "session", id: "a", cwd: root, timestamp: "2026-09-13T00:00:00Z" }));
    await initializeTacodeHome({ deferHistory: true });
    expect(await fsp.readFile(path.join(home, "settings.json"), "utf8")).toBe('{"theme":"paper"}');
    expect(await fsp.readdir(path.join(home, "sessions"))).toEqual([]);
    await expect(fsp.access(path.join(home, ".migrated.json"))).rejects.toThrow();
    await maintainTacodeHome();
    expect((await fsp.stat(path.join(home, "sessions", "a.jsonl"))).isFile()).toBe(true);
    expect(JSON.parse(await fsp.readFile(path.join(home, ".migrated.json"), "utf8")).from).toBe(legacy);
  });

  async function fixture(count = 3) {
    const home = await tempRoot();
    vi.stubEnv("TACODE_HOME", home);
    vi.stubEnv("TACODE_SESSIONS_DIR", undefined);
    const sessions = path.join(home, "sessions");
    await fsp.mkdir(sessions);
    const files = Array.from({ length: count }, (_, i) => path.join(sessions, `${i}.jsonl`));
    await Promise.all(files.map((file) => fsp.writeFile(file, JSON.stringify({ type: "session", id: path.basename(file), cwd: home, timestamp: "2026-09-13T00:00:00Z" }) + "\n")));
    return { home, sessions, files };
  }

  it("prepares the app without opening any history and partitions later", async () => {
    const { home, sessions, files } = await fixture();
    const open = vi.spyOn(fsp, "open");
    expect(await initializeTacodeHome({ deferHistory: true })).toBe(home);
    expect(open).not.toHaveBeenCalled();
    expect(await fsp.readdir(sessions)).toHaveLength(3);
    await maintainTacodeHome();
    for (const file of files) {
      const storage = path.join(sessions, "2026", "09", "13", path.basename(file));
      expect((await fsp.stat(file)).ino).toBe((await fsp.stat(storage)).ino);
    }
  });

  it("resumes after interruption and discovers new transcripts on later runs", async () => {
    const { sessions, files } = await fixture();
    const controller = new AbortController();
    await expect(maintainTacodeHome({ signal: controller.signal, onSession: () => controller.abort() })).rejects.toMatchObject({ name: "AbortError" });
    for (const file of files) expect((await fsp.stat(file)).isFile()).toBe(true);
    await fsp.writeFile(path.join(sessions, "new.jsonl"), await fsp.readFile(files[0]!));
    const seen: string[] = [];
    await maintainTacodeHome({ onSession: ({ runtimePath }) => { seen.push(runtimePath); } });
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it("recovers date-partition files whose runtime link is missing", async () => {
    const { sessions, files } = await fixture(1);
    await maintainTacodeHome();
    await fsp.unlink(files[0]!);
    await maintainTacodeHome();
    expect((await fsp.stat(files[0]!)).ino).toBe((await fsp.stat(path.join(sessions, "2026", "09", "13", "0.jsonl"))).ino);
  });

  it("coalesces concurrent partitioning and skips unchanged headers, but retries deleted links", async () => {
    const { files } = await fixture(1);
    const open = vi.spyOn(fsp, "open");
    const [first, concurrent] = await Promise.all([partitionSessionFile(files[0]!), partitionSessionFile(files[0]!)]);
    expect(concurrent).toEqual(first);
    expect(open).toHaveBeenCalledTimes(1);
    await partitionSessionFile(files[0]!);
    expect(open).toHaveBeenCalledTimes(1);
    await fsp.unlink(first.storagePath);
    await partitionSessionFile(files[0]!);
    expect(open).toHaveBeenCalledTimes(2);
    expect((await fsp.stat(first.storagePath)).ino).toBe((await fsp.stat(files[0]!)).ino);
  });
});

describe("数据目录默认位置", () => {
  it("默认落到 ~/.tacode", () => {
    vi.stubEnv("TACODE_HOME", undefined);
    expect(getTacodeHome()).toBe(path.join(os.homedir(), ".tacode"));
  });

  it("TACODE_HOME 覆盖默认值", () => {
    vi.stubEnv("TACODE_HOME", "/tmp/tacode-explicit");
    expect(getTacodeHome()).toBe("/tmp/tacode-explicit");
  });
});

describe("旧数据目录一次性迁移", () => {
  it("failed copies never publish partial targets and can be retried", async () => {
    const { legacy, home } = await renameFixture();
    await fsp.mkdir(legacy);
    await fsp.writeFile(path.join(legacy, "history.jsonl"), "complete transcript\n");
    const copy = vi.spyOn(fsp, "copyFile").mockImplementationOnce(async (_source, target) => {
      await fsp.writeFile(target, "half");
      throw new Error("interrupted copy");
    });
    await expect(migrateLegacyHome(home, legacy)).rejects.toThrow("interrupted copy");
    await expect(fsp.access(path.join(home, "history.jsonl"))).rejects.toThrow();
    await expect(fsp.access(path.join(home, ".migrated.json"))).rejects.toThrow();
    copy.mockRestore();
    await expect(migrateLegacyHome(home, legacy)).resolves.toBe(true);
    expect(await fsp.readFile(path.join(home, "history.jsonl"), "utf8")).toBe("complete transcript\n");
  });

  it("首次启动整目录拷贝，并保留旧目录作为回退", async () => {
    const { legacy, home } = await renameFixture();
    await fsp.mkdir(path.join(legacy, "subagents"), { recursive: true });
    await fsp.writeFile(path.join(legacy, "subagents", "code-reviewer.md"), "name: code-reviewer\n");
    await fsp.writeFile(path.join(legacy, "settings.json"), "{}\n");

    await expect(migrateLegacyHome(home, legacy)).resolves.toBe(true);

    await expect(fsp.readFile(path.join(home, "subagents", "code-reviewer.md"), "utf8")).resolves.toBe(
      "name: code-reviewer\n",
    );
    await expect(fsp.readFile(path.join(home, "settings.json"), "utf8")).resolves.toBe("{}\n");
    // 旧目录只读：内容仍在，可以用它回退。
    await expect(fsp.readFile(path.join(legacy, "settings.json"), "utf8")).resolves.toBe("{}\n");

    const marker = JSON.parse(await fsp.readFile(path.join(home, ".migrated.json"), "utf8")) as {
      from: string;
    };
    expect(marker.from).toBe(legacy);
  });

  it("已有标记时不再重复拷贝", async () => {
    const { legacy, home } = await renameFixture();
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.writeFile(path.join(legacy, "a.md"), "a\n");
    await expect(migrateLegacyHome(home, legacy)).resolves.toBe(true);

    // 迁移后再往旧目录写东西，不应该被搬过来：改名后 TACode 只认新目录。
    await fsp.writeFile(path.join(legacy, "later.md"), "later\n");
    await expect(migrateLegacyHome(home, legacy)).resolves.toBe(false);
    await expect(fsp.access(path.join(home, "later.md"))).rejects.toThrow();
  });

  it("目标里已有的文件不被旧目录覆盖", async () => {
    const { legacy, home } = await renameFixture();
    await fsp.mkdir(path.join(home, "subagents"), { recursive: true });
    await fsp.writeFile(path.join(home, "subagents", "x.md"), "new\n");
    await fsp.mkdir(path.join(legacy, "subagents"), { recursive: true });
    await fsp.writeFile(path.join(legacy, "subagents", "x.md"), "old\n");
    await fsp.writeFile(path.join(legacy, "keep.md"), "keep\n");

    await expect(migrateLegacyHome(home, legacy)).resolves.toBe(true);

    await expect(fsp.readFile(path.join(home, "subagents", "x.md"), "utf8")).resolves.toBe("new\n");
    await expect(fsp.readFile(path.join(home, "keep.md"), "utf8")).resolves.toBe("keep\n");
  });

  it("旧目录不存在或与新目录相同则什么都不做", async () => {
    const { legacy, home } = await renameFixture();
    await expect(migrateLegacyHome(home, legacy)).resolves.toBe(false);
    await expect(fsp.access(home)).rejects.toThrow();

    await fsp.mkdir(home, { recursive: true });
    await expect(migrateLegacyHome(home, home)).resolves.toBe(false);
  });
});
