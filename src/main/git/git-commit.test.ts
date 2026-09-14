import fs from "node:fs/promises";
import os, { devNull } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitCommitService, gitCommitFailure } from "./git-commit";
import { GitReader } from "./git-reader";
import { GitProcess, GitReadError, type GitRunOptions } from "./git-process";
import { GitWriteQueue } from "./git-write-queue";

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tacode-git-commit-")));
  const root = path.join(directory, "project"); await fs.mkdir(root);
  const git = (...args: string[]) => exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_DEFAULT_HASH: "sha1" } });
  const gitAt = (cwd: string, ...args: string[]) => exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_DEFAULT_HASH: "sha1" } });
  const write = (file: string, contents: string | Buffer) => fs.writeFile(path.join(root, file), contents);
  await git("init", "-qb", "main"); await git("config", "user.name", "TACode fixture"); await git("config", "user.email", "fixture@example.invalid");
  await write("source.txt", "base\n"); await git("add", "source.txt"); await git("commit", "-qm", "base");
  const queue = new GitWriteQueue();
  const service = new GitCommitService({ resolveProject: async (candidate) => candidate, queue });
  cleanups.push(async () => { service.close(); await service.idle(); await fs.rm(directory, { recursive: true, force: true }); });
  const reader = new GitReader(root);
  return { directory, root, git, gitAt, write, reader, service, queue };
}

