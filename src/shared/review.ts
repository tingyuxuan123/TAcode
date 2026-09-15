/**
 * AI 审查契约。
 *
 * 一次审查绑定一个冻结范围（未暂存/已暂存/指定提交/相对分支/最近一轮），只读运行一个
 * `code-reviewer` 配置的独立 worker，返回结构化问题。问题必须能落到范围内真实存在的
 * 路径、侧与行号上，校验不通过的条目单独列出，不混进结果。
 */

import type { GitComparison } from "./git";

export type ReviewScopeKind = GitComparison["kind"];
export type ReviewSeverity = "high" | "medium" | "low";
export type ReviewConfidence = "verified" | "inferred";
export type ReviewSide = "old" | "new";

export interface ReviewFinding {
  id: string;
  path: string;
  side: ReviewSide;
  line: number;
  severity: ReviewSeverity;
  title: string;
  /** What the reviewer actually read, with the precise location it quoted. */
  evidence: string;
  confidence: ReviewConfidence;
}
/** A reported issue that does not exist in the frozen range; kept visible instead of dropped. */
export interface ReviewRejected {
  reason: string;
  raw: string;
}
export interface ReviewCoverage {
  /** Files included in the frozen range that the reviewer was asked to read. */
  files: number;
  /** True when the range content had to be clipped before the run. */
  truncated: boolean;
  notes: string[];
}
export interface ReviewRun {
  id: string;
  projectRoot: string;
  comparison: GitComparison;
  /** Snapshot the run was frozen against; empty for ranges without one. */
  snapshotId: string;
  requirements?: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  settledAt?: number;
  coverage: ReviewCoverage;
  findings: ReviewFinding[];
  rejected: ReviewRejected[];
  error?: string;
}
export interface ReviewStartRequest {
  projectRoot: string;
  comparison: GitComparison;
  snapshotId?: string;
  requirements?: string;
}
export interface ReviewApi {
  start(request: ReviewStartRequest): Promise<ReviewRun>;
  cancel(id: string): Promise<ReviewRun | undefined>;
  retry(id: string): Promise<ReviewRun | undefined>;
  list(projectRoot: string): Promise<ReviewRun[]>;
  onUpdate(listener: (run: ReviewRun) => void): () => void;
}
export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ["high", "medium", "low"];
/** The reviewer only ever gets these tools; it cannot write, and exec_command stays on the read-only allowlist. */
export const REVIEW_TOOLS: readonly string[] = ["read_file", "list_files", "search_files", "exec_command"];
export const REVIEW_LIMITS = { findings: 100, findingText: 4_000, evidence: 4_000, requirements: 2_000, runs: 20 };
