import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureWorkspaceCheckpoint, CHECKPOINT_LIMITS, WorkspaceCheckpointCache } from "./checkpoint";
import { Workspace } from "./workspace";

let root: string;
let workspace: Workspace;
let cache: WorkspaceCheckpointCache;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "tacode-checkpoint-"));
  workspace = new Workspace(root);
  cache = new WorkspaceCheckpointCache();
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const file = (name: string) => path.join(root, name);
const done = async () => ({ running: false });

describe("workspace checkpoint coverage and cache", () => {
  it("reuses unchanged content but detects same-size writes with restored mtime and atomic replacement", async () => {
    await fs.writeFile(file("a.ts"), "aaaa");
    const original = await fs.stat(file("a.ts"));
    await captureWorkspaceCheckpoint(workspace, "warm", done, { cache });
    const result = await captureWorkspaceCheckpoint(workspace, "overwrite", async () => {
      await fs.writeFile(file("a.ts"), "bbbb");
      await fs.utimes(file("a.ts"), original.atime, original.mtime);
      return done();
    }, { cache });
    expect(result.checkpoint?.before[0]?.content).toBe("aaaa");
    expect(result.checkpoint?.after[0]?.content).toBe("bbbb");
    const replaced = await captureWorkspaceCheckpoint(workspace, "replace", async () => {
      await fs.writeFile(file("replacement"), "cccc");
      await fs.utimes(file("replacement"), original.atime, original.mtime);
      await fs.rename(file("replacement"), file("a.ts"));
      return done();
    }, { cache });
    expect(replaced.checkpoint?.before[0]?.content).toBe("bbbb");
    expect(replaced.checkpoint?.after[0]?.content).toBe("cccc");
    const unchanged = await captureWorkspaceCheckpoint(workspace, "unchanged", done, { cache });
    expect(unchanged.checkpoint).toBeUndefined();
    // 支持粗粒度时间戳的文件系统可以保守重读；精细时间戳应命中。
    const stat = await fs.stat(file("a.ts"), { bigint: true });
    if (stat.ctimeNs % 1_000_000n !== 0n) expect(unchanged.metrics.reads).toBe(0);
  });

  it("retains exact original bytes and modes for add/delete/rename and interrupted commands", async () => {
    await fs.writeFile(file("delete.txt"), "删除前");
    await fs.writeFile(file("rename.ts"), "\ufeffexport {};\n", { mode: 0o744 });
    const abort = new AbortController();
    const result = await captureWorkspaceCheckpoint(workspace, "changes", async () => {
      await fs.unlink(file("delete.txt"));
      await fs.rename(file("rename.ts"), file("new.ts"));
      await fs.writeFile(file("added.txt"), "新内容");
      abort.abort();
      return done();
    }, { cache, signal: abort.signal });
    const before = new Map(result.checkpoint!.before.map((item) => [item.path, item]));
    const after = new Map(result.checkpoint!.after.map((item) => [item.path, item]));
    expect(before.get("delete.txt")?.content).toBe("删除前");
    expect(before.get("rename.ts")?.content).toBe("\ufeffexport {};\n");
    if (process.platform !== "win32") expect(before.get("rename.ts")!.mode! & 0o777).toBe(0o744);
    expect(before.get("new.ts")?.content).toBeNull();
    expect(before.get("added.txt")?.content).toBeNull();
    expect(after.get("delete.txt")?.content).toBeNull();
    expect(after.get("rename.ts")?.content).toBeNull();
  });

  it("does not mistake unscanned or oversized files for additions/deletions at the coverage limit", async () => {
    await Promise.all(Array.from({ length: CHECKPOINT_LIMITS.files + 1 }, (_, i) => fs.writeFile(file(`f${String(i).padStart(4, "0")}.ts`), "old")));
    const captured = await captureWorkspaceCheckpoint(workspace, "limit", async () => {
      await fs.writeFile(file("f0001.ts"), "new");
      await fs.writeFile(file("a-new.ts"), "new");
      return done();
    }, { cache });
    expect(captured.checkpoint?.before.map((item) => item.path)).toEqual(["f0001.ts"]);
    expect(captured.warnings.join("\n")).toContain("2000");
    await fs.rm(root, { recursive: true });
    await fs.mkdir(root);
    await fs.writeFile(file("grow.ts"), "small");
    const grown = await captureWorkspaceCheckpoint(workspace, "grow", async () => {
      await fs.writeFile(file("grow.ts"), "x".repeat(CHECKPOINT_LIMITS.fileBytes + 1));
      return done();
    }, { cache });
    expect(grown.checkpoint).toBeUndefined();
    expect(grown.warnings.join("\n")).toContain("1 MB");
  });

  it("skips a premature after-scan for a yielded command and rejects cancellation before spawn", async () => {
    await fs.writeFile(file("a.ts"), "old");
    const result = await captureWorkspaceCheckpoint(workspace, "background", async () => {
      await fs.writeFile(file("a.ts"), "new");
      return { running: true };
    }, { cache });
    expect(result.checkpoint).toBeUndefined();
    expect(result.metrics.afterMs).toBe(0);
    expect(result.warnings.join("\n")).toContain("后台运行");
    const controller = new AbortController();
    controller.abort();
    await expect(captureWorkspaceCheckpoint(workspace, "cancelled", async () => { throw new Error("must not spawn"); }, { signal: controller.signal })).rejects.not.toThrow("must not spawn");
  });

  it("bounds saved checkpoint bytes and never marks an existing symlink as a newly-created file", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => fs.writeFile(file(`${i}.txt`), "x".repeat(450_000))));
    const captured = await captureWorkspaceCheckpoint(workspace, "large edit", async () => {
      await Promise.all(Array.from({ length: 12 }, (_, i) => fs.writeFile(file(`${i}.txt`), "y".repeat(450_000))));
      return done();
    }, { cache });
    expect(captured.checkpoint!.before.length).toBeLessThan(12);
    expect(Buffer.byteLength(JSON.stringify(captured.checkpoint))).toBeLessThan(CHECKPOINT_LIMITS.checkpointBytes);
    expect(captured.warnings.join("\n")).toContain("4 MiB");
    if (process.platform === "win32") return;
    await fs.symlink(file("0.txt"), file("link.txt"));
    const link = await captureWorkspaceCheckpoint(workspace, "replace symlink", async () => {
      await fs.unlink(file("link.txt"));
      await fs.writeFile(file("link.txt"), "new file");
      return done();
    }, { cache });
    expect(link.checkpoint).toBeUndefined();
    expect(link.warnings.join("\n")).toContain("符号链接");
  });
});
