/**
 * 把只读 Git 快照映射成审查范围：两侧真实行数 + 有预算的补丁文本。
 *
 * 行数决定 reviewer 给出的行号能不能落地；超出预算的补丁被截断并标注，宁可少给内容，
 * 也不给一份看起来完整、实际缺文件的“范围”。
 */

import type { GitComparison } from "../../shared/git";
import type { GitReader } from "../git/git-reader";
import type { RangeInput } from "./review-findings";

export const REVIEW_RANGE_BYTES = 1024 * 1024;

/** Lines a side actually shows; an empty file has none, a trailing newline adds no extra line. */
export function rangeLineCount(content: string | null): number {
  if (content === null) return 0;
  if (!content.length) return 0;
  return content.endsWith("\n") ? content.slice(0, -1).split("\n").length : content.split("\n").length;
}

export function describeComparison(comparison: GitComparison): string {
  return comparison.kind === "unstaged" ? "未暂存改动"
    : comparison.kind === "staged" ? "已暂存改动"
      : comparison.kind === "commit" ? `提交 ${comparison.commit}`
        : comparison.kind === "branch" ? `相对分支 ${comparison.base}`
          : `最近一轮快照 ${comparison.snapshotId.slice(0, 8)}`;
}

export async function describeReviewRange(reader: GitReader, comparison: GitComparison, budget = REVIEW_RANGE_BYTES): Promise<RangeInput> {
  const snapshot = await reader.read(comparison);
  let remaining = budget; let truncated = false;
  const files = snapshot.files.map((file) => {
    const patch = file.patch ?? "";
    const bytes = Buffer.byteLength(patch);
    const keep = bytes <= remaining;
    if (keep) remaining -= bytes; else truncated = true;
    return { path: file.path, change: file.change, oldLines: rangeLineCount(file.old.content), newLines: rangeLineCount(file.new.content),
      patch: keep ? patch : patch.slice(0, Math.max(0, remaining)), binary: file.binary };
  });
  const notes = [
    ...(truncated ? ["部分文件的补丁内容超出预算，已截断。"] : []),
    ...(snapshot.files.some((file) => file.binary) ? ["二进制或超出文本上限的文件只有元数据。"] : []),
  ];
  return { label: describeComparison(comparison), files, truncated, notes };
}
