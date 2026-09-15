import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitReviewQuery, GitReviewUpdate } from "../../shared/git";
import { GitReader } from "./git-reader";
import { GitReviewService, type GitReviewServiceOptions } from "./git-service";
import { isGitMetadataChange, type GitWatchFactory } from "./git-watch";

const exec = promisify(execFile);
let directory: string;
let root: string;
let services: GitReviewService[];
const git = async (args: string[], cwd = root) => (await exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: {
  ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_DEFAULT_HASH: "sha1",
} })).stdout.trimEnd();
const write = (text: string, file = "file.txt", cwd = root) => fs.writeFile(path.join(cwd, file), text);
const ready = (events: GitReviewUpdate[], id?: string) => [...events].reverse().find((event) => event.result?.kind === "ready" && (!id || event.subscriptionId === id))?.result;
function service(options: Partial<GitReviewServiceOptions> = {}) {
  const result = new GitReviewService({ resolveProject: async (project) => project, debounceMs: 20, ...options });
  services.push(result); return result;
}
async function subscribe(target: GitReviewService, projectRoot = root, query: GitReviewQuery = { kind: "unstaged" }, id = "sub", owner = 1) {
  const events: GitReviewUpdate[] = [];
  await target.subscribe(owner, { subscriptionId: id, projectRoot, query }, (event) => events.push(event));
  return events;
}
function controlledWatch() {
  const handles = new Set<{ root: string; changed(file: string | null): void; failed(): void }>();
  const factory: GitWatchFactory = (root, changed, failed) => {
    const handle = { root, changed, failed }; handles.add(handle); return () => { handles.delete(handle); };
  };
  return { handles, factory, emit: (root: string, filename: string) => { for (const handle of [...handles]) if (handle.root === root) handle.changed(filename); } };
}
beforeEach(async () => {
  services = [];
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-git-service-"));
  root = path.join(directory, "project"); await fs.mkdir(root); root = await fs.realpath(root);
  await git(["init", "-qb", "main"]);
  await git(["config", "user.name", "TACode fixture"]); await git(["config", "user.email", "fixture@example.invalid"]);
  await write("base\n"); await git(["add", "--all"]); await git(["commit", "-qm", "base"]);
});
afterEach(async () => { for (const target of services) target.close(); await fs.rm(directory, { recursive: true, force: true }); });

