import fs from "node:fs/promises";
import os, { devNull } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitComparison, GitMutationAction, GitMutationTarget } from "../../shared/git";
import { GitMutationService } from "./git-mutations";
import { GitReader } from "./git-reader";
import { GitProcess } from "./git-process";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(initial = true) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tacode-git-mutations-")));
  const root = path.join(directory, "repository"); await fs.mkdir(root);
  const process = new GitProcess();
  const git = (...args: string[]) => process.run(root, ["-c", "commit.gpgsign=false", "-c", `core.hooksPath=${devNull}`, ...args]);
  await git("init", "-qb", "main"); await git("config", "user.name", "TACode test"); await git("config", "user.email", "test@example.invalid");
  const write = async (file: string, contents: string | Buffer) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), contents); };
  const base = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  if (initial) { await write("source.txt", base); await write("other.txt", "other\n"); await git("add", "--all"); await git("commit", "-qm", "initial"); }
  const service = new GitMutationService({ recoveryRoot: path.join(directory, "recovery"), resolveProject: async (candidate) => {
    const resolved = await fs.realpath(candidate);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("Project not open");
    return resolved;
  } });
  cleanups.push(async () => { service.close(); await service.idle(); await fs.rm(directory, { recursive: true, force: true }); });
  const reader = new GitReader(root);
  const read = (file: string) => fs.readFile(path.join(root, file), "utf8");
  const index = async (file: string) => (await git("show", `:${file}`)).toString("utf8");
  const run = async (action: GitMutationAction, target: GitMutationTarget = { kind: "all" }, scope: GitComparison = { kind: action === "unstage" ? "staged" : "unstaged" }) => {
    const snapshot = await reader.read(scope);
    const preview = await service.prepare(1, snapshot, action, target);
    return service.apply(1, preview.token);
  };
  return { root, directory, git, write, read, index, base, reader, service, run };
}

