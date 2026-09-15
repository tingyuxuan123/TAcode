import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitReader } from "./git-reader";
import { GitProcess, GitReadError, type GitRunOptions } from "./git-process";
import { applyGitHunks, parseGitHunks } from "./git-diff";

const exec = promisify(execFile);
let directory: string;
let root: string;
let reader: GitReader;
const git = async (args: string[], cwd = root, input?: string) => {
  if (input !== undefined) return new GitProcess().run(cwd, args, { input });
  const result = await exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_DEFAULT_HASH: "sha1" } });
  return result.stdout.trimEnd();
};
const write = async (file: string, content: string | Buffer, base = root) => { await fs.mkdir(path.dirname(path.join(base, file)), { recursive: true }); await fs.writeFile(path.join(base, file), content); };
const commit = async (message = "fixture") => { await git(["add", "--all"]); await git(["commit", "-qm", message]); return String(await git(["rev-parse", "HEAD"])); };
const byPath = <T extends { files: readonly { path: string }[] }>(snapshot: T, file: string): T["files"][number] => {
  const value = snapshot.files.find((item) => item.path === file);
  expect(value, `missing ${file}`).toBeDefined();
  return value!;
};

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-git-reader-"));
  root = path.join(directory, "project");
  await fs.mkdir(root);
  await git(["init", "-qb", "main"]);
  await git(["config", "user.name", "TACode fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await git(["config", "core.autocrlf", "false"]);
  reader = new GitReader(root);
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }); });

