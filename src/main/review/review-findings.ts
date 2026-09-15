/**
 * AI 审查的提示词构造与结果校验（纯函数，便于单测）。
 *
 * 冻结范围以补丁文本交给 reviewer，附带每个文件两侧的行号区间，这样它给出的行号可以
 * 被机械校验：路径必须在范围内，行号必须落在该侧的真实行数内。校验不通过的问题不会
 * 被丢掉，而是进入 rejected 列表，界面照实显示——宁可少报，不伪造定位。
 */

import { REVIEW_LIMITS, REVIEW_SEVERITIES, type ReviewConfidence, type ReviewFinding, type ReviewRejected, type ReviewSide } from "../../shared/review";

export interface RangeFile {
  path: string;
  change: string;
  oldLines: number;
  newLines: number;
  patch: string;
  binary?: boolean;
}
export interface RangeInput {
  label: string;
  files: readonly RangeFile[];
  truncated: boolean;
  notes: readonly string[];
}

const clip = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max)}\n…（内容已截断）`;

/** Prompt for one frozen range; every file carries its exact side line counts so findings can be validated. */
export function buildReviewPrompt(input: RangeInput, requirements?: string): string {
  const lines: string[] = [
    "你是独立的只读代码审查者。只审查下面这份固定范围的改动，不要扩大范围，不要修改任何文件。",
    "",
    `范围：${input.label}`,
    `文件数：${input.files.length}${input.truncated ? "（范围内容过长，已按预算截断，请在 coverage.notes 里说明）" : ""}`,
    "",
    "每个文件都给出两侧的真实行数；报告的 line 必须是该 side 上的真实行号。",
    "",
  ];
  for (const file of input.files) {
    lines.push(`### ${file.path}（${file.change}，old lines ${file.oldLines}，new lines ${file.newLines}）`);
    lines.push(file.binary ? "（二进制或非文本文件，仅有元数据）" : "```diff");
    if (!file.binary) lines.push(clip(file.patch.replace(/\n$/, ""), 12_000));
    if (!file.binary) lines.push("```");
    lines.push("");
  }
  if (input.notes.length) {
    lines.push("已知覆盖限制：");
    for (const note of input.notes) lines.push(`- ${note}`);
    lines.push("");
  }
  if (requirements?.trim()) {
    lines.push("附加要求（优先满足）：", requirements.trim(), "");
  }
  lines.push(
    "优先报告真实缺陷：正确性、安全、并发、资源释放、跨模块契约。没有发现就如实报告并说明检查范围与限制。",
    "",
    "只输出一个 JSON 代码块，不要其它文字，格式：",
    "```json",
    JSON.stringify({
      findings: [{
        path: "src/example.ts", side: "new", line: 12, severity: "high",
        title: "一句话问题", evidence: "实际读到的代码/命令输出与触发条件", confidence: "verified",
      }],
      coverage: { files: input.files.length, notes: ["未能验证的部分"] },
    }, null, 0),
    "```",
    "side 只能是 old 或 new；severity 只能是 high/medium/low；confidence 只能是 verified/inferred。",
    "二进制或没有行数据的文件只接受 line 0 的文件级问题。",
  );
  return lines.join("\n");
}

interface ParseResult {
  findings: ReviewFinding[];
  rejected: ReviewRejected[];
  coverageNotes: string[];
  malformed: boolean;
}

const severity = (value: unknown): ReviewFinding["severity"] | undefined =>
  typeof value === "string" && (REVIEW_SEVERITIES as readonly string[]).includes(value) ? value as ReviewFinding["severity"] : undefined;
const confidence = (value: unknown): ReviewConfidence | undefined =>
  value === "verified" || value === "inferred" ? value : undefined;
const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/** Validates every reported issue against the frozen range; nothing is dropped silently. */
export function parseReviewReport(report: string, input: Pick<RangeInput, "files">, idOf: (index: number) => string): ParseResult {
  const rejected: ReviewRejected[] = [];
  const findings: ReviewFinding[] = [];
  const coverageNotes: string[] = [];
  const block = /```json\s*([\s\S]*?)```/i.exec(report) ?? /(\{[\s\S]*"findings"[\s\S]*\})/.exec(report);
  if (!block) return { findings, rejected: [{ reason: "报告里没有找到 JSON 结果块。", raw: clip(report.trim(), 300) }], coverageNotes, malformed: true };
  let parsed: unknown;
  try { parsed = JSON.parse(block[1]); }
  catch { return { findings, rejected: [{ reason: "JSON 结果块无法解析。", raw: clip(block[1].trim(), 300) }], coverageNotes, malformed: true }; }
  const value = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const files = new Map(input.files.map((file) => [file.path, file]));
  const report2 = (raw: unknown): void => {
    if (!raw || typeof raw !== "object") { rejected.push({ reason: "问题条目不是对象。", raw: clip(JSON.stringify(raw) ?? "", 200) }); return; }
    const entry = raw as Record<string, unknown>;
    const path = text(entry.path, 4_096);
    const file = path ? files.get(path) : undefined;
    if (!path || !file) { rejected.push({ reason: `路径不在本次范围内：${path ?? "（缺失）"}`, raw: clip(JSON.stringify(entry), 300) }); return; }
    const side: ReviewSide | undefined = entry.side === "old" || entry.side === "new" ? entry.side : undefined;
    if (!side) { rejected.push({ reason: `side 必须是 old 或 new：${path}`, raw: clip(JSON.stringify(entry), 300) }); return; }
    const line = typeof entry.line === "number" && Number.isSafeInteger(entry.line) ? entry.line : undefined;
    const limit = side === "old" ? file.oldLines : file.newLines;
    // Files without line data on that side (binary, omitted) accept only file-level findings (line 0).
    const known = line !== undefined && (limit === 0 ? line === 0 : line >= 1 && line <= limit);
    if (!known) {
      rejected.push({ reason: limit === 0
        ? `${path} 的 ${side} 没有行数据，只能报告 line 0：${String(entry.line)}`
        : `${path} 的 ${side} 行号超出范围（1–${limit}）：${String(entry.line)}`, raw: clip(JSON.stringify(entry), 300) });
      return;
    }
    const level = severity(entry.severity);
    const title = text(entry.title, 400);
    const evidence = text(entry.evidence, REVIEW_LIMITS.evidence);
    if (!level || !title || !evidence) { rejected.push({ reason: `缺少 severity/title/evidence：${path}:${line}`, raw: clip(JSON.stringify(entry), 300) }); return; }
    if (findings.length >= REVIEW_LIMITS.findings) return;
    findings.push({ id: idOf(findings.length), path, side, line, severity: level, title,
      evidence, confidence: confidence(entry.confidence) ?? "inferred" });
  };
  if (Array.isArray(value.findings)) for (const entry of value.findings) report2(entry);
  const coverage = value.coverage && typeof value.coverage === "object" ? value.coverage as Record<string, unknown> : undefined;
  if (coverage && Array.isArray(coverage.notes)) for (const note of coverage.notes) {
    const text2 = text(note, 400);
    if (text2) coverageNotes.push(text2);
  }
  return { findings, rejected, coverageNotes, malformed: false };
}
