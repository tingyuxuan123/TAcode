import type { GitReviewQuery } from "../../shared/git";

/**
 * 行级审查意见。
 *
 * 每条意见绑定当时的比较范围、快照、文件版本和精确行区间，并保存创建时的代码片段：
 * 之后文件内容或快照变化时它被标为过期，界面明确区分，而不是把旧意见画在新代码上。
 * 意见按项目 + 会话隔离，只保存在本机工作台存储里。
 */

export type ReviewCommentSide = "additions" | "deletions";
export interface ReviewComment {
  id: string;
  path: string;
  side: ReviewCommentSide;
  startLine: number;
  endLine: number;
  /** Comparison the comment was written against, e.g. `turn:<snapshotId>`. */
  rangeKey: string;
  /** Snapshot id when the range had one; live ranges record an empty string. */
  snapshotId: string;
  /** File version at creation time; a different current version marks the comment outdated. */
  version: string;
  snippet: string;
  text: string;
  createdAt: number;
  resolvedAt?: number;
}
export interface ReviewCommentScope { projectRoot: string; sessionKey: string }
export interface ReviewCommentContext { rangeKey: string; snapshotId: string }
export const REVIEW_COMMENT_LIMITS = { comments: 200, text: 4_000, snippet: 4_000, path: 4_096 };

export const reviewCommentScope = (scope: ReviewCommentScope): string => JSON.stringify([scope.projectRoot, scope.sessionKey]);
const key = (scope: ReviewCommentScope): string => `tacode:review-comments:v1:${reviewCommentScope(scope)}`;

export function comparisonRangeKey(comparison: GitReviewQuery): string {
  return comparison.kind === "commit" ? `commit:${comparison.commit}`
    : comparison.kind === "branch" ? `branch:${comparison.base}`
      : comparison.kind === "turn" ? `turn:${comparison.snapshotId}` : comparison.kind;
}
export function comparisonSnapshotId(comparison: GitReviewQuery): string {
  return comparison.kind === "turn" ? comparison.snapshotId : "";
}

const positive = (value: unknown, max = 10_000_000): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max;
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

export function readReviewComments(scope: ReviewCommentScope): ReviewComment[] {
  let parsed: unknown;
  try { parsed = JSON.parse(localStorage.getItem(key(scope)) ?? "null"); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const comments: ReviewComment[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (!bounded(value.id, 64) || !value.id || seen.has(value.id)) continue;
    if (!bounded(value.path, REVIEW_COMMENT_LIMITS.path) || !value.path || value.path.includes("\0")) continue;
    if (value.side !== "additions" && value.side !== "deletions") continue;
    if (!positive(value.startLine) || !positive(value.endLine) || value.endLine < value.startLine || value.endLine - value.startLine > 500) continue;
    if (!bounded(value.rangeKey, 1024) || !bounded(value.snapshotId, 128) || !bounded(value.version, 256)) continue;
    if (!bounded(value.snippet, REVIEW_COMMENT_LIMITS.snippet) || !bounded(value.text, REVIEW_COMMENT_LIMITS.text)) continue;
    if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) continue;
    if (value.resolvedAt !== undefined && (typeof value.resolvedAt !== "number" || !Number.isFinite(value.resolvedAt))) continue;
    seen.add(value.id);
    comments.push({ id: value.id, path: value.path, side: value.side, startLine: value.startLine, endLine: value.endLine,
      rangeKey: value.rangeKey, snapshotId: value.snapshotId, version: value.version, snippet: value.snippet, text: value.text,
      createdAt: value.createdAt, ...(value.resolvedAt !== undefined ? { resolvedAt: value.resolvedAt } : {}) });
  }
  return comments.slice(0, REVIEW_COMMENT_LIMITS.comments);
}

export function writeReviewComments(scope: ReviewCommentScope, comments: readonly ReviewComment[]): void {
  try { localStorage.setItem(key(scope), JSON.stringify(comments.slice(0, REVIEW_COMMENT_LIMITS.comments))); }
  catch { /* In-memory comments remain usable when storage is unavailable. */ }
}

export function newReviewComment(input: Omit<ReviewComment, "id" | "createdAt"> & { id?: string; createdAt?: number }): ReviewComment {
  return { ...input, id: input.id ?? crypto.randomUUID().slice(0, 12), createdAt: input.createdAt ?? Date.now(),
    snippet: input.snippet.slice(0, REVIEW_COMMENT_LIMITS.snippet), text: input.text.slice(0, REVIEW_COMMENT_LIMITS.text) };
}

/** Outdated means the code the comment was written against is no longer what is displayed. */
export function commentOutdated(comment: ReviewComment, context: ReviewCommentContext | undefined, version?: string | number): boolean {
  if (!context) return true;
  if (comment.rangeKey !== context.rangeKey || comment.snapshotId !== context.snapshotId) return true;
  return version !== undefined && String(version) !== comment.version;
}

export function commentsForPath(comments: readonly ReviewComment[], path: string): ReviewComment[] {
  return comments.filter((comment) => comment.path === path);
}

export const commentLineRange = (comment: ReviewComment): string => comment.startLine === comment.endLine
  ? `${comment.startLine}` : `${comment.startLine}–${comment.endLine}`;

/** The exact text block that goes into the current conversation draft. */
export function formatReviewComments(comments: readonly ReviewComment[], labels: { heading: string; side(side: ReviewCommentSide): string }): string {
  const lines: string[] = [labels.heading, ""];
  for (const [index, comment] of comments.entries()) {
    lines.push(`${index + 1}. ${comment.path} · ${labels.side(comment.side)} ${commentLineRange(comment)}${comment.snapshotId ? ` · ${comment.snapshotId.slice(0, 8)}` : ""}`);
    lines.push("```");
    lines.push(comment.snippet.replace(/\n$/, ""));
    lines.push("```");
    lines.push(comment.text.trim());
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
