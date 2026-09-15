import { describe, expect, it } from "vitest";
import { buildReviewPrompt, parseReviewReport, type RangeInput } from "./review-findings";

const range: RangeInput = {
  label: "未暂存改动",
  truncated: false,
  notes: ["二进制文件只有元数据。"],
  files: [
    { path: "src/alpha.ts", change: "modified", oldLines: 3, newLines: 4, patch: "@@ -1,3 +1,4 @@\n-old\n+new\n" },
    { path: "assets/logo.png", change: "added", oldLines: 0, newLines: 0, patch: "", binary: true },
  ],
};
const id = (index: number) => `finding-${index + 1}`;
const report = (findings: unknown[], coverage?: unknown) => `这里是报告。\n\`\`\`json\n${JSON.stringify({ findings, ...(coverage ? { coverage } : {}) })}\n\`\`\``;

describe("AI review prompt and findings", () => {
  it("hands the reviewer both sides' real line counts and the exact schema", () => {
    const prompt = buildReviewPrompt(range, "重点看资源释放。");
    expect(prompt).toContain("范围：未暂存改动");
    expect(prompt).toContain("src/alpha.ts（modified，old lines 3，new lines 4）");
    expect(prompt).toContain("+new");
    expect(prompt).toContain("二进制文件只有元数据。");
    expect(prompt).toContain("重点看资源释放。");
    expect(prompt).toContain("side 只能是 old 或 new");
  });

  it("keeps valid findings and reports every rejected one instead of dropping it", () => {
    const parsed = parseReviewReport(report([
      { path: "src/alpha.ts", side: "new", line: 4, severity: "high", title: "缺少释放", evidence: "第 4 行没有 dispose()", confidence: "verified" },
      { path: "src/alpha.ts", side: "old", line: 3, severity: "low", title: "旧侧也能定位", evidence: "第 3 行" },
      { path: "src/nowhere.ts", side: "new", line: 1, severity: "high", title: "范围外", evidence: "x" },
      { path: "src/alpha.ts", side: "middle", line: 1, severity: "high", title: "侧不对", evidence: "x" },
      { path: "src/alpha.ts", side: "new", line: 99, severity: "high", title: "越界", evidence: "x" },
      { path: "src/alpha.ts", side: "new", line: 1, severity: "critical", title: "档位不对", evidence: "x" },
      { path: "src/alpha.ts", side: "new", line: 1, severity: "high", title: "缺少证据" },
      { path: "assets/logo.png", side: "new", line: 0, severity: "medium", title: "二进制不应入库", evidence: "新增了 0 行的二进制文件" },
    ], { notes: ["未验证 Windows 行为"] }), range, id);
    expect(parsed.malformed).toBe(false);
    expect(parsed.findings.map((finding) => [finding.path, finding.side, finding.line, finding.severity, finding.confidence])).toEqual([
      ["src/alpha.ts", "new", 4, "high", "verified"],
      ["src/alpha.ts", "old", 3, "low", "inferred"],
      ["assets/logo.png", "new", 0, "medium", "inferred"],
    ]);
    expect(parsed.findings[0]!.id).toBe("finding-1");
    expect(parsed.rejected).toHaveLength(5);
    expect(parsed.rejected.map((item) => item.reason).join("\n")).toMatch(/路径不在本次范围内/);
    expect(parsed.rejected.map((item) => item.reason).join("\n")).toMatch(/行号超出范围（1–4）/);
    expect(parsed.coverageNotes).toEqual(["未验证 Windows 行为"]);
  });

  it("rejects findings on lines that do not exist on the named side", () => {
    const parsed = parseReviewReport(report([
      { path: "src/alpha.ts", side: "old", line: 4, severity: "high", title: "旧侧越界", evidence: "x" },
      { path: "assets/logo.png", side: "new", line: 3, severity: "high", title: "二进制没有行", evidence: "x" },
    ]), range, id);
    expect(parsed.findings).toEqual([]);
    expect(parsed.rejected).toHaveLength(2);
  });

  it("reports an unparseable report instead of pretending there were no problems", () => {
    const missing = parseReviewReport("我读完了，没有发现问题。", range, id);
    expect(missing.malformed).toBe(true);
    expect(missing.rejected[0]!.reason).toMatch(/没有找到 JSON 结果块/);
    const broken = parseReviewReport("```json\n{ findings: [ }\n```", range, id);
    expect(broken.malformed).toBe(true);
    expect(broken.rejected[0]!.reason).toMatch(/无法解析/);
  });

  it("bounds how many findings one report can add", () => {
    const entries = Array.from({ length: 140 }, () => ({ path: "src/alpha.ts", side: "new", line: 1, severity: "low", title: "t", evidence: "e" }));
    const parsed = parseReviewReport(report(entries), range, id);
    expect(parsed.findings).toHaveLength(100);
  });
});