describe("Git commit and push", () => {
  it("reports staged content, identity, remote and upstream target", async () => {
    const f = await fixture();
    await f.write("source.txt", "staged\n"); await f.git("add", "source.txt");
    const remote = path.join(f.directory, "remote.git"); await f.gitAt(f.directory, "init", "--bare", "-q", remote); await f.git("remote", "add", "origin", remote); await f.git("push", "-q", "-u", "origin", "main");
    const snapshot = await f.reader.read({ kind: "staged" });
    const info = await f.service.info(f.root, snapshot);
    expect(info).toMatchObject({ branch: "main", upstream: "origin/main", hasStaged: true, stagedPaths: ["source.txt"], identity: { name: "TACode fixture", email: "fixture@example.invalid" }, upstreamTarget: { remote: "origin", branch: "main" } });
    expect(info.remotes).toEqual([{ name: "origin", fetchUrl: remote, pushUrl: remote }]);
  });

  it("commits staged content while retaining later unstaged edits", async () => {
    const f = await fixture();
    await f.write("source.txt", "staged\n"); await f.git("add", "source.txt");
    await f.write("source.txt", "staged plus work\n");
    const snapshot = await f.reader.read({ kind: "staged" });
    const preview = await f.service.prepare(1, snapshot, "commit", "commit staged change");
    expect(preview).toMatchObject({ action: "commit", message: "commit staged change", stagedPaths: ["source.txt"] });
    expect(await f.service.apply(1, preview.token)).toMatchObject({ kind: "applied", action: "commit", commit: { message: "commit staged change" } });
    expect((await f.git("log", "-1", "--format=%s")).stdout.trim()).toBe("commit staged change");
    expect((await f.git("show", ":source.txt")).stdout).toBe("staged\n");
    expect(await fs.readFile(path.join(f.root, "source.txt"), "utf8")).toBe("staged plus work\n");
  });

  it("protects staged changes outside an opened subproject and permits a commit confined to that subproject", async () => {
    const f = await fixture(); const project = path.join(f.root, "package"); await fs.mkdir(project);
    await f.write("package/inside.txt", "inside\n"); await f.write("source.txt", "outside\n"); await f.git("add", "--all");
    const reader = new GitReader(project); const snapshot = await reader.read({ kind: "staged" });
    expect(snapshot.files.map((file) => file.path)).toEqual(["inside.txt"]);
    await expect(f.service.prepare(1, snapshot, "commit", "scoped commit")).rejects.toMatchObject({ code: "outsideStagedChanges" });
    expect((await f.git("log", "-1", "--format=%s")).stdout.trim()).toBe("base");
    expect((await f.git("diff", "--cached", "--name-only")).stdout.trim().split("\n")).toEqual(["package/inside.txt", "source.txt"]);
    await f.git("reset", "-q", "HEAD", "source.txt");
    const preview = await f.service.prepare(1, await reader.read({ kind: "staged" }), "commit", "scoped commit");
    expect(await f.service.apply(1, preview.token)).toMatchObject({ kind: "applied", commit: { message: "scoped commit" } });
    expect((await f.git("show", "HEAD:source.txt")).stdout).toBe("base\n");
    expect(await fs.readFile(path.join(f.root, "source.txt"), "utf8")).toBe("outside\n");
    expect((await f.git("show", "HEAD:package/inside.txt")).stdout).toBe("inside\n");
  });

  it("commits and pushes to a local bare remote, setting an absent upstream", async () => {
    const f = await fixture();
    const remote = path.join(f.directory, "remote.git"); await f.gitAt(f.directory, "init", "--bare", "-q", remote); await f.git("remote", "add", "origin", remote);
    await f.write("source.txt", "pushed\n"); await f.git("add", "source.txt");
    const snapshot = await f.reader.read({ kind: "staged" });
    const preview = await f.service.prepare(1, snapshot, "commitAndPush", "publish change", { remote: "origin", branch: "main" });
    const result = await f.service.apply(1, preview.token);
    expect(result).toMatchObject({ kind: "applied", action: "commitAndPush", commit: { message: "publish change" }, push: { remote: "origin", branch: "main" } });
    const remoteHead = (await exec("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim();
    expect((result as { commit: { oid: string } }).commit.oid).toBe(remoteHead);
    expect((await f.git("rev-parse", "--abbrev-ref", "@{upstream}")).stdout.trim()).toBe("origin/main");
  });

  it.each(["push", "commitAndPush"] as const)("%s sends current HEAD to a differently named target, retaining the old local branch", async (action) => {
    const f = await fixture();
    const remote = path.join(f.directory, "remote.git"); await f.gitAt(f.directory, "init", "--bare", "-q", remote); await f.git("remote", "add", "origin", remote);
    await f.git("branch", "release"); const oldRelease = (await f.git("rev-parse", "release")).stdout.trim();
    await f.git("push", "-q", "origin", "release");
    await f.write("source.txt", "current main change\n"); await f.git("add", "source.txt");
    if (action === "push") await f.git("commit", "-qm", "current main change");
    const preview = await f.service.prepare(1, await f.reader.read({ kind: "staged" }), action, "current main change", { remote: "origin", branch: " release " });
    expect(preview.target).toEqual({ remote: "origin", branch: "release" });
    const result = await f.service.apply(1, preview.token);
    const head = (await f.git("rev-parse", "HEAD")).stdout.trim();
    expect(result).toMatchObject({ kind: "applied", push: { remote: "origin", branch: "release", oid: head } });
    expect((await f.gitAt(remote, "rev-parse", "refs/heads/release")).stdout.trim()).toBe(head);
    expect((await f.git("rev-parse", "release")).stdout.trim()).toBe(oldRelease);
    expect((await f.git("rev-parse", "--abbrev-ref", "@{upstream}")).stdout.trim()).toBe("origin/release");
  });

  it("rejects invalid and expanding push branch names with an actionable code", async () => {
    const f = await fixture(); await f.git("remote", "add", "origin", path.join(f.directory, "remote.git"));
    const snapshot = await f.reader.read({ kind: "staged" });
    for (const branch of ["bad:branch", "bad branch", "-force", "@{-1}", ".."]) {
      await expect(f.service.prepare(1, snapshot, "push", undefined, { remote: "origin", branch })).rejects.toMatchObject({ code: "invalidRequest" });
    }
  });

  it("redacts URL credentials from remote metadata and error details", async () => {
    const f = await fixture();
    await f.git("remote", "add", "origin", "https://private-user:private-token@example.invalid/repo.git");
    expect((await f.service.info(f.root)).remotes).toEqual([{ name: "origin", fetchUrl: "https://example.invalid/repo.git", pushUrl: "https://example.invalid/repo.git" }]);
    expect(gitCommitFailure(new GitReadError("authFailed", "Failed https://private-user:private-token@example.invalid/repo.git", "fatal: https://private-token@example.invalid/repo.git")))
      .toMatchObject({ error: { code: "authFailed", message: "Failed https://example.invalid/repo.git", details: "fatal: https://example.invalid/repo.git" } });
    expect(JSON.stringify(gitCommitFailure(new Error("Failed https://private-token@example.invalid/repo.git")))).not.toContain("private-token");
  });

  it("refuses to commit on a different branch switched to the same HEAD during confirmation", async () => {
    const f = await fixture(); await f.write("source.txt", "staged\n"); await f.git("add", "source.txt");
    const snapshot = await f.reader.read({ kind: "staged" });
    const preview = await f.service.prepare(1, snapshot, "commit", "intended for main");
    await f.git("checkout", "-qb", "other");
    expect(await f.service.apply(1, preview.token)).toMatchObject({ kind: "error", error: { code: "staleSnapshot" } });
    expect((await f.git("log", "-1", "--format=%s")).stdout.trim()).toBe("base");
    expect((await f.git("diff", "--cached", "--name-only")).stdout.trim()).toBe("source.txt");
  });

  it("refuses to commit or push when the remote address changes during confirmation", async () => {
    const f = await fixture(); const first = path.join(f.directory, "first.git"); const second = path.join(f.directory, "second.git");
    for (const remote of [first, second]) await f.gitAt(f.directory, "init", "--bare", "-q", remote);
    await f.git("remote", "add", "origin", first); await f.write("source.txt", "staged\n"); await f.git("add", "source.txt");
    const preview = await f.service.prepare(1, await f.reader.read({ kind: "staged" }), "commitAndPush", "intended for first", { remote: "origin", branch: "main" });
    await f.git("remote", "set-url", "--push", "origin", second);
    expect(await f.service.apply(1, preview.token)).toMatchObject({ kind: "error", error: { code: "staleSnapshot" } });
    expect((await f.git("log", "-1", "--format=%s")).stdout.trim()).toBe("base");
    for (const remote of [first, second]) expect((await f.gitAt(remote, "for-each-ref", "refs/heads")).stdout.trim()).toBe("");
  });

  it.each([
    { details: "fatal: Authentication failed for https://private-token@example.invalid/repo.git", code: "authFailed" },
    { details: "fatal: unable to access https://private-token@example.invalid/repo.git: Could not resolve host", code: "pushFailed" },
  ])("classifies $code and redacts credentials without a network request", async ({ details, code }) => {
    const f = await fixture(); await f.git("remote", "add", "origin", "https://private-token@example.invalid/repo.git");
    class RejectingPushGit extends GitProcess {
      async run(cwd: string, args: readonly string[], options: GitRunOptions = {}) {
        if (args[0] === "push") throw new GitReadError("failed", "Git exited 128", details);
        return super.run(cwd, args, options);
      }
    }
    const service = new GitCommitService({ resolveProject: async (candidate) => candidate, git: new RejectingPushGit() });
    try {
      const preview = await service.prepare(1, await f.reader.read({ kind: "staged" }), "push", undefined, { remote: "origin", branch: "main" });
      const result = await service.apply(1, preview.token);
      expect(result).toMatchObject({ kind: "error", error: { code } });
      expect(JSON.stringify(result)).not.toContain("private-token");
    } finally { service.close(); await service.idle(); }
  });

  it("gives direct no-staged and no-upstream outcomes", async () => {
    const f = await fixture();
    const snapshot = await f.reader.read({ kind: "staged" });
    await expect(f.service.prepare(1, snapshot, "commit", "nothing")).rejects.toMatchObject({ code: "noStagedChanges" });
    await f.write("source.txt", "staged\n"); await f.git("add", "source.txt");
    const next = await f.reader.read({ kind: "staged" });
    await expect(f.service.prepare(1, next, "push")).rejects.toMatchObject({ code: "noUpstream" });
  });

  it("surfaces missing identity and hook rejection without creating a commit", async () => {
    const f = await fixture(); await f.write("source.txt", "identity\n"); await f.git("add", "source.txt");
    await f.git("config", "user.name", ""); await f.git("config", "user.email", "");
    const noIdentity = await f.reader.read({ kind: "staged" });
    await expect(f.service.prepare(1, noIdentity, "commit", "identity")).rejects.toMatchObject({ code: "identityMissing" });
    await f.git("config", "user.name", "TACode fixture"); await f.git("config", "user.email", "fixture@example.invalid");
    const hooks = path.join(f.directory, "hooks"); await fs.mkdir(hooks); await fs.writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\necho hook blocked >&2\nexit 1\n", { mode: 0o755 }); await f.git("config", "core.hooksPath", hooks);
    const hookSnapshot = await f.reader.read({ kind: "staged" }); const preview = await f.service.prepare(1, hookSnapshot, "commit", "hook");
    expect(await f.service.apply(1, preview.token)).toMatchObject({ kind: "error", error: { code: "hookFailed" } });
    expect((await f.git("log", "-1", "--format=%s")).stdout.trim()).toBe("base");
  });

  it("surfaces non-fast-forward rejection and keeps the local commit", async () => {
    const f = await fixture();
    const remote = path.join(f.directory, "remote.git"); await f.gitAt(f.directory, "init", "--bare", "-q", remote); await f.git("remote", "add", "origin", remote); await f.git("push", "-q", "-u", "origin", "main");
    const other = path.join(f.directory, "other"); await f.gitAt(f.directory, "clone", "-q", remote, other); await f.gitAt(other, "checkout", "-qb", "main", "origin/main"); await f.gitAt(other, "config", "user.name", "Other"); await f.gitAt(other, "config", "user.email", "other@example.invalid"); await fs.writeFile(path.join(other, "other.txt"), "remote\n"); await f.gitAt(other, "add", "other.txt"); await f.gitAt(other, "commit", "-qm", "remote"); await f.gitAt(other, "push", "-q");
    await f.write("source.txt", "local\n"); await f.git("add", "source.txt");
    const snapshot = await f.reader.read({ kind: "staged" }); const preview = await f.service.prepare(1, snapshot, "commitAndPush", "local");
    const result = await f.service.apply(1, preview.token);
    expect(result).toMatchObject({ kind: "error", error: { code: "pushRejected" }, commit: { message: "local" } });
    expect((await f.git("log", "-1", "--format=%s")).stdout.trim()).toBe("local");
  });

  it("cancels an in-flight Git process and reports cancellation", async () => {
    const f = await fixture(); await f.write("source.txt", "cancel\n"); await f.git("add", "source.txt");
    let entered!: () => void; const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    class BlockingGit extends GitProcess {
      async run(cwd: string, args: readonly string[], options: GitRunOptions = {}) {
        if (args[0] === "commit") {
          entered();
          await new Promise<void>((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
        }
        return super.run(cwd, args, options);
      }
    }
    const service = new GitCommitService({ resolveProject: async (candidate) => candidate, git: new BlockingGit() });
    try {
      const preview = await service.prepare(1, await f.reader.read({ kind: "staged" }), "commit", "cancel");
      const applying = service.apply(1, preview.token); await enteredPromise; service.cancel(1, preview.token);
      await expect(applying).resolves.toMatchObject({ kind: "error", error: { code: "cancelled" } });
    } finally { service.close(); await service.idle(); }
  });

  it.each(["cancel", "release", "close"] as const)("%s stops an operation while it waits behind another repository write", async (action) => {
    const f = await fixture(); await f.write("source.txt", "queued\n"); await f.git("add", "source.txt");
    const snapshot = await f.reader.read({ kind: "staged" });
    const preview = await f.service.prepare(1, snapshot, "commit", "queued commit");
    let release!: () => void;
    const held = f.queue.enqueue(snapshot.repository.commonDir,
      () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const applying = f.service.apply(1, preview.token);
    if (action === "cancel") f.service.cancel(1, preview.token);
    else if (action === "release") f.service.releaseOwner(1);
    else f.service.close();
    release(); await held;
    await expect(applying).resolves.toMatchObject({ kind: "error", error: { code: "cancelled" } });
    expect((await f.git("log", "-1", "--format=%s")).stdout.trim()).toBe("base");
    expect((await f.git("diff", "--cached", "--name-only")).stdout.trim()).toBe("source.txt");
  });

  it("does not create a confirmation token after its owner closes during preparation", async () => {
    const f = await fixture(); await f.write("source.txt", "preparing\n"); await f.git("add", "source.txt");
    let entered!: () => void; let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    class DelayedGit extends GitProcess {
      async run(cwd: string, args: readonly string[], options: GitRunOptions = {}) {
        const output = await super.run(cwd, args, options);
        if (args[0] === "config" && args[2] === "user.email") {
          entered(); await new Promise<void>((resolve) => { release = resolve; });
        }
        return output;
      }
    }
    const service = new GitCommitService({ resolveProject: async (candidate) => candidate, git: new DelayedGit() });
    try {
      const preparing = service.prepare(1, await f.reader.read({ kind: "staged" }), "commit", "preparing");
      const rejected = expect(preparing).rejects.toMatchObject({ code: "cancelled" });
      await enteredPromise; service.releaseOwner(1); release(); await rejected;
    } finally { service.close(); await service.idle(); }
  });

  it.each(["completed", "cancelledExit"] as const)("preserves a local commit when cancelled before push with a %s Git exit", async (exit) => {
    const f = await fixture(); const remote = path.join(f.directory, "remote.git");
    await f.gitAt(f.directory, "init", "--bare", "-q", remote); await f.git("remote", "add", "origin", remote);
    await f.write("source.txt", "committed before cancellation\n"); await f.git("add", "source.txt");
    let service!: GitCommitService; let token!: string;
    class CancelAfterCommitGit extends GitProcess {
      async run(cwd: string, args: readonly string[], options: GitRunOptions = {}) {
        const output = await super.run(cwd, args, options);
        if (args[0] === "commit") {
          service.cancel(1, token);
          if (exit === "cancelledExit") throw new GitReadError("cancelled", "Git operation was cancelled");
        }
        return output;
      }
    }
    service = new GitCommitService({ resolveProject: async (candidate) => candidate, git: new CancelAfterCommitGit() });
    try {
      const preview = await service.prepare(1, await f.reader.read({ kind: "staged" }), "commitAndPush", "completed locally", { remote: "origin", branch: "main" }); token = preview.token;
      expect(await service.apply(1, token)).toMatchObject({ kind: "error", error: { code: "cancelled" }, commit: { message: "completed locally", oid: (await f.git("rev-parse", "HEAD")).stdout.trim() } });
      expect((await f.gitAt(remote, "for-each-ref", "refs/heads")).stdout.trim()).toBe("");
    } finally { service.close(); await service.idle(); }
  });
});