describe("real Git mutations and recovery", () => {
  it("stages and unstages one hunk without changing the worktree or the other hunk", async () => {
    const f = await fixture();
    const changed = f.base.replace("line 3\n", "changed three\n").replace("line 63\n", "changed sixty-three\n");
    await f.write("source.txt", changed);
    const snapshot = await f.reader.read({ kind: "unstaged" }); const file = snapshot.files[0];
    expect(file.hunks).toHaveLength(2);
    const stage = await f.service.prepare(1, snapshot, "stage", { kind: "hunks", fileId: file.id, hunkIds: [file.hunks[0].id] });
    expect(await f.service.apply(1, stage.token)).toMatchObject({ kind: "applied" });
    expect(await f.index("source.txt")).toBe(f.base.replace("line 3\n", "changed three\n"));
    expect(await f.read("source.txt")).toBe(changed);
    const staged = await f.reader.read({ kind: "staged" });
    expect(await f.run("unstage", { kind: "hunks", fileId: staged.files[0].id, hunkIds: [staged.files[0].hunks[0].id] })).toMatchObject({ kind: "applied" });
    expect(await f.index("source.txt")).toBe(f.base);
    expect(await f.read("source.txt")).toBe(changed);
  }, 15000);

  it("discards one unstaged hunk against index and preserves staged and other unstaged changes", async () => {
    const f = await fixture();
    const staged = f.base.replace("line 3\n", "staged three\n");
    await f.write("source.txt", staged); await f.git("add", "source.txt");
    await f.write("source.txt", staged.replace("line 33\n", "unstaged thirty-three\n").replace("line 63\n", "unstaged sixty-three\n"));
    const snapshot = await f.reader.read({ kind: "unstaged" }); const file = snapshot.files[0];
    const preview = await f.service.prepare(1, snapshot, "discard", { kind: "hunks", fileId: file.id, hunkIds: [file.hunks[0].id] });
    expect(await f.service.apply(1, preview.token)).toMatchObject({ kind: "applied", recovery: { status: "applied" } });
    expect(await f.index("source.txt")).toBe(staged);
    expect(await f.read("source.txt")).toBe(staged.replace("line 63\n", "unstaged sixty-three\n"));
  }, 15000);

  it("reverses a staged hunk in index/worktree while preserving non-overlapping unstaged edits", async () => {
    const f = await fixture();
    const staged = f.base.replace("line 3\n", "staged three\n").replace("line 63\n", "staged sixty-three\n");
    await f.write("source.txt", staged); await f.git("add", "source.txt");
    const working = staged.replace("line 33\n", "keep unstaged thirty-three\n"); await f.write("source.txt", working);
    const snapshot = await f.reader.read({ kind: "staged" }); const file = snapshot.files[0];
    const preview = await f.service.prepare(1, snapshot, "discard", { kind: "hunks", fileId: file.id, hunkIds: [file.hunks[0].id] });
    const result = await f.service.apply(1, preview.token);
    expect(result).toMatchObject({ kind: "applied", recovery: { status: "applied" } });
    expect(await f.index("source.txt")).toBe(f.base.replace("line 63\n", "staged sixty-three\n"));
    expect(await f.read("source.txt")).toBe(working.replace("staged three\n", "line 3\n"));
    await f.write("other.txt", "unrelated staged later\n"); await f.git("add", "other.txt");
    const recovery = (await f.service.listRecoveries(f.root))[0];
    expect(await f.service.restore(f.root, recovery.id)).toMatchObject({ kind: "applied", action: "recover" });
    expect(await f.index("source.txt")).toBe(staged);
    expect(await f.read("source.txt")).toBe(working);
    expect(await f.index("other.txt")).toBe("unrelated staged later\n");
  }, 15000);

  it("rejects overlapping staged discard before changing index or worktree", async () => {
    const f = await fixture();
    await f.write("source.txt", f.base.replace("line 3\n", "staged three\n")); await f.git("add", "source.txt");
    const working = f.base.replace("line 3\n", "unstaged replacement\n"); await f.write("source.txt", working);
    const snapshot = await f.reader.read({ kind: "staged" });
    await expect(f.service.prepare(1, snapshot, "discard", { kind: "all" })).rejects.toMatchObject({ code: "patchRejected" });
    expect((await f.reader.read({ kind: "staged" })).indexVersion).toBe(snapshot.indexVersion);
    expect(await f.read("source.txt")).toBe(working);
    expect(await f.service.listRecoveries(f.root)).toEqual([]);
  });

  it("rejects staged discard when a same-hunk whitespace edit is newer", async () => {
    const f = await fixture();
    const staged = f.base.replace("line 3\n", "staged three\n");
    await f.write("source.txt", staged); await f.git("add", "source.txt");
    const whitespaceEdit = staged.replace("staged three\n", "staged  three\n"); await f.write("source.txt", whitespaceEdit);
    const snapshot = await f.reader.read({ kind: "staged" });
    await expect(f.service.prepare(1, snapshot, "discard", { kind: "all" })).rejects.toMatchObject({ code: "patchRejected" });
    expect(await f.index("source.txt")).toBe(staged);
    expect(await f.read("source.txt")).toBe(whitespaceEdit);
  });

  it("handles batch stage, file unstage, and staged discard of a binary rename", async () => {
    const f = await fixture();
    const binary = Buffer.from([0, 1, 2, 255, 6]);
    await f.write("old image.bin", binary); await f.git("add", "--all"); await f.git("commit", "-qm", "binary");
    await fs.rename(path.join(f.root, "old image.bin"), path.join(f.root, "新图片.bin"));
    await f.write("empty.txt", ""); await f.write("other.txt", "changed\n");
    expect(await f.run("stage")).toMatchObject({ kind: "applied" });
    const snapshot = await f.reader.read({ kind: "staged" });
    const renamed = snapshot.files.find((file) => file.path === "新图片.bin")!;
    expect(renamed).toMatchObject({ change: "renamed", binary: true });
    const other = snapshot.files.find((file) => file.path === "other.txt")!;
    expect(await f.run("unstage", { kind: "file", fileId: other.id })).toMatchObject({ kind: "applied" });
    expect(await f.read("other.txt")).toBe("changed\n");
    expect(await f.run("discard", { kind: "file", fileId: renamed.id }, { kind: "staged" })).toMatchObject({ kind: "applied" });
    expect(await fs.readFile(path.join(f.root, "old image.bin"))).toEqual(binary);
    await expect(fs.stat(path.join(f.root, "新图片.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.reader.read({ kind: "staged" })).files.map((file) => file.path)).toEqual(["empty.txt"]);
  }, 15000);

  it("restores missing tracked files and removes untracked files with durable recovery", async () => {
    const f = await fixture();
    await fs.unlink(path.join(f.root, "source.txt")); await f.write("新增 empty.txt", ""); await f.write("binary.bin", Buffer.from([0, 2, 3]));
    const result = await f.run("discard"); expect(result).toMatchObject({ kind: "applied" });
    expect(await f.read("source.txt")).toBe(f.base);
    const recovery = (await f.service.listRecoveries(f.root))[0];
    expect(recovery.paths).toEqual(["binary.bin", "source.txt", "新增 empty.txt"]);
    const reopened = new GitMutationService({ recoveryRoot: path.join(f.directory, "recovery"), resolveProject: async (root) => root });
    try {
      expect(await reopened.restore(f.root, recovery.id)).toMatchObject({ kind: "applied" });
      expect(await f.read("新增 empty.txt")).toBe("");
      expect(await fs.readFile(path.join(f.root, "binary.bin"))).toEqual(Buffer.from([0, 2, 3]));
      await expect(fs.stat(path.join(f.root, "source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { reopened.close(); await reopened.idle(); }
  }, 15000);

  it("rejects stale snapshots, stale confirmations and foreign operation ownership", async () => {
    const f = await fixture(); await f.write("source.txt", "before\n");
    const snapshot = await f.reader.read({ kind: "unstaged" });
    const preview = await f.service.prepare(1, snapshot, "stage", { kind: "all" });
    expect(await f.service.apply(2, preview.token)).toMatchObject({ kind: "error", error: { code: "staleSnapshot" } });
    await f.write("source.txt", "later\n");
    expect(await f.service.apply(1, preview.token)).toMatchObject({ kind: "error", error: { code: "staleSnapshot" } });
    expect(await f.index("source.txt")).toBe(f.base);
    await expect(f.service.prepare(1, snapshot, "discard", { kind: "all" })).rejects.toMatchObject({ code: "staleSnapshot" });
  });

  it("does not remove another Git process's index.lock or lose edits", async () => {
    const f = await fixture(); await f.write("source.txt", "modified\n");
    const preview = await f.service.prepare(1, await f.reader.read({ kind: "unstaged" }), "stage", { kind: "all" });
    const lock = path.join(f.root, ".git", "index.lock"); await fs.writeFile(lock, "another process");
    expect(await f.service.apply(1, preview.token)).toMatchObject({ kind: "error", error: { code: "indexLocked" } });
    expect(await fs.readFile(lock, "utf8")).toBe("another process");
    expect(await f.index("source.txt")).toBe(f.base); expect(await f.read("source.txt")).toBe("modified\n");
  });

  it("rolls back a failed file publication and preserves the durable backup", async () => {
    const f = await fixture(); await f.write("source.txt", "modified\n");
    const preview = await f.service.prepare(1, await f.reader.read({ kind: "unstaged" }), "discard", { kind: "all" });
    const nativeLink = fs.link;
    vi.spyOn(fs, "link").mockImplementationOnce(async () => { throw Object.assign(new Error("disk refused publication"), { code: "EIO" }); }).mockImplementation(nativeLink);
    const result = await f.service.apply(1, preview.token);
    expect(result).toMatchObject({ kind: "error", recovery: { status: "rolledBack" } });
    expect(await f.read("source.txt")).toBe("modified\n"); expect(await f.index("source.txt")).toBe(f.base);
    expect((await fs.readdir(f.root)).filter((name) => name.startsWith(".tacode-git-"))).toEqual([]);
  });

  it("refuses recovery after a later same-file edit and keeps both versions", async () => {
    const f = await fixture(); await f.write("source.txt", "discarded bytes\n");
    expect(await f.run("discard")).toMatchObject({ kind: "applied" });
    const recovery = (await f.service.listRecoveries(f.root))[0];
    await f.write("source.txt", "later edit\n");
    expect(await f.service.restore(f.root, recovery.id)).toMatchObject({ kind: "error", error: { code: "recoveryConflict" } });
    expect(await f.read("source.txt")).toBe("later edit\n");
    expect(await fs.readFile(path.join(f.directory, "recovery", recovery.id, "0.before"), "utf8")).toBe("discarded bytes\n");
  });

  it("supports an unborn index and literal Chinese, newline, glob and option-like paths", async () => {
    const f = await fixture(false);
    const paths = process.platform === "win32" ? ["中文 文件.txt", "--option.txt", "brackets[1].txt"] : ["中文 文件.txt", "--option.txt", "brackets[1]*.txt", "tab\tline\nfile.txt"];
    for (const file of paths) await f.write(file, `raw ${file}\n`);
    expect(await f.run("stage")).toMatchObject({ kind: "applied" });
    expect((await f.git("ls-files", "-z")).toString().split("\0").filter(Boolean).sort()).toEqual([...paths].sort());
    expect(await f.run("unstage")).toMatchObject({ kind: "applied" });
    expect(await f.git("ls-files", "-z")).toHaveLength(0);
    for (const file of paths) expect(await f.read(file)).toBe(`raw ${file}\n`);
  }, 15000);

  it("preserves BOM/CRLF through stage, discard and recovery", async () => {
    const f = await fixture();
    await f.write(".gitattributes", "windows.txt text eol=crlf\n");
    const initial = "\uFEFFfirst\r\nsecond\r\n"; await f.write("windows.txt", initial);
    await f.git("add", "--all"); await f.git("commit", "-qm", "windows file");
    const modified = "\uFEFFfirst\r\nchanged\r\n"; await f.write("windows.txt", modified);
    expect(await f.run("stage")).toMatchObject({ kind: "applied" });
    expect(await f.index("windows.txt")).toBe("\uFEFFfirst\nchanged\n");
    await f.write("windows.txt", modified + "extra\r\n");
    expect(await f.run("discard")).toMatchObject({ kind: "applied" });
    expect(await f.read("windows.txt")).toBe(modified);
    const recovery = (await f.service.listRecoveries(f.root))[0];
    expect(await f.service.restore(f.root, recovery.id)).toMatchObject({ kind: "applied" });
    expect(await f.read("windows.txt")).toBe(modified + "extra\r\n");
  }, 15000);

  it("keeps a renamed file's rename and mode when unstaging only its text hunk", async () => {
    const f = await fixture();
    await fs.rename(path.join(f.root, "source.txt"), path.join(f.root, "renamed.txt"));
    await f.write("renamed.txt", f.base.replace("line 3\n", "changed three\n"));
    if (process.platform !== "win32") await fs.chmod(path.join(f.root, "renamed.txt"), 0o755);
    await f.git("add", "--all");
    const snapshot = await f.reader.read({ kind: "staged" }); const file = snapshot.files[0]; expect(file.change).toBe("renamed");
    expect(await f.run("unstage", { kind: "hunks", fileId: file.id, hunkIds: [file.hunks[0].id] })).toMatchObject({ kind: "applied" });
    expect(await f.index("renamed.txt")).toBe(f.base);
    expect((await f.reader.read({ kind: "staged" })).files[0].change).toBe("renamed");
    expect(await f.read("renamed.txt")).toBe(f.base.replace("line 3\n", "changed three\n"));
  }, 15000);

  it("limits whole-batch operations to the selected subproject and handles split indexes", async () => {
    const f = await fixture(); await f.write("sub/file.txt", "base\n"); await f.git("add", "--all"); await f.git("commit", "-qm", "subproject");
    await f.git("update-index", "--split-index");
    await f.write("sub/file.txt", "sub change\n"); await f.write("other.txt", "outside selection\n");
    const snapshot = await new GitReader(path.join(f.root, "sub")).read({ kind: "unstaged" });
    const preview = await f.service.prepare(1, snapshot, "stage", { kind: "all" });
    expect(await f.service.apply(1, preview.token)).toMatchObject({ kind: "applied" });
    expect(await f.index("sub/file.txt")).toBe("sub change\n"); expect(await f.index("other.txt")).toBe("other\n");
    expect(await f.read("other.txt")).toBe("outside selection\n");
  }, 15000);

  it("handles symlink targets without following them and rejects escaping parent links", async () => {
    if (process.platform === "win32") return;
    const f = await fixture(); const outside = path.join(f.directory, "outside.txt"); await fs.writeFile(outside, "outside\n");
    await fs.symlink(outside, path.join(f.root, "link")); expect(await f.run("stage")).toMatchObject({ kind: "applied" });
    await f.git("commit", "-qm", "link"); await fs.unlink(path.join(f.root, "link")); await fs.symlink("other.txt", path.join(f.root, "link"));
    expect(await f.run("discard")).toMatchObject({ kind: "applied" });
    expect(await fs.readlink(path.join(f.root, "link"))).toBe(outside); expect(await fs.readFile(outside, "utf8")).toBe("outside\n");
    await f.write("sub/file.txt", "base\n"); await f.git("add", "--all"); await f.git("commit", "-qm", "directory");
    await fs.rm(path.join(f.root, "sub"), { recursive: true }); await fs.symlink(f.directory, path.join(f.root, "sub"));
    await expect(f.reader.read({ kind: "unstaged" })).rejects.toMatchObject({ code: "outsideProject" });
  }, 15000);

  it("rejects conflicting index entries and historical or cancelled operations", async () => {
    const f = await fixture();
    await f.git("checkout", "-qb", "other"); await f.write("source.txt", "other\n"); await f.git("commit", "-qam", "other");
    await f.git("checkout", "main"); await f.write("source.txt", "main\n"); await f.git("commit", "-qam", "main");
    await expect(f.git("merge", "other")).rejects.toThrow();
    const conflict = await f.reader.read({ kind: "unstaged" });
    await expect(f.service.prepare(1, conflict, "stage", { kind: "all" })).rejects.toMatchObject({ code: "unsupportedChange" });
    expect((await f.reader.read({ kind: "unstaged" })).indexVersion).toBe(conflict.indexVersion);
    const history = await f.reader.read({ kind: "commit", commit: "HEAD" });
    await expect(f.service.prepare(1, history, "discard", { kind: "all" })).rejects.toMatchObject({ code: "invalidRequest" });
    await f.git("merge", "--abort"); await f.write("source.txt", "later change\n");
    const preview = await f.service.prepare(1, await f.reader.read({ kind: "unstaged" }), "stage", { kind: "all" });
    f.service.releaseOwner(1);
    expect(await f.service.apply(1, preview.token)).toMatchObject({ kind: "error", error: { code: "staleSnapshot" } });
  }, 15000);

  it("applies a staged CRLF hunk without changing other raw line endings", async () => {
    const f = await fixture();
    await f.write(".gitattributes", "source.txt text eol=crlf\n"); await f.write("source.txt", f.base.replaceAll("\n", "\r\n"));
    await f.git("add", "--all"); await f.git("commit", "-qm", "attributes");
    const staged = f.base.replace("line 3\n", "staged three\n").replaceAll("\n", "\r\n");
    await f.write("source.txt", staged); await f.git("add", "source.txt");
    const extra = staged.replace("line 63\r\n", "keep sixty-three\r\n"); await f.write("source.txt", extra);
    const snapshot = await f.reader.read({ kind: "staged" }); const file = snapshot.files[0];
    const preview = await f.service.prepare(1, snapshot, "discard", { kind: "hunks", fileId: file.id, hunkIds: [file.hunks[0].id] });
    expect(await f.service.apply(1, preview.token)).toMatchObject({ kind: "applied" });
    expect(await f.read("source.txt")).toBe(extra.replace("staged three\r\n", "line 3\r\n"));
    expect(await f.index("source.txt")).toBe(f.base);
  }, 30000);

  it("stages an oversized binary without truncation and restores its raw bytes", async () => {
    const f = await fixture(); const bytes = Buffer.alloc(8 * 1024 * 1024 + 7, 0);
    bytes[bytes.length - 1] = 255; await f.write("large.bin", bytes);
    expect(await f.run("stage")).toMatchObject({ kind: "applied" });
    expect(await f.git("show", ":large.bin")).toEqual(bytes);
    const changed = Buffer.from(bytes); changed[0] = 17; await f.write("large.bin", changed);
    expect(await f.run("discard")).toMatchObject({ kind: "applied" });
    expect(await fs.readFile(path.join(f.root, "large.bin"))).toEqual(bytes);
    const record = (await f.service.listRecoveries(f.root))[0];
    expect(await f.service.restore(f.root, record.id)).toMatchObject({ kind: "applied" });
    expect(await fs.readFile(path.join(f.root, "large.bin"))).toEqual(changed);
  }, 120000);

  it("serializes simultaneous operations and rejects the second stale mutation", async () => {
    const f = await fixture(); await f.write("source.txt", "changed\n");
    const snapshot = await f.reader.read({ kind: "unstaged" });
    const stage = await f.service.prepare(1, snapshot, "stage", { kind: "all" });
    const discard = await f.service.prepare(2, snapshot, "discard", { kind: "all" });
    const outcomes = await Promise.all([f.service.apply(1, stage.token), f.service.apply(2, discard.token)]);
    expect(outcomes[0]).toMatchObject({ kind: "applied" }); expect(outcomes[1]).toMatchObject({ kind: "error", error: { code: "staleSnapshot" } });
    expect(await f.index("source.txt")).toBe("changed\n"); expect(await f.read("source.txt")).toBe("changed\n");
  });

  it("rechecks an explicitly opened symlink project through its original authorization binding", async () => {
    if (process.platform === "win32") return;
    const f = await fixture(); const alias = path.join(f.directory, "opened-alias"); await fs.symlink(f.root, alias);
    await f.write("source.txt", "changed through alias\n");
    const service = new GitMutationService({ recoveryRoot: path.join(f.directory, "alias-recovery"), resolveProject: async (root) => {
      if (root !== alias) throw new Error("Only the explicitly opened alias is authorized"); return root;
    } });
    try {
      const snapshot = await new GitReader(alias).read({ kind: "unstaged" });
      const preview = await service.prepare(1, snapshot, "discard", { kind: "all" }, alias);
      expect(await service.apply(1, preview.token)).toMatchObject({ kind: "applied" });
      const recovery = (await service.listRecoveries(alias))[0];
      expect(await service.restore(alias, recovery.id)).toMatchObject({ kind: "applied" });
      expect(await f.read("source.txt")).toBe("changed through alias\n");
    } finally { service.close(); await service.idle(); }
  }, 15000);

  it("recovers an interrupted multi-file discard with a mixture of original and replaced files", async () => {
    const f = await fixture(); await f.write("source.txt", "source before\n"); await f.write("other.txt", "other before\n");
    expect(await f.run("discard")).toMatchObject({ kind: "applied" });
    const record = (await f.service.listRecoveries(f.root))[0];
    const manifest = path.join(f.directory, "recovery", record.id, "manifest.json");
    const saved = JSON.parse(await fs.readFile(manifest, "utf8")); saved.status = "prepared"; await fs.writeFile(manifest, JSON.stringify(saved));
    await f.write("source.txt", "source before\n");
    expect(await f.service.restore(f.root, record.id)).toMatchObject({ kind: "applied" });
    expect(await f.read("source.txt")).toBe("source before\n"); expect(await f.read("other.txt")).toBe("other before\n");
  });
});