describe("active Git subscriptions", () => {
  it("coalesces two owners onto one canonical project/comparison and releases the last watcher", async () => {
    const watch = controlledWatch(); const reader = new GitReader(root); const read = vi.spyOn(reader, "read");
    const target = service({ watch: watch.factory, reader: () => reader });
    await write("working\n");
    const [first, second] = await Promise.all([subscribe(target), subscribe(target, path.join(root, "."), { kind: "unstaged" }, "sub", 2)]);
    await expect.poll(() => [ready(first)?.kind, ready(second)?.kind]).toEqual(["ready", "ready"]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(watch.handles.size).toBe(2);
    target.unsubscribe(1, "sub");
    expect(target.stats()).toMatchObject({ projects: 1, subscriptions: 1 });
    target.releaseOwner(2);
    expect(target.stats()).toEqual({ projects: 0, subscriptions: 0, reads: 0 });
    expect(watch.handles.size).toBe(0);
  });

  it("refreshes native worktree, dotfile and index changes without mixing staged content", async () => {
    const target = service();
    const events = await subscribe(target);
    await expect.poll(() => ready(events)?.kind, { timeout: 5000 }).toBe("ready");
    await write("first edit\n");
    await expect.poll(() => { const value = ready(events); return value?.kind === "ready" ? value.snapshot.files[0]?.new.content : undefined; }, { timeout: 5000 }).toBe("first edit\n");
    await write("hidden\n", ".hidden.txt");
    await expect.poll(() => { const value = ready(events); return value?.kind === "ready" ? value.snapshot.files.map((file) => file.path) : []; }, { timeout: 5000 }).toContain(".hidden.txt");
    await git(["add", "file.txt"]);
    await expect.poll(() => { const value = ready(events); return value?.kind === "ready" ? value.snapshot.files.map((file) => file.path) : ["file.txt"]; }, { timeout: 5000 }).not.toContain("file.txt");
    const staged = await subscribe(target, root, { kind: "staged" }, "staged");
    await expect.poll(() => { const value = ready(staged); return value?.kind === "ready" ? value.snapshot.files[0]?.new.content : undefined; }).toBe("first edit\n");
    await write("second edit\n");
    await expect.poll(() => { const value = ready(events); return value?.kind === "ready" ? value.snapshot.files.find((file) => file.path === "file.txt")?.old.content : undefined; }, { timeout: 5000 }).toBe("first edit\n");
    const value = ready(staged);
    expect(value?.kind === "ready" && value.snapshot.files[0].new.content).toBe("first edit\n");
  }, 15_000);

  it("watches a linked worktree's index and shared refs outside the selected project", async () => {
    const linked = path.join(directory, "linked");
    await git(["worktree", "add", "-qb", "feature", linked]);
    const target = service(); const events = await subscribe(target, linked, { kind: "staged" });
    await expect.poll(() => ready(events)?.kind, { timeout: 5000 }).toBe("ready");
    await write("linked index\n", "file.txt", linked); await git(["add", "file.txt"], linked);
    await expect.poll(() => { const value = ready(events); return value?.kind === "ready" ? value.snapshot.files[0]?.new.content : undefined; }, { timeout: 5000 }).toBe("linked index\n");
    await git(["branch", "new-base"]);
    await expect.poll(() => { const value = ready(events); return value?.kind === "ready" ? value.branches.map((branch) => branch.name) : []; }, { timeout: 5000 }).toContain("new-base");
    const value = ready(events);
    expect(value?.kind === "ready" && value.snapshot.repository.branch).toBe("feature");
    expect((await new GitReader(root).read({ kind: "staged" })).files).toHaveLength(0);
  }, 15_000);

  it("does not start readers or watchers when cancelled during project authorization", async () => {
    let allow!: (root: string) => void;
    const watch = controlledWatch(); const reader = vi.fn(() => new GitReader(root));
    const target = service({ resolveProject: () => new Promise((resolve) => { allow = resolve; }), watch: watch.factory, reader });
    const events: GitReviewUpdate[] = [];
    const pending = target.subscribe(1, { subscriptionId: "pending", projectRoot: root, query: { kind: "unstaged" } }, (event) => events.push(event));
    target.unsubscribe(1, "pending"); allow(root); await pending;
    expect(reader).not.toHaveBeenCalled(); expect(events).toHaveLength(0); expect(watch.handles.size).toBe(0);
    expect(target.stats().subscriptions).toBe(0);
  });

  it("drops an obsolete captured result after an external event and reads again", async () => {
    const watch = controlledWatch(); const reader = new GitReader(root); const read = reader.read.bind(reader);
    let release!: () => void; let captured = false;
    vi.spyOn(reader, "read").mockImplementationOnce(async (query, signal) => { const value = await read(query, signal); captured = true; await new Promise<void>((resolve) => { release = resolve; }); return value; });
    const target = service({ reader: () => reader, watch: watch.factory });
    await write("old captured edit\n"); const events = await subscribe(target);
    await expect.poll(() => captured).toBe(true);
    await write("new edit\n"); watch.emit(root, "file.txt"); release();
    await expect.poll(() => { const value = ready(events); return value?.kind === "ready" ? value.snapshot.files[0]?.new.content : undefined; }).toBe("new edit\n");
    expect(events.filter((event) => event.result?.kind === "ready")).toHaveLength(1);
  });

  it("aborts an in-flight read when its last subscriber closes", async () => {
    const reader = new GitReader(root); let signal: AbortSignal | undefined;
    vi.spyOn(reader, "read").mockImplementation((_query, abort) => { signal = abort; return new Promise((_resolve, reject) => abort?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); });
    const target = service({ reader: () => reader, watch: controlledWatch().factory });
    const events = await subscribe(target);
    await expect.poll(() => Boolean(signal)).toBe(true);
    target.releaseOwner(1);
    expect(signal?.aborted).toBe(true);
    expect(target.stats()).toEqual({ projects: 0, subscriptions: 0, reads: 0 });
    expect(events.every((event) => event.result?.kind !== "ready")).toBe(true);
  });

  it("uses metadata-only reads for branch choice and excludes worktree-only refreshes", async () => {
    const watch = controlledWatch(); const reader = new GitReader(root); const read = vi.spyOn(reader, "read"); const inspect = vi.spyOn(reader, "inspect");
    const target = service({ reader: () => reader, watch: watch.factory });
    const events = await subscribe(target, root, { kind: "repository" });
    await expect.poll(() => events.at(-1)?.result?.kind).toBe("repository");
    const before = inspect.mock.calls.length; watch.emit(root, "file.txt");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(inspect).toHaveBeenCalledTimes(before); expect(read).not.toHaveBeenCalled();
  });

  it("recovers from a non-repository after git init using the existing subscription", async () => {
    const fresh = path.join(directory, "fresh"); await fs.mkdir(fresh);
    const target = service(); const events = await subscribe(target, fresh);
    await expect.poll(() => events.at(-1)?.result?.kind).toBe("notRepository");
    await git(["init", "-qb", "main"], fresh); await write("new\n", "new.txt", fresh);
    await expect.poll(() => { const value = ready(events); return value?.kind === "ready" ? value.snapshot.files[0]?.path : undefined; }, { timeout: 5000 }).toBe("new.txt");
  }, 10_000);

  it("reports polling fallback without starving reads slower than the poll interval", async () => {
    const target = service({ watch: () => { throw new Error("watch unavailable"); }, pollMs: 20,
      reader: () => ({ inspect: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return { kind: "missingGit", projectRoot: root }; },
        read: vi.fn(), branches: vi.fn() }) });
    const events = await subscribe(target);
    await expect.poll(() => events.filter((event) => event.result?.kind === "missingGit").length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)?.watchMode).toBe("polling");
    target.unsubscribe(1, "sub"); const count = events.length;
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(events).toHaveLength(count);
  });

  it("keeps two projects with the same filename isolated and enforces authorization", async () => {
    const other = path.join(directory, "other"); await fs.mkdir(other); await git(["init", "-qb", "main"], other);
    await write("other content\n", "file.txt", other); await write("first content\n");
    const target = service({ resolveProject: async (project) => { if (project !== root && project !== other) throw new Error("not opened"); return project; } });
    const [first, second, denied] = await Promise.all([subscribe(target), subscribe(target, other, { kind: "unstaged" }, "other"), subscribe(target, directory, { kind: "unstaged" }, "denied")]);
    await expect.poll(() => [ready(first)?.kind, ready(second)?.kind]).toEqual(["ready", "ready"]);
    for (const [events, text] of [[first, "first content\n"], [second, "other content\n"]] as const) { const value = ready(events); expect(value?.kind === "ready" && value.snapshot.files[0].new.content).toBe(text); }
    expect(denied.at(-1)?.result).toMatchObject({ kind: "error", error: { code: "outsideProject" } });
    const count = first.length; target.refresh(99, "sub"); target.unsubscribe(99, "sub");
    expect(first).toHaveLength(count); expect(target.stats().projects).toBe(2);
  });

  it("ignores locks and object churn but observes index/ref/config changes", () => {
    for (const name of ["index", "HEAD", "refs/heads/main", "packed-refs", "config", "info/exclude", null]) expect(isGitMetadataChange(name)).toBe(true);
    for (const name of ["index.lock", "refs/heads/main.lock", "objects/ab/cdef", "logs/HEAD", "worktrees/other/index"]) expect(isGitMetadataChange(name)).toBe(false);
  });
});
