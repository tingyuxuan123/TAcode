/**
 * 最近一轮审查的不可变快照。
 *
 * 一轮对话从 `agent_start`（用户请求开始）到 `agent_settled`/停止：开始时用私有 index
 * 抓一份工作区树，结束时再抓一份。两棵树都写进仓库的对象库，因此内容由 Git 自身寻址、
 * 之后保持不变；本轮之后的磁盘变化只影响实时范围（未暂存/已暂存），不会改动这两棵树。
 *
 * 不对快照做任何猜测：抓不到基线就报失败，对象被回收就报过期，没有记录就报缺失——
 * 绝不用当前内容冒充历史。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../../shared/types";
import { GitProcess, GitReadError, decodeGitText, gitOutputLine } from "../git/git-process";
import { gitDigest } from "../git/git-diff";
import type { GitFailure, GitTurnCommand, GitTurnSnapshot, GitTurnSnapshotState } from "../../shared/git";

/** Snapshot ids are content digests; manifests are pruned per project. */
const RETAINED = 8;
const MANIFEST_BYTES = 2 * 1024 * 1024;
const TREE_TIMEOUT_MS = 120_000;

export interface TurnSnapshotManifest {
  version: 1;
  id: string;
  projectRoot: string;
  repositoryRoot: string;
  pathPrefix: string;
  sessionPath: string | null;
  startedAt: number;
  settledAt: number;
  status: "completed" | "stopped";
  baseTree: string;
  targetTree: string;
  files: number;
  additions: number;
  deletions: number;
  baselineMs: number;
  targetMs: number;
  unfinished: GitTurnCommand[];
  warnings: string[];
}
type TurnFailure = { version: 1; projectRoot: string; failedAt: number; reason: string };
type ProjectRecord = { version: 1; projectRoot: string; snapshots: TurnSnapshotManifest[]; failure?: TurnFailure };

interface TurnState {
  projectRoot: string;
  rawProjectRoot: string;
  repositoryRoot: string;
  pathPrefix: string;
  sessionPath: string | null;
  startedAt: number;
  ready?: Promise<void>;
  baseline?: Promise<string>;
  baselineMs?: number;
  baselineFinishedAt?: number;
  firstToolAt?: number;
  tools: Map<string, GitTurnCommand>;
  unfinished: GitTurnCommand[];
  warnings: Set<string>;
  unavailable?: string;
}

export interface TurnSnapshotOptions {
  /** Private manifest directory; created on demand. */
  root: string;
  /** Production supplies the opened-project authorization check. Never ambient cwd. */
  resolveProject(projectRoot: string): Promise<string>;
  git?: GitProcess;
  now?: () => number;
  publish?(update: { projectRoot: string; snapshot: GitTurnSnapshot }): void;
}

const toolSummary = (name: string, args: unknown): { command: string; processId?: string } => {
  if (!args || typeof args !== "object") return { command: name };
  const value = args as Record<string, unknown>;
  for (const key of ["cmd", "command", "path", "file", "file_path"]) {
    const text = value[key];
    if (typeof text === "string" && text.trim()) return { command: text.replace(/\s+/g, " ").trim().slice(0, 300) };
  }
  return { command: name };
};

const detailRunning = (result: unknown): { running: boolean; processId?: string } => {
  if (!result || typeof result !== "object") return { running: false };
  const { details } = result as { details?: unknown };
  if (!details || typeof details !== "object") return { running: false };
  const value = details as Record<string, unknown>;
  return { running: value.running === true, processId: typeof value.processId === "string" && value.processId ? value.processId : undefined };
};

/** Records one immutable snapshot per agent turn, keyed by project. */
export class TurnSnapshotService {
  private readonly git: GitProcess;
  private readonly now: () => number;
  private readonly turns = new Map<string, TurnState>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly records = new Map<string, ProjectRecord>();

  constructor(private readonly options: TurnSnapshotOptions) {
    this.git = options.git ?? new GitProcess();
    this.now = options.now ?? (() => Date.now());
  }

