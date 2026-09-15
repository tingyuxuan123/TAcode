/**
 * AI 审查协调器：主进程内的独立只读审查。
 *
 * 一次运行 = 一个冻结范围 + 一个只读 worker。协调器只负责状态机与持久化：
 * 拼提示词 → 跑 worker → 解析并校验结构化问题 → 记录历史；不写仓库、不改用户文件，
 * 也不启动主会话的 Agent。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ReviewRun, ReviewStartRequest } from "../../shared/review";
import { REVIEW_LIMITS } from "../../shared/review";
import { buildReviewPrompt, parseReviewReport, type RangeInput } from "./review-findings";

export interface ReviewCoordinatorOptions {
  /** Private history directory; created on demand. */
  root: string;
  /** Runs one read-only review worker and resolves with its final report. */
  run(input: { projectRoot: string; prompt: string; runId: string; signal: AbortSignal }): Promise<string>;
  /** Frozen range content for a comparison; the same data the diff shows. */
  describeRange(projectRoot: string, comparison: ReviewRun["comparison"]): Promise<RangeInput>;
  publish?(run: ReviewRun): void;
  now?(): number;
}
interface ProjectHistory { version: 1; projectRoot: string; runs: ReviewRun[] }

export class ReviewCoordinator {
  private readonly runs = new Map<string, ReviewRun>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly settled = new Map<string, Promise<ReviewRun>>();
  private readonly histories = new Map<string, ProjectHistory>();
  private readonly now: () => number;

  constructor(private readonly options: ReviewCoordinatorOptions) { this.now = options.now ?? (() => Date.now()); }

  async start(request: ReviewStartRequest): Promise<ReviewRun> {
    const projectRoot = path.resolve(request.projectRoot);
    const run: ReviewRun = { id: randomUUID(), projectRoot, comparison: request.comparison,
      snapshotId: request.snapshotId ?? (request.comparison.kind === "turn" ? request.comparison.snapshotId : ""),
      ...(request.requirements?.trim() ? { requirements: request.requirements.trim().slice(0, REVIEW_LIMITS.requirements) } : {}),
      status: "running", startedAt: this.now(), coverage: { files: 0, truncated: false, notes: [] }, findings: [], rejected: [] };
    this.runs.set(run.id, run);
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    this.publish(run);
    const pending = this.execute(run, controller.signal);
    this.settled.set(run.id, pending);
    void pending.catch(() => undefined);
    return run;
  }

  /** Cancels a running review; the recorded run keeps the files it had already read. */
  cancel(id: string): ReviewRun | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    if (run.status === "running") this.controllers.get(id)?.abort();
    return run;
  }

  /** Re-runs a finished review with the same frozen range and requirements. */
  async retry(id: string): Promise<ReviewRun | undefined> {
    const previous = this.runs.get(id);
    if (!previous) return undefined;
    if (previous.status === "running") throw new Error("这次审查仍在运行。");
    return this.start({ projectRoot: previous.projectRoot, comparison: previous.comparison,
      ...(previous.snapshotId ? { snapshotId: previous.snapshotId } : {}), ...(previous.requirements ? { requirements: previous.requirements } : {}) });
  }

  /** Newest first; survives a renderer reload because history is read from disk. */
  async list(projectRoot: string): Promise<ReviewRun[]> {
    const root = path.resolve(projectRoot);
    const active = [...this.runs.values()].filter((run) => run.projectRoot === root);
    const history = await this.load(root);
    const known = new Set(active.map((run) => run.id));
    return [...active, ...(history?.runs ?? []).filter((run) => !known.has(run.id))]
      .sort((left, right) => right.startedAt - left.startedAt).slice(0, REVIEW_LIMITS.runs);
  }

  /** Awaits every in-flight review; used on shutdown and by tests. */
  async idle(): Promise<void> { await Promise.allSettled([...this.settled.values()]); }

  private async execute(run: ReviewRun, signal: AbortSignal): Promise<ReviewRun> {
    try {
      const range = await this.options.describeRange(run.projectRoot, run.comparison);
      run.coverage = { files: range.files.length, truncated: range.truncated, notes: [...range.notes] };
      this.publish(run);
      if (signal.aborted) return this.finish(run, "cancelled");
      const prompt = buildReviewPrompt(range, run.requirements);
      const report = await this.options.run({ projectRoot: run.projectRoot, prompt, runId: run.id, signal });
      if (signal.aborted) return this.finish(run, "cancelled");
      const parsed = parseReviewReport(report, range, (index) => `${run.id.slice(0, 8)}-${index + 1}`);
      run.findings = parsed.findings;
      run.rejected = parsed.rejected;
      run.coverage.notes = [...run.coverage.notes, ...parsed.coverageNotes];
      if (parsed.malformed && !parsed.findings.length) return this.finish(run, "failed", "审查结果不是可解析的 JSON 报告。");
      return this.finish(run, "completed");
    } catch (error) {
      if (signal.aborted) return this.finish(run, "cancelled");
      return this.finish(run, "failed", error instanceof Error ? error.message : String(error));
    }
  }

  private async finish(run: ReviewRun, status: ReviewRun["status"], error?: string): Promise<ReviewRun> {
    run.status = status;
    run.settledAt = this.now();
    if (error) run.error = error;
    this.controllers.delete(run.id);
    await this.persist(run).catch(() => undefined);
    this.publish(run);
    return run;
  }

  private publish(run: ReviewRun): void { this.options.publish?.({ ...run, findings: [...run.findings], rejected: [...run.rejected],
    coverage: { ...run.coverage, notes: [...run.coverage.notes] } }); }

  private file(projectRoot: string): string { return path.join(this.options.root, `${digest(projectRoot)}.json`); }

  private async load(projectRoot: string): Promise<ProjectHistory | undefined> {
    const cached = this.histories.get(projectRoot);
    if (cached) return cached;
    try {
      const file = this.file(projectRoot);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return undefined;
      const record = JSON.parse(await fs.readFile(file, "utf8")) as ProjectHistory;
      if (record?.version !== 1 || record.projectRoot !== projectRoot || !Array.isArray(record.runs)) return undefined;
      const valid = { ...record, runs: record.runs.filter(isStoredRun).slice(0, REVIEW_LIMITS.runs) };
      for (const run of valid.runs) this.runs.set(run.id, run);
      this.histories.set(projectRoot, valid);
      return valid;
    } catch { return undefined; }
  }

  private async persist(run: ReviewRun): Promise<void> {
    const history = await this.load(run.projectRoot) ?? { version: 1 as const, projectRoot: run.projectRoot, runs: [] };
    const record: ProjectHistory = { version: 1, projectRoot: run.projectRoot,
      runs: [run, ...history.runs.filter((item) => item.id !== run.id)].slice(0, REVIEW_LIMITS.runs) };
    await fs.mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const file = this.file(run.projectRoot);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    this.histories.set(run.projectRoot, record);
  }
}

function isStoredRun(value: unknown): value is ReviewRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Record<string, unknown>;
  return typeof run.id === "string" && typeof run.projectRoot === "string" && typeof run.startedAt === "number"
    && typeof run.status === "string" && ["running", "completed", "failed", "cancelled"].includes(run.status)
    && Array.isArray(run.findings) && Array.isArray(run.rejected) && Boolean(run.comparison);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