describe("GitReader real repository comparisons", () => {
  it("keeps index/worktree and HEAD/index separate without refreshing the index", async () => {
    await write("src/example.ts", "const value = 1;\nconst stable = true;\n");
    await commit();
    await write("src/example.ts", "const value = 2;\nconst stable = true;\n");
    await git(["add", "src/example.ts"]);
    await write("src/example.ts", "const value = 3;\nconst stable = true;\n");
    const indexBefore = await fs.readFile(path.join(root, ".git/index"));
    const staged = await reader.read({ kind: "staged" });
    const unstaged = await reader.read({ kind: "unstaged" });
    expect(byPath(staged, "src/example.ts")).toMatchObject({ additions: 1, deletions: 1, old: { content: "const value = 1;\nconst stable = true;\n" }, new: { content: "const value = 2;\nconst stable = true;\n" } });
    expect(byPath(unstaged, "src/example.ts")).toMatchObject({ additions: 1, deletions: 1, old: { content: "const value = 2;\nconst stable = true;\n" }, new: { content: "const value = 3;\nconst stable = true;\n" } });
    expect(staged.readOnly).toBe(false);
    expect(unstaged.files[0].hunks).toHaveLength(1);
    expect(await fs.readFile(path.join(root, ".git/index"))).toEqual(indexBefore);
    expect((await reader.read({ kind: "unstaged" })).id).toBe(unstaged.id);
    expect(Object.isFrozen(unstaged.files[0].new)).toBe(true);
  });

  it("includes new/empty/dot files and treats pathspec metacharacters, tabs and newlines literally", async () => {
    await write(".gitignore", "ignored/\n");
    await commit();
    const special = process.platform === "win32" ? "src/中文 空格[1]file.ts" : "src/中文 空格\t[1]\nfile.ts";
    await write(special, "第一行\n没有结尾换行");
    await write("empty.txt", "");
    await write(".hidden/file.txt", "hidden\n");
    await write("ignored/not-listed.txt", "ignored\n");
    const snapshot = await reader.read({ kind: "unstaged" });
    expect(snapshot.files.map((file) => file.path).sort()).toEqual([special, "empty.txt", ".hidden/file.txt"].sort());
    expect(byPath(snapshot, special)).toMatchObject({ change: "untracked", additions: 2, old: { state: "missing" }, new: { content: "第一行\n没有结尾换行" } });
    expect(byPath(snapshot, "empty.txt")).toMatchObject({ additions: 0, new: { state: "text", size: 0, content: "" } });
    const patch = snapshot.files.map((file) => file.patch).join("");
    await git(["apply", "--cached", "--check", "-"], root, patch);
    await git(["add", "--all"]);
    const staged = await reader.read({ kind: "staged" });
    expect(byPath(staged, special)).toMatchObject({ path: special, additions: 2, new: { content: "第一行\n没有结尾换行" } });
  });

  it("reads renamed, deleted, binary and executable-mode changes", async () => {
    await write("old 中文.txt", "one\ntwo\nthree\n");
    await write("deleted.txt", "remove me\n");
    await write("binary.dat", Buffer.from([0, 1, 2, 3]));
    await write("script.sh", "#!/bin/sh\necho ok\n");
    await commit();
    await git(["mv", "old 中文.txt", "new 中文.txt"]);
    await git(["rm", "deleted.txt"]);
    await write("binary.dat", Buffer.from([0, 8, 9]));
    await fs.chmod(path.join(root, "script.sh"), 0o755);
    await git(["add", "--all"]);
    const snapshot = await reader.read({ kind: "staged" });
    expect(byPath(snapshot, "new 中文.txt")).toMatchObject({ change: "renamed", previousPath: "old 中文.txt", old: { content: "one\ntwo\nthree\n" }, new: { content: "one\ntwo\nthree\n" } });
    expect(byPath(snapshot, "deleted.txt")).toMatchObject({ change: "deleted", deletions: 1, new: { state: "missing", content: null } });
    expect(byPath(snapshot, "binary.dat")).toMatchObject({ binary: true, old: { state: "binary", size: 4 }, new: { state: "binary", size: 3 } });
    if (process.platform !== "win32") expect(byPath(snapshot, "script.sh")).toMatchObject({ old: { mode: "100644" }, new: { mode: "100755" }, additions: 0, deletions: 0 });
  });

  it("supports unborn repositories and root commits without inventing a parent", async () => {
    const empty = await reader.read({ kind: "staged" });
    expect(empty.repository.unborn).toBe(true);
    expect(empty.files).toEqual([]);
    await write("first.txt", "root\n");
    await git(["add", "first.txt"]);
    expect((await reader.read({ kind: "staged" })).additions).toBe(1);
    const first = await commit("root");
    await write("first.txt", "working file must not leak\n");
    const snapshot = await reader.read({ kind: "commit", commit: first });
    expect(snapshot.baseCommit).toBeNull();
    expect(snapshot.targetCommit).toBe(first);
    expect(snapshot.readOnly).toBe(true);
    expect(byPath(snapshot, "first.txt")).toMatchObject({ old: { state: "missing" }, new: { content: "root\n" } });
    await expect(reader.read({ kind: "commit", commit: "--output=oops" })).rejects.toMatchObject({ code: "invalidReference" });
  });

  it("compares a selected branch from merge-base to HEAD, excluding working/index edits", async () => {
    await write("base.txt", "base\n");
    const base = await commit("base");
    await git(["checkout", "-qb", "feature"]);
    await write("feature.txt", "feature\n");
    const feature = await commit("feature");
    await git(["checkout", "-q", "main"]);
    await write("main.txt", "main\n");
    await commit("main advanced");
    await git(["checkout", "-q", "feature"]);
    await write("feature.txt", "index change\n");
    await git(["add", "feature.txt"]);
    await write("loose.txt", "untracked\n");
    const snapshot = await reader.read({ kind: "branch", base: "main" });
    expect(snapshot.baseCommit).toBe(base);
    expect(snapshot.targetCommit).toBe(feature);
    expect(snapshot.files.map((file) => file.path)).toEqual(["feature.txt"]);
    expect(snapshot.files[0].new.content).toBe("feature\n");
    expect(await reader.branches()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "feature", current: true }), expect.objectContaining({ name: "main", current: false })]));
  });

  it("uses the first parent when showing a merge commit", async () => {
    await write("base.txt", "base\n");
    const base = await commit();
    await git(["checkout", "-qb", "feature"]);
    await write("side.txt", "side\n");
    await commit();
    await git(["checkout", "-q", "main"]);
    await write("main.txt", "main\n");
    const firstParent = await commit();
    await git(["merge", "--no-ff", "-m", "merge", "feature"]);
    const snapshot = await reader.read({ kind: "commit", commit: "HEAD" });
    expect(snapshot.baseCommit).toBe(firstParent);
    expect(snapshot.baseCommit).not.toBe(base);
    expect(snapshot.files.map((file) => file.path)).toEqual(["side.txt"]);
  });

  it("uses each worktree's index and gitdir while sharing the common object database", async () => {
    await write("file.txt", "main\n");
    await commit();
    const worktree = path.join(directory, "other worktree");
    await git(["worktree", "add", "-qb", "other", worktree]);
    await write("file.txt", "other index\n", worktree);
    await git(["add", "file.txt"], worktree);
    const other = await new GitReader(worktree).read({ kind: "staged" });
    expect(other.repository.gitDir).not.toBe(other.repository.commonDir);
    expect(other.repository.commonDir).toBe(path.join(await fs.realpath(root), ".git"));
    expect(other.repository.branch).toBe("other");
    expect(other.files[0].new.content).toBe("other index\n");
    expect((await reader.read({ kind: "staged" })).files).toHaveLength(0);
  });

  it("limits a project below the repository root to its own files", async () => {
    await write("packages/app/one.txt", "one\n");
    await write("packages/other/two.txt", "two\n");
    await commit();
    await write("packages/app/one.txt", "one updated\n");
    await write("packages/other/two.txt", "other updated\n");
    await write("outside.txt", "outside\n");
    const snapshot = await new GitReader(path.join(root, "packages/app")).read({ kind: "unstaged" });
    expect(snapshot.repository.pathPrefix).toBe("packages/app");
    expect(snapshot.files.map((file) => file.path)).toEqual(["one.txt"]);
    expect(snapshot.files[0].repositoryPath).toBe("packages/app/one.txt");
  });

  it("preserves BOM and no-final-newline while following Git's CRLF normalization", async () => {
    await git(["config", "core.autocrlf", "true"]);
    await write("bom.txt", "\ufefffirst\r\nsecond\r\n");
    await commit();
    await write("bom.txt", "\ufefffirst\r\nchanged");
    const snapshot = await reader.read({ kind: "unstaged" });
    expect(snapshot.files[0]).toMatchObject({ additions: 1, deletions: 1, old: { content: "\ufefffirst\nsecond\n" }, new: { content: "\ufefffirst\nchanged" } });
    expect(await fs.readFile(path.join(root, "bom.txt"), "utf8")).toBe("\ufefffirst\r\nchanged");
  });

  it("does not run external diff, textconv or configured fsmonitor commands", async () => {
    await write(".gitattributes", "*.txt diff=unsafe\n");
    await write("a.txt", "old\n");
    await commit();
    const marker = path.join(directory, "should-not-exist");
    await git(["config", "diff.external", `touch '${marker}'`]);
    await git(["config", "diff.unsafe.textconv", `touch '${marker}'`]);
    await git(["config", "core.fsmonitor", `touch '${marker}'`]);
    await write("a.txt", "new\n");
    const snapshot = await reader.read({ kind: "unstaged" });
    expect(byPath(snapshot, "a.txt")).toMatchObject({ new: { content: "new\n" } });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores inherited Git repository/index overrides", async () => {
    await write("a.txt", "old\n");
    await commit();
    await write("a.txt", "new\n");
    vi.stubEnv("GIT_DIR", path.join(directory, "wrong"));
    vi.stubEnv("GIT_INDEX_FILE", path.join(directory, "wrong-index"));
    const snapshot = await reader.read({ kind: "unstaged" });
    expect(snapshot.files[0].new.content).toBe("new\n");
    await expect(fs.stat(path.join(directory, "wrong-index"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("represents oversize content separately from missing/empty and keeps real counts", async () => {
    await write("tracked.txt", "line\n".repeat(100));
    await commit();
    await write("tracked.txt", "updated\n".repeat(100));
    await write("large-new.txt", "new\n".repeat(100));
    const snapshot = await new GitReader(root, { maxTextBytes: 32 }).read({ kind: "unstaged" });
    expect(byPath(snapshot, "tracked.txt")).toMatchObject({ additions: 100, deletions: 100, old: { state: "tooLarge", size: 500, content: null }, new: { state: "tooLarge", size: 800, content: null } });
    expect(byPath(snapshot, "large-new.txt")).toMatchObject({ additions: 100, new: { state: "tooLarge", size: 400, content: null } });
  });

  it("reads symlink text without following a target outside the project", async () => {
    if (process.platform === "win32") return;
    const secret = path.join(directory, "private.txt");
    await fs.writeFile(secret, "must not be read");
    await fs.symlink(secret, path.join(root, "link"));
    const snapshot = await reader.read({ kind: "unstaged" });
    expect(snapshot.files[0].new).toMatchObject({ state: "symlink", content: secret });
    expect(JSON.stringify(snapshot)).not.toContain("must not be read");
  });

  it("distinguishes non-repositories, missing Git, cancellation and output limits", async () => {
    expect(await new GitReader(directory).inspect()).toMatchObject({ kind: "notRepository" });
    expect(await new GitReader(root, { git: new GitProcess(path.join(directory, "no-git")) }).inspect()).toMatchObject({ kind: "missingGit" });
    const controller = new AbortController();
    controller.abort();
    await expect(reader.read({ kind: "unstaged" }, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    await expect(new GitProcess().run(root, ["rev-parse", "--show-toplevel"], { maxBytes: 5 })).rejects.toMatchObject({ code: "outputLimit" });
  });

  it("shows non-UTF-8 changes as binary without corrupting other files", async () => {
    await write("legacy.txt", Buffer.from([0xff, 0xfe, 65, 10]));
    await write("normal.txt", "old\n");
    await commit();
    await write("legacy.txt", Buffer.from([0xff, 0xfe, 66, 10]));
    await write("normal.txt", "new\n");
    const snapshot = await reader.read({ kind: "unstaged" });
    expect(byPath(snapshot, "legacy.txt")).toMatchObject({ binary: true, old: { state: "binary", content: null }, new: { state: "binary", content: null } });
    expect(byPath(snapshot, "normal.txt")).toMatchObject({ new: { content: "new\n" } });
  });

  it("captures unmerged index stages and distinguishes them from staged text", async () => {
    await write("conflict.txt", "base\n");
    await commit();
    await git(["checkout", "-qb", "feature"]);
    await write("conflict.txt", "feature\n");
    await commit();
    await git(["checkout", "-q", "main"]);
    await write("conflict.txt", "main\n");
    await commit();
    await expect(git(["merge", "feature"])).rejects.toBeDefined();
    const unstaged = await reader.read({ kind: "unstaged" });
    expect(unstaged.files[0].change).toBe("conflict");
    expect(unstaged.files[0].old.content).toBe("main\n");
    expect(unstaged.files[0].new.content).toContain("<<<<<<< HEAD");
    expect(unstaged.files[0].conflictStages?.map((stage) => stage.stage)).toEqual([1, 2, 3]);
    const staged = await reader.read({ kind: "staged" });
    expect(staged.files[0]).toMatchObject({ change: "conflict", new: { state: "conflict", content: null } });
  });

  it("reads with an index lock held, and changes identity when an untracked path is renamed", async () => {
    await write("tracked.txt", "old\n");
    await commit();
    await write("tracked.txt", "new\n");
    await write("first.txt", "same bytes\n");
    await fs.writeFile(path.join(root, ".git/index.lock"), "held by another process");
    const first = await reader.read({ kind: "unstaged" });
    await fs.rename(path.join(root, "first.txt"), path.join(root, "second.txt"));
    const second = await reader.read({ kind: "unstaged" });
    expect(first.id).not.toBe(second.id);
    expect(await fs.readFile(path.join(root, ".git/index.lock"), "utf8")).toBe("held by another process");
  });

  it("supports SHA-256 object databases and newline-containing repository roots", async () => {
    const shaRoot = path.join(directory, process.platform === "win32" ? "项目 repository" : "项目\nrepository");
    await fs.mkdir(shaRoot);
    await git(["init", "-qb", "main", "--object-format=sha256"], shaRoot);
    await git(["config", "user.name", "fixture"], shaRoot);
    await git(["config", "user.email", "fixture@example.invalid"], shaRoot);
    await write("a.txt", "sha256\n", shaRoot);
    await git(["add", "a.txt"], shaRoot);
    await git(["commit", "-qm", "initial"], shaRoot);
    await write("a.txt", "updated\n", shaRoot);
    const snapshot = await new GitReader(shaRoot).read({ kind: "unstaged" });
    expect(snapshot.repository.objectFormat).toBe("sha256");
    expect(snapshot.repository.head).toHaveLength(64);
    expect(snapshot.files[0].new.content).toBe("updated\n");
  });

  it("refuses to follow an ancestor symlink outside the selected project", async () => {
    if (process.platform === "win32") return;
    await write("dir/file.txt", "public\n");
    await commit();
    const outside = path.join(directory, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "file.txt"), "private\n");
    await fs.rm(path.join(root, "dir"), { recursive: true });
    await fs.symlink(outside, path.join(root, "dir"));
    await expect(reader.read({ kind: "unstaged" })).rejects.toMatchObject({ code: "outsideProject" });
  });

  it("retries a comparison if the working file changes during capture", async () => {
    await write("a.txt", "original\n");
    await commit();
    await write("a.txt", "first edit\n");
    let diffCalls = 0;
    class RacingGit extends GitProcess {
      override async run(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<Buffer> {
        const result = await super.run(cwd, args, options);
        if (args[0] === "diff" && args.includes("--raw") && ++diffCalls === 1) await write("a.txt", "latest edit\n");
        return result;
      }
    }
    const snapshot = await new GitReader(root, { git: new RacingGit() }).read({ kind: "unstaged" });
    expect(snapshot.files[0].new.content).toBe("latest edit\n");
    expect(diffCalls).toBe(4);
  });

  it("reports continuously changing comparisons after a bounded retry", async () => {
    await write("a.txt", "original\n");
    await commit();
    await write("a.txt", "initial edit\n");
    let diffCalls = 0;
    class RacingGit extends GitProcess {
      override async run(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<Buffer> {
        const result = await super.run(cwd, args, options);
        if (args[0] === "diff" && args.includes("--raw")) await write("a.txt", `edit ${++diffCalls}\n`);
        return result;
      }
    }
    await expect(new GitReader(root, { git: new RacingGit() }).read({ kind: "unstaged" })).rejects.toMatchObject({ code: "changedDuringRead" });
    expect(diffCalls).toBe(4);
  });

  it("represents an embedded repository by its commit without traversing its files", async () => {
    await write("tracked.txt", "parent\n");
    await commit();
    const nested = path.join(root, "nested");
    await fs.mkdir(nested);
    await git(["init", "-qb", "main"], nested);
    await git(["config", "user.name", "fixture"], nested);
    await git(["config", "user.email", "fixture@example.invalid"], nested);
    await write("inner.txt", "child repo\n", nested);
    await git(["add", "."], nested);
    await git(["commit", "-qm", "nested"], nested);
    const oid = await git(["rev-parse", "HEAD"], nested);
    const snapshot = await reader.read({ kind: "unstaged" });
    expect(snapshot.files.map((file) => file.path)).toEqual(["nested"]);
    expect(snapshot.files[0].new).toMatchObject({ mode: "160000", state: "submodule", oid, content: `Subproject commit ${oid}\n` });
  });

  it("uses Git attributes and custom binary drivers for untracked text-looking files", async () => {
    await write(".gitattributes", "*.opaque -diff\n*.custom diff=opaque\n");
    await git(["config", "diff.opaque.binary", "true"]);
    await commit();
    await write("one.opaque", "looks like text\n");
    await write("two.custom", "also looks like text\n");
    const snapshot = await reader.read({ kind: "unstaged" });
    expect(snapshot.binaryFiles).toBe(2);
    expect(snapshot.files.every((file) => file.new.state === "binary" && file.additions === 0 && file.new.content === null)).toBe(true);
  });

  it("bounds total untracked text without dropping files or presenting omitted text as empty", async () => {
    await write("one.txt", "line\n".repeat(12));
    await write("two.txt", "line\n".repeat(12));
    await write("three.txt", "line\n".repeat(12));
    const snapshot = await new GitReader(root, { maxSnapshotBytes: 100 }).read({ kind: "unstaged" });
    expect(snapshot.files).toHaveLength(3);
    expect(snapshot.files.filter((file) => file.new.state === "text")).toHaveLength(1);
    expect(snapshot.files.filter((file) => file.new.state === "tooLarge")).toHaveLength(2);
    expect(snapshot.additions).toBe(36);
    expect(snapshot.files.reduce((bytes, file) => bytes + Buffer.byteLength(file.new.content ?? ""), 0)).toBeLessThanOrEqual(100);
  });
});

describe("Git patch reconstruction", () => {
  it("reconstructs distant hunks and rejects stale old content", () => {
    const patch = "@@ -1,2 +1,2 @@\n first\n-old\n+new\n@@ -5 +5 @@\n-last\n+final\n\\ No newline at end of file\n";
    const hunks = parseGitHunks(patch);
    expect(applyGitHunks("first\nold\nkeep\nkeep\nlast\n", hunks)).toBe("first\nnew\nkeep\nkeep\nfinal");
    expect(() => applyGitHunks("stale\nold\nkeep\nkeep\nlast\n", hunks)).toThrow(GitReadError);
  });
  it("handles a large unchanged prefix without spreading thousands of arguments", () => {
    const original = "line\n".repeat(200_000) + "old\n";
    const hunks = parseGitHunks("@@ -200001 +200001 @@\n-old\n+new\n");
    expect(applyGitHunks(original, hunks)).toBe("line\n".repeat(200_000) + "new\n");
  });
});
