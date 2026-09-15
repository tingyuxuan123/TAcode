import { describe, expect, it, vi } from "vitest";
import type { GitSnapshot } from "../../shared/git";
import { describeComparison, describeReviewRange, rangeLineCount, REVIEW_RANGE_BYTES } from "./review-range";

const reader = (snapshot: Partial<GitSnapshot>) => ({ read: vi.fn(async () => snapshot as GitSnapshot) }) as never;
const file = (extra: Record<string, unknown>) => ({ id: "f", version: "v", path: "src/alpha.ts", change: "modified" as const, repositoryPath: "src/alpha.ts",
  old: { oid: "a", mode: "100644", size: 4, state: "text" as const, content: "old\n" },
  new: { oid: "b", mode: "100644", size: 8, state: "text" as const, content: "new\nline\n" },
  additions: 1, deletions: 1, binary: false, patch: "@@ -1 +1,2 @@\n-old\n+new\n+line\n", hunks: [], ...extra });

describe("AI review range", () => {
  it("counts the lines each side really shows", () => {
    expect(rangeLineCount(null)).toBe(0);
    expect(rangeLineCount("")).toBe(0);
    expect(rangeLineCount("one")).toBe(1);
    expect(rangeLineCount("one\n")).toBe(1);
    expect(rangeLineCount("one\ntwo\n")).toBe(2);
    expect(rangeLineCount("one\n\ntwo")).toBe(3);
  });

  it("labels every comparison kind", () => {
    expect(describeComparison({ kind: "unstaged" })).toBe("未暂存改动");
    expect(describeComparison({ kind: "staged" })).toBe("已暂存改动");
    expect(describeComparison({ kind: "commit", commit: "HEAD~1" })).toBe("提交 HEAD~1");
    expect(describeComparison({ kind: "branch", base: "main" })).toBe("相对分支 main");
    expect(describeComparison({ kind: "turn", snapshotId: "abcdef1234567890" })).toBe("最近一轮快照 abcdef12");
  });

  it("maps a snapshot to side line counts, patches and coverage notes", async () => {
    const range = await describeReviewRange(reader({ files: [file({}), file({ path: "assets/logo.png", binary: true, patch: "", old: { oid: null, mode: "000000", size: 0, state: "missing", content: null }, new: { oid: "c", mode: "100644", size: 10, state: "binary", content: null } })] }), { kind: "unstaged" });
    expect(range.label).toBe("未暂存改动");
    expect(range.truncated).toBe(false);
    expect(range.files.map((entry) => [entry.path, entry.oldLines, entry.newLines, entry.binary])).toEqual([
      ["src/alpha.ts", 1, 2, false],
      ["assets/logo.png", 0, 0, true],
    ]);
    expect(range.notes).toEqual(["二进制或超出文本上限的文件只有元数据。"]);
  });

  it("clips oversized patches and says so instead of pretending the range was complete", async () => {
    const big = "x".repeat(600);
    const range = await describeReviewRange(reader({ files: [file({ patch: big }), file({ path: "src/beta.ts", patch: big })] }), { kind: "staged" }, 700);
    expect(range.truncated).toBe(true);
    expect(range.notes[0]).toBe("部分文件的补丁内容超出预算，已截断。");
    expect(Buffer.byteLength(range.files[0]!.patch) + Buffer.byteLength(range.files[1]!.patch)).toBeLessThanOrEqual(700);
    expect(REVIEW_RANGE_BYTES).toBeGreaterThan(700);
  });
});
