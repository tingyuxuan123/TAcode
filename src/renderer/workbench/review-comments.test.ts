import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commentLineRange, commentOutdated, commentsForPath, comparisonRangeKey, comparisonSnapshotId, formatReviewComments,
  newReviewComment, readReviewComments, reviewCommentScope, writeReviewComments, type ReviewComment } from "./review-comments";

const scope = { projectRoot: "/project-a", sessionKey: "/sessions/one.jsonl" };
const comment = (extra: Partial<ReviewComment> = {}): ReviewComment => newReviewComment({ path: "src/alpha.ts", side: "additions",
  startLine: 12, endLine: 13, rangeKey: "turn:snapshot-1", snapshotId: "snapshot-1", version: "version-1", snippet: "export const value = 2;\nexport const other = 3;\n",
  text: "这里需要补充单测。", ...extra });

describe("review comments", () => {
  beforeEach(() => { const values = new Map<string, string>(); vi.stubGlobal("localStorage", { clear: () => values.clear(),
    removeItem: (key: string) => values.delete(key), getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }); });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps comments apart per project and session and survives a reload", () => {
    expect(reviewCommentScope(scope)).toBe('["/project-a","/sessions/one.jsonl"]');
    writeReviewComments(scope, [comment()]);
    expect(readReviewComments(scope)).toHaveLength(1);
    expect(readReviewComments({ projectRoot: "/project-a", sessionKey: "/sessions/two.jsonl" })).toEqual([]);
    expect(readReviewComments({ projectRoot: "/project-b", sessionKey: scope.sessionKey })).toEqual([]);
    writeReviewComments(scope, []);
    expect(readReviewComments(scope)).toEqual([]);
  });

  it("drops malformed, oversized and duplicated entries instead of failing", () => {
    const valid = comment();
    const values = [null, "text", { ...valid, id: "" }, { ...valid, side: "middle" }, { ...valid, startLine: 0 },
      { ...valid, endLine: 2 }, { ...valid, text: "x".repeat(4_001) }, { ...valid, snippet: "x".repeat(4_001) },
      { ...valid, path: "a\0b" }, { ...valid, rangeKey: 1 }, { ...valid, createdAt: "now" }, valid];
    localStorage.setItem(`tacode:review-comments:v1:${reviewCommentScope(scope)}`, JSON.stringify(values));
    const parsed = readReviewComments(scope);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(valid);
  });

  it("bounds stored comments and text length", () => {
    writeReviewComments(scope, Array.from({ length: 260 }, () => comment()));
    expect(readReviewComments(scope)).toHaveLength(200);
    expect(JSON.parse(localStorage.getItem(`tacode:review-comments:v1:${reviewCommentScope(scope)}`)!).length).toBe(200);
    const long = newReviewComment({ ...comment(), text: "y".repeat(9_000), snippet: "z".repeat(9_000) });
    expect(long.text).toHaveLength(4_000);
    expect(long.snippet).toHaveLength(4_000);
  });

  it("marks a comment outdated when the range, snapshot or file version changes", () => {
    const value = comment();
    expect(commentOutdated(value, { rangeKey: value.rangeKey, snapshotId: value.snapshotId }, value.version)).toBe(false);
    expect(commentOutdated(value, { rangeKey: value.rangeKey, snapshotId: value.snapshotId }, "version-2")).toBe(true);
    expect(commentOutdated(value, { rangeKey: "unstaged", snapshotId: "" }, value.version)).toBe(true);
    expect(commentOutdated(value, { rangeKey: value.rangeKey, snapshotId: "snapshot-2" }, value.version)).toBe(true);
    expect(commentOutdated(value, undefined, value.version)).toBe(true);
    // A range without per-file versions still compares the recorded range and snapshot.
    expect(commentOutdated(value, { rangeKey: value.rangeKey, snapshotId: value.snapshotId })).toBe(false);
  });

  it("derives stable range keys and snapshot ids from every comparison", () => {
    expect(comparisonRangeKey({ kind: "unstaged" })).toBe("unstaged");
    expect(comparisonRangeKey({ kind: "staged" })).toBe("staged");
    expect(comparisonRangeKey({ kind: "commit", commit: "HEAD~1" })).toBe("commit:HEAD~1");
    expect(comparisonRangeKey({ kind: "branch", base: "refs/heads/main" })).toBe("branch:refs/heads/main");
    expect(comparisonRangeKey({ kind: "turn", snapshotId: "abc" })).toBe("turn:abc");
    expect(comparisonSnapshotId({ kind: "turn", snapshotId: "abc" })).toBe("abc");
    expect(comparisonSnapshotId({ kind: "unstaged" })).toBe("");
  });

  it("groups by path and formats the exact draft block", () => {
    const first = comment();
    const second = comment({ id: "second", path: "src/beta.ts", side: "deletions", startLine: 4, endLine: 4, rangeKey: "unstaged", snapshotId: "", snippet: "removed();\n", text: "这行可以删。" });
    expect(commentsForPath([first, second], "src/beta.ts")).toEqual([second]);
    expect(commentLineRange(first)).toBe("12–13");
    expect(commentLineRange(second)).toBe("4");
    const text = formatReviewComments([first, second], { heading: "请按审查意见修改：", side: (side) => side === "additions" ? "新增侧" : "删除侧" });
    expect(text).toBe([
      "请按审查意见修改：",
      "",
      "1. src/alpha.ts · 新增侧 12–13 · snapshot",
      "```",
      "export const value = 2;",
      "export const other = 3;",
      "```",
      "这里需要补充单测。",
      "",
      "2. src/beta.ts · 删除侧 4",
      "```",
      "removed();",
      "```",
      "这行可以删。",
    ].join("\n"));
  });
});