  /** Drives turn boundaries and unfinished commands from the runtime event stream. */
  observe(event: AgentEvent, projectRoot: string | undefined): void {
    const runtimeId = event.__runtimeId;
    if (!runtimeId || !projectRoot) return;
    if (event.type === "agent_start") {
      if (this.turns.has(runtimeId)) this.finish(runtimeId, "stopped");
      // The turn is registered synchronously so a very short turn cannot lose its settle event.
      const turn: TurnState = { projectRoot, rawProjectRoot: projectRoot, repositoryRoot: "", pathPrefix: "",
        sessionPath: event.__sessionId ?? null, startedAt: this.now(), tools: new Map(), unfinished: [], warnings: new Set() };
      this.turns.set(runtimeId, turn);
      turn.ready = this.initialize(turn);
      return;
    }
    const turn = this.turns.get(runtimeId);
    if (!turn) return;
    if (event.type === "tool_execution_start") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      if (!toolCallId) return;
      turn.firstToolAt ??= this.now();
      const tool = typeof event.toolName === "string" ? event.toolName : "tool";
      const { command } = toolSummary(tool, event.args);
      turn.tools.set(toolCallId, { tool, command, startedAt: this.now() });
      return;
    }
    if (event.type === "tool_execution_end") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      if (!toolCallId) return;
      const started = turn.tools.get(toolCallId);
      turn.tools.delete(toolCallId);
      const { running, processId } = detailRunning(event.result);
      // A backgrounded command keeps writing after the tool returned; the turn's snapshot cannot include those writes.
      if (running && started) turn.unfinished.push({ ...started, ...(processId ? { processId } : {}) });
      return;
    }
    if (event.type === "agent_settled" || event.type === "desktop_runtime_stopped") this.finish(runtimeId, event.type === "agent_settled" ? "completed" : "stopped");
  }

  /** Latest snapshot for a project, with explicit states instead of a live fallback. */
  async latest(rawProjectRoot: string): Promise<GitTurnSnapshotState> {
    let projectRoot: string;
    try { projectRoot = await this.projectRoot(rawProjectRoot); }
    catch (error) { return { kind: "error", error: failure(error) }; }
    const active = [...this.turns.values()].find((turn) => turn.projectRoot === projectRoot || turn.rawProjectRoot === projectRoot);
    const record = await this.load(projectRoot);
    const snapshot = record?.snapshots[0];
    if (!snapshot) {
      if (active) return { kind: "capturing", projectRoot, startedAt: active.startedAt };
      if (record?.failure) return { kind: "failed", projectRoot, reason: record.failure.reason };
      return { kind: "missing", projectRoot };
    }
    if (!(await this.objectsExist(snapshot))) return { kind: "expired", snapshot: summary(snapshot) };
    return { kind: "turn", snapshot: summary(snapshot) };
  }

  /** Resolver handed to GitReader; undefined means the objects are gone, unknown, or another project's. */
  resolve = async (snapshotId: string, projectRoot?: string): Promise<{ base: string; target: string } | undefined> => {
    const snapshot = await this.find(snapshotId);
    if (!snapshot) return undefined;
    if (projectRoot) {
      const requested = await fs.realpath(projectRoot).catch(() => path.resolve(projectRoot));
      if (requested !== snapshot.projectRoot) return undefined;
    }
    return (await this.objectsExist(snapshot)) ? { base: snapshot.baseTree, target: snapshot.targetTree } : undefined;
  };

  /** Awaits in-flight baseline/target captures; used on shutdown and by tests. */
  async idle(): Promise<void> {
    for (let round = 0; round < 100; round++) {
      const active = [...this.turns.values()].flatMap((turn) => [turn.ready, turn.baseline].filter(Boolean) as Promise<unknown>[]);
      const work = [...this.pending, ...this.queues.values(), ...active];
      if (!work.length) return;
      await Promise.allSettled(work);
      if (!this.pending.size && !this.queues.size) return;
    }
  }

  private key(projectRoot: string): string { return gitDigest(projectRoot); }
  private file(projectRoot: string): string { return path.join(this.options.root, `${this.key(projectRoot)}.json`); }

  private async projectRoot(raw: string): Promise<string> {
    const allowed = await this.options.resolveProject(raw).catch((error: unknown) => {
      throw error instanceof GitReadError ? error : new GitReadError("outsideProject", error instanceof Error ? error.message : String(error));
    });
    return await fs.realpath(allowed);
  }

  private async initialize(turn: TurnState): Promise<void> {
    try { turn.projectRoot = await this.projectRoot(turn.rawProjectRoot); }
    catch (error) { turn.unavailable = error instanceof Error ? error.message : String(error); return; }
    try {
      const [rootValue, prefixValue] = await Promise.all([
        this.git.run(turn.projectRoot, ["rev-parse", "--show-toplevel"]),
        this.git.run(turn.projectRoot, ["rev-parse", "--show-prefix"]),
      ]);
      turn.repositoryRoot = await fs.realpath(gitOutputLine(rootValue));
      turn.pathPrefix = gitOutputLine(prefixValue).replace(/\/$/, "");
    } catch {
      turn.unavailable = "本轮快照需要当前项目是一个 Git 仓库。";
      return;
    }
    // Hash the workspace while the model is still streaming; the turn's first write usually lands after this.
    const baseline = this.serial(turn.projectRoot, () => this.captureTree(turn));
    turn.baseline = baseline;
    void baseline.then(() => undefined, () => undefined).finally(() => {
      turn.baselineMs = this.now() - turn.startedAt;
      turn.baselineFinishedAt = this.now();
    });
  }

  private finish(runtimeId: string, status: "completed" | "stopped"): void {
    const turn = this.turns.get(runtimeId);
    if (!turn) return;
    this.turns.delete(runtimeId);
    this.track(this.capture(turn, status));
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.catch(() => undefined).finally(() => this.pending.delete(promise));
    return promise;
  }

  private async capture(turn: TurnState, status: "completed" | "stopped"): Promise<void> {
    const settledAt = this.now();
    try {
      await turn.ready;
      if (turn.unavailable) { await this.recordFailure(turn.projectRoot, turn.unavailable); return; }
      const baseline = await turn.baseline;
      if (!baseline) { await this.recordFailure(turn.projectRoot, "未能记录本轮开始时的基线。"); return; }      if (turn.firstToolAt !== undefined && (turn.baselineFinishedAt ?? settledAt) > turn.firstToolAt)
        turn.warnings.add("本轮的首个工具调用早于基线抓取完成，与基线并发写入的文件可能缺失。");
      const targetStarted = this.now();
      const targetTree = await this.serial(turn.projectRoot, () => this.captureTree(turn));
      const targetMs = this.now() - targetStarted;
      const [files, additions, deletions] = await this.range(turn, baseline, targetTree);
      const snapshot: TurnSnapshotManifest = {
        version: 1, id: gitDigest(turn.projectRoot, baseline, targetTree), projectRoot: turn.projectRoot, repositoryRoot: turn.repositoryRoot,
        pathPrefix: turn.pathPrefix, sessionPath: turn.sessionPath, startedAt: turn.startedAt, settledAt, status,
        baseTree: baseline, targetTree, files, additions, deletions, baselineMs: turn.baselineMs ?? 0, targetMs,
        unfinished: turn.unfinished, warnings: [...turn.warnings],
      };
      await this.store(turn.projectRoot, snapshot);
      this.options.publish?.({ projectRoot: turn.projectRoot, snapshot: summary(snapshot) });
    } catch (error) {
      const reason = error instanceof GitReadError ? error.message : error instanceof Error ? error.message : String(error);
      await this.recordFailure(turn.projectRoot, reason).catch(() => undefined);
    }
  }

  private async captureTree(turn: TurnState): Promise<string> {
    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const indexFile = path.join(this.options.root, `${this.key(turn.projectRoot)}.index`);
    const cwd = turn.pathPrefix ? path.join(turn.repositoryRoot, ...turn.pathPrefix.split("/")) : turn.repositoryRoot;
    // --ignore-errors keeps a readable subset instead of losing the whole turn to one unreadable file.
    await this.git.run(cwd, ["add", "-A", "--ignore-errors", "--", "."], { indexFile, timeoutMs: TREE_TIMEOUT_MS, allowExitCodes: [1] });
    return gitOutputLine(await this.git.run(cwd, ["write-tree"], { indexFile, timeoutMs: TREE_TIMEOUT_MS }));
  }

  private async range(turn: TurnState, base: string, target: string): Promise<[number, number, number]> {
    const output = decodeGitText(await this.git.run(turn.repositoryRoot, ["diff", "--numstat", "-z", base, target], { timeoutMs: TREE_TIMEOUT_MS }));
    let files = 0; let additions = 0; let deletions = 0;
    for (const record of output.split("\0")) {
      const match = /^(\d+|-)\t(\d+|-)\t/.exec(record);
      if (!match) continue;
      files++;
      if (match[1] !== "-") additions += Number(match[1]);
      if (match[2] !== "-") deletions += Number(match[2]);
    }
    return [files, additions, deletions];
  }

  private async objectsExist(snapshot: TurnSnapshotManifest): Promise<boolean> {
    const exists = async (oid: string) => {
      const output = await this.git.run(snapshot.projectRoot, ["rev-parse", "--verify", "--quiet", `${oid}^{tree}`], { allowExitCodes: [1, 128] });
      return output.length > 0;
    };
    try { return await exists(snapshot.baseTree) && await exists(snapshot.targetTree); } catch { return false; }
  }

  /** Serializes captures per project: two turns must not share one private index at the same time. */
  private serial<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
    const key = this.key(projectRoot);
    const prior = this.queues.get(key) ?? Promise.resolve();
    const next = prior.then(operation, operation);
    const settled = next.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return next;
  }

  private async load(projectRoot: string): Promise<ProjectRecord | undefined> {
    const cached = this.records.get(projectRoot);
    if (cached) return cached;
    try {
      const file = this.file(projectRoot);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MANIFEST_BYTES) return undefined;
      const record = JSON.parse(await fs.readFile(file, "utf8")) as ProjectRecord;
      if (record?.version !== 1 || record.projectRoot !== projectRoot || !Array.isArray(record.snapshots)) return undefined;
      const valid = { ...record, snapshots: record.snapshots.filter((snapshot) => validManifest(snapshot, projectRoot)) };
      this.records.set(projectRoot, valid);
      return valid;
    } catch { return undefined; }
  }

  private async find(snapshotId: string): Promise<TurnSnapshotManifest | undefined> {
    if (!/^[a-f0-9]{64}$/.test(snapshotId)) return undefined;
    for (const record of this.records.values()) { const found = record.snapshots.find((snapshot) => snapshot.id === snapshotId); if (found) return found; }
    let entries;
    try { entries = await fs.readdir(this.options.root); } catch { return undefined; }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const record = JSON.parse(await fs.readFile(path.join(this.options.root, entry), "utf8")) as ProjectRecord;
        if (record?.version !== 1 || !Array.isArray(record.snapshots)) continue;
        this.records.set(record.projectRoot, record);
        const found = record.snapshots.find((snapshot) => snapshot.id === snapshotId);
        if (found && validManifest(found, record.projectRoot)) return found;
      } catch { /* Foreign or corrupt manifests are ignored. */ }
    }
    return undefined;
  }

  private async store(projectRoot: string, snapshot: TurnSnapshotManifest): Promise<void> {
    const previous = await this.load(projectRoot);
    const record: ProjectRecord = { version: 1, projectRoot,
      snapshots: [snapshot, ...(previous?.snapshots ?? []).filter((item) => item.id !== snapshot.id)].slice(0, RETAINED) };
    await this.write(projectRoot, record);
  }

  private async recordFailure(projectRoot: string, reason: string): Promise<void> {
    const previous = await this.load(projectRoot);
    const record: ProjectRecord = { version: 1, projectRoot, snapshots: previous?.snapshots ?? [], failure: { version: 1, projectRoot, failedAt: this.now(), reason } };
    await this.write(projectRoot, record);
  }

  private async write(projectRoot: string, record: ProjectRecord): Promise<void> {
    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const file = this.file(projectRoot);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    this.records.set(projectRoot, record);
  }
}

