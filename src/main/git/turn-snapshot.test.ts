import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../shared/types";
import { gitDigest } from "./git-diff";
import { GitProcess } from "./git-process";
import { GitReader } from "./git-reader";
import { TurnSnapshotService } from "./turn-snapshot";

const git = new GitProcess();
const run = (cwd: string, args: string[]) => git.run(cwd, args);

describe("recent turn snapshots", () => {
  let root: string; let store: string; let service: TurnSnapshotService;
  const settings = (repository: string | readonly string[]) => {
    const allowed = (Array.isArray(repository) ? repository : [repository]) as readonly string[];
    return new TurnSnapshotService({ root: store, resolveProject: async (project) => {
      if (!allowed.some((entry) => path.resolve(entry) === path.resolve(project))) throw new Error("Unknown project");
      return project;
    } });
  };
  const event = (type: string, extra: Record<string, unknown> = {}): AgentEvent => ({ type, __runtimeId: "runtime-1", __sessionId: path.join(store, "session.jsonl"), ...extra });
  const commit = async (cwd: string, message: string) => {
    await run(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", message]);
  };
  const read = (projectRoot: string, snapshotId: string, comparison: Parameters<GitReader["read"]>[0] = { kind: "turn", snapshotId }) =>
    new GitReader(projectRoot, { turns: service }).read(comparison);
  /** The baseline is hashed while the model streams; tests wait for it before writing. */
  const openTurn = async (project: string) => { service.observe(event("agent_start"), project); await service.idle(); };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-turn-"));
    store = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-turn-store-"));
    await run(root, ["init", "--quiet"]);
    service = settings(root);
  });
  afterEach(async () => {
    await service.idle();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(store, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("records one immutable range per turn and never leaks the next turn into it", async () => {
    await fs.writeFile(path.join(root, "keep.txt"), "keep\n");
    await fs.writeFile(path.join(root, "removed.txt"), "doomed\n");
    await run(root, ["add", "-A"]); await commit(root, "base");
    await openTurn(root);
    await fs.writeFile(path.join(root, "keep.txt"), "keep\nedited\n");
    await fs.writeFile(path.join(root, "added.txt"), "brand new\n");
    // A commit made during the turn moves HEAD and the index; the turn range is bound to its own trees.
    await run(root, ["add", "added.txt"]); await commit(root, "add during turn");
    await fs.rm(path.join(root, "removed.txt"));
    service.observe(event("agent_settled"), root);
    await service.idle();
    const state = await service.latest(root);
    expect(state.kind).toBe("turn");
    if (state.kind !== "turn") return;
    const snapshot = await read(root, state.snapshot.id);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.comparison).toEqual({ kind: "turn", snapshotId: state.snapshot.id });
    expect(snapshot.files.map((file) => [file.path, file.change])).toEqual([
      ["added.txt", "added"], ["keep.txt", "modified"], ["removed.txt", "deleted"],
    ]);
    expect(state.snapshot.files).toBe(3);
    expect(state.snapshot.status).toBe("completed");
    expect(state.snapshot.sessionPath).toBe(path.join(store, "session.jsonl"));
    expect(state.snapshot.unfinished).toEqual([]);
    expect(snapshot.files.find((file) => file.path === "keep.txt")?.new.content).toBe("keep\nedited\n");
    expect(snapshot.files.find((file) => file.path === "added.txt")?.old.state).toBe("missing");
    // Later disk changes stay out of the recorded range and out of the reported snapshot.
    await fs.writeFile(path.join(root, "later.txt"), "after the turn\n");
    await fs.writeFile(path.join(root, "keep.txt"), "keep\nrewritten later\n");
    const again = await read(root, state.snapshot.id);
    expect(again.files.map((file) => file.path)).toEqual(["added.txt", "keep.txt", "removed.txt"]);
    expect(again.files.find((file) => file.path === "keep.txt")?.new.content).toBe("keep\nedited\n");
    const latest = await service.latest(root);
    expect(latest.kind === "turn" && latest.snapshot.id).toBe(state.snapshot.id);
  });

  it("starts the next turn from the workspace as it stands, not from the previous baseline", async () => {
    await fs.writeFile(path.join(root, "one.txt"), "one\n");
    await run(root, ["add", "-A"]); await commit(root, "base");
    await openTurn(root);
    await fs.writeFile(path.join(root, "one.txt"), "one changed\n");
    service.observe(event("agent_settled"), root);
    await service.idle();
    const first = await service.latest(root);
    expect(first.kind).toBe("turn");
    await openTurn(root);
    await fs.writeFile(path.join(root, "two.txt"), "two\n");
    service.observe(event("agent_settled"), root);
    await service.idle();
    const second = await service.latest(root);
    expect(second.kind).toBe("turn");
    if (second.kind !== "turn" || first.kind !== "turn") return;
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    const snapshot = await read(root, second.snapshot.id);
    expect(snapshot.files.map((file) => [file.path, file.change])).toEqual([["two.txt", "added"]]);
    // The first turn's range is still readable and unchanged.
    const previous = await read(root, first.snapshot.id);
    expect(previous.files.map((file) => file.path)).toEqual(["one.txt"]);
  });

  it("marks commands that were still running and records a stop as the turn's end", async () => {
    await fs.writeFile(path.join(root, "file.txt"), "start\n");
    await run(root, ["add", "-A"]); await commit(root, "base");
    await openTurn(root);
    service.observe(event("tool_execution_start", { toolCallId: "call-1", toolName: "exec_command", args: { cmd: "npm run build --watch" } }), root);
    service.observe(event("tool_execution_end", { toolCallId: "call-1", toolName: "exec_command", result: { details: { running: true, processId: "build-7" } } }), root);
    await fs.writeFile(path.join(root, "file.txt"), "start\nstop\n");
    service.observe(event("desktop_runtime_stopped"), root);
    await service.idle();
    const state = await service.latest(root);
    expect(state.kind).toBe("turn");
    if (state.kind !== "turn") return;
    expect(state.snapshot.status).toBe("stopped");
    expect(state.snapshot.unfinished).toEqual([expect.objectContaining({ tool: "exec_command", command: "npm run build --watch", processId: "build-7" })]);
    expect((await read(root, state.snapshot.id)).files.map((file) => file.path)).toEqual(["file.txt"]);
  });

  it("reports capture failures, missing history and collected objects instead of live content", async () => {
    const repository = path.join(root, "sub"); await fs.mkdir(repository, { recursive: true });
    await run(root, ["init", "--quiet"]);
    service = settings(repository);
    expect((await service.latest(repository)).kind).toBe("missing");
    await openTurn(repository);
    await fs.writeFile(path.join(repository, "inside.txt"), "inside\n");
    service.observe(event("agent_settled"), repository);
    await service.idle();
    const state = await service.latest(repository);
    expect(state.kind).toBe("turn");
    if (state.kind !== "turn") return;
    // A project nested in a repository only reviews its own subtree.
    const snapshot = await read(repository, state.snapshot.id);
    expect(snapshot.files.map((file) => file.path)).toEqual(["inside.txt"]);
    // Collected objects are reported as expired, and the reader refuses the range.
    await fs.rm(path.join(root, ".git", "objects"), { recursive: true, force: true });
    await run(root, ["init", "--quiet"]);
    expect((await service.latest(repository)).kind).toBe("expired");
    await expect(read(repository, state.snapshot.id)).rejects.toMatchObject({ code: "noTurnSnapshot" });
  });

  it("records a failure for projects that cannot be snapshotted", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-turn-plain-"));
    service = settings(plain);
    await openTurn(plain);
    await fs.writeFile(path.join(plain, "notes.txt"), "not a repository\n");
    service.observe(event("agent_settled"), plain);
    await service.idle();
    const state = await service.latest(plain);
    expect(state).toMatchObject({ kind: "failed", projectRoot: await fs.realpath(plain) });
    expect(state.kind === "failed" && state.reason).toContain("Git");
    await fs.rm(plain, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("keeps project scopes apart and rejects unknown or unauthorized snapshots", async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-turn-other-"));
    try {
      await run(other, ["init", "--quiet"]);
      await fs.writeFile(path.join(root, "a.txt"), "a\n");
      await openTurn(root);
      await fs.writeFile(path.join(root, "a.txt"), "a changed\n");
      service.observe(event("agent_settled"), root);
      await service.idle();
      const otherService = settings([root, other]);
      expect((await otherService.latest(other)).kind).toBe("missing");
      const state = await service.latest(root);
      expect(state.kind).toBe("turn");
      if (state.kind !== "turn") return;
      await expect(new GitReader(other, { turns: service }).read({ kind: "turn", snapshotId: state.snapshot.id })).rejects.toMatchObject({ code: "noTurnSnapshot" });
      await expect(service.resolve("not-a-digest")).resolves.toBeUndefined();
      await expect(service.resolve("a".repeat(64))).resolves.toBeUndefined();
      await expect(service.latest(path.join(other, "missing"))).resolves.toMatchObject({ kind: "error" });
    } finally { await fs.rm(other, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });

  it("reuses the recorded snapshot after a renderer reload and while a later turn runs", async () => {
    await fs.writeFile(path.join(root, "value.txt"), "v1\n");
    await run(root, ["add", "-A"]); await commit(root, "base");
    await openTurn(root);
    await fs.writeFile(path.join(root, "value.txt"), "v2\n");
    service.observe(event("agent_settled"), root);
    await service.idle();
    const first = await service.latest(root);
    expect(first.kind).toBe("turn");
    if (first.kind !== "turn") return;
    // A new service instance reads the persisted manifest (fresh process or reload).
    const reloaded = settings(root);
    expect(await reloaded.latest(root)).toMatchObject({ kind: "turn", snapshot: { id: first.snapshot.id } });
    // Starting another turn keeps the recorded history visible until the new one settles.
    reloaded.observe(event("agent_start"), root);
    await reloaded.idle();
    expect(await reloaded.latest(root)).toMatchObject({ kind: "turn", snapshot: { id: first.snapshot.id } });
    await reloaded.idle();
  });

  it("retains a bounded history per project and publishes each settled turn", async () => {
    const published = vi.fn();
    service = new TurnSnapshotService({ root: store, resolveProject: async (project) => project, publish: published });
    await fs.writeFile(path.join(root, "counter.txt"), "0\n");
    await run(root, ["add", "-A"]); await commit(root, "base");
    for (let index = 1; index <= 10; index++) {
      await openTurn(root);
      await fs.writeFile(path.join(root, "counter.txt"), `${index}\n`);
      service.observe(event("agent_settled"), root);
      await service.idle();
    }
    expect(published).toHaveBeenCalledTimes(10);
    const manifest = JSON.parse(await fs.readFile(path.join(store, `${gitDigest(await fs.realpath(root))}.json`), "utf8"));
    expect(manifest.snapshots).toHaveLength(8);
    const latest = await service.latest(root);
    expect(latest.kind).toBe("turn");
    if (latest.kind !== "turn") return;
    expect((await read(root, latest.snapshot.id)).files[0]?.new.content).toBe("10\n");
  });
});