const summary = (manifest: TurnSnapshotManifest): GitTurnSnapshot => ({
  id: manifest.id, projectRoot: manifest.projectRoot, sessionPath: manifest.sessionPath, startedAt: manifest.startedAt, settledAt: manifest.settledAt,
  status: manifest.status, baseTree: manifest.baseTree, targetTree: manifest.targetTree, files: manifest.files, additions: manifest.additions,
  deletions: manifest.deletions, baselineMs: manifest.baselineMs, targetMs: manifest.targetMs,
  unfinished: manifest.unfinished, warnings: manifest.warnings,
});

function validManifest(value: TurnSnapshotManifest, projectRoot: string): boolean {
  return Boolean(value && value.version === 1 && value.projectRoot === projectRoot
    && /^[a-f0-9]{40,64}$/.test(String(value.baseTree)) && /^[a-f0-9]{40,64}$/.test(String(value.targetTree))
    && typeof value.id === "string" && typeof value.startedAt === "number" && typeof value.settledAt === "number"
    && (value.status === "completed" || value.status === "stopped") && Array.isArray(value.unfinished) && Array.isArray(value.warnings));
}

function failure(error: unknown): GitFailure {
  return error instanceof GitReadError
    ? { code: error.code === "outsideProject" ? "outsideProject" : "failed", message: error.message }
    : { code: "failed", message: error instanceof Error ? error.message : String(error) };
}
