import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipForModel, createFileTools } from "./files";
import { Workspace } from "./workspace";

const roots: string[] = [];

async function workspace(): Promise<{ root: string; ws: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), "tacode-files-"));
  roots.push(root);
  const ws = new Workspace(root);
  await ws.initialize();
  return { root, ws };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type ReadDetails = { start: number; end: number; totalLines: number; text: string };

async function readFile(ws: Workspace, params: Record<string, unknown>): Promise<{ text: string; details: ReadDetails }> {
  const tool = createFileTools(ws).find((item) => item.name === "read_file");
  if (!tool) throw new Error("read_file tool is missing");
  const result = (await tool.execute("call-1", params, undefined, undefined as never, {} as never)) as {
    content: Array<{ text?: string }>;
    details: ReadDetails;
  };
  return { text: result.content[0]?.text ?? "", details: result.details };
}

/** 从 read_file 的输出里取出嵌入的行号序列。 */
function embeddedLineNumbers(text: string): number[] {
  return text
    .split("\n")
    .map((line) => /^\s*(\d+)\t/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
}

describe("read_file 读取预算", () => {
  it("大文件按字符预算取连续区间，不留中段空洞", async () => {
    const { root, ws } = await workspace();
    const lines = Array.from({ length: 1_000 }, (_, index) => `const line${index + 1} = "${"x".repeat(80)}";`);
    await writeFile(join(root, "big.ts"), lines.join("\n"));

    const { text, details } = await readFile(ws, { path: "big.ts" });
    expect(text).not.toContain("... output truncated");
    expect(text.length).toBeLessThanOrEqual(6_200);
    const numbers = embeddedLineNumbers(text);
    // 关键回归：编号必须连续递增，不能再出现 97 → 436 的跳跃。
    expect(numbers[0]).toBe(1);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => index + 1));
    expect(details.end).toBe(numbers.at(-1));
    expect(details.end).toBeLessThanOrEqual(details.totalLines);
    expect(text).toMatch(/\[\d+ more line\(s\) omitted \(lines \d+–\d+\); continue from line \d+ with line_start\]/);
  });

  it("从中间续读时同样返回连续区间", async () => {
    const { root, ws } = await workspace();
    const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1} ${"y".repeat(60)}`);
    await writeFile(join(root, "mid.txt"), lines.join("\n"));

    const { text } = await readFile(ws, { path: "mid.txt", line_start: 50 });
    const numbers = embeddedLineNumbers(text);
    expect(numbers[0]).toBe(50);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, index) => 50 + index));
  });

  it("小文件保持原样并保留既有续读提示", async () => {
    const { root, ws } = await workspace();
    // 短行才能在字符预算内放满 500 行的默认窗口。
    const lines = Array.from({ length: 600 }, (_, index) => `l${index + 1}`);
    await writeFile(join(root, "many.txt"), lines.join("\n"));

    const { text, details } = await readFile(ws, { path: "many.txt" });
    expect(text).toContain("[100 more lines; continue from line 501]");
    expect(details.start).toBe(1);
    expect(details.end).toBe(500);
  });

  it("单行超预算时明确说明是哪一行、且两个半段不相邻", async () => {
    const { root, ws } = await workspace();
    await writeFile(join(root, "one-line.json"), `{"data":"${"z".repeat(20_000)}"}`);

    const { text } = await readFile(ws, { path: "one-line.json" });
    expect(text).toContain("not adjacent");
    expect(text).toContain("[line 1 alone exceeds the");
  });
});

describe("search_files 工具", () => {
  it("无 rg 时改用内置搜索，并把原因写在结果里", async () => {
    const { root, ws } = await workspace();
    await writeFile(join(root, "a.ts"), "const needle = 1;\n");
    const tool = createFileTools(ws, { search: { probeRipgrep: () => ({}) } }).find(
      (item) => item.name === "search_files",
    );
    if (!tool) throw new Error("search_files tool is missing");

    const result = (await tool.execute(
      "call-1",
      { query: "needle" },
      undefined,
      undefined as never,
      {} as never,
    )) as { content: Array<{ text?: string }>; details: { engine: string; truncated: boolean } };

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("a.ts:1:const needle = 1;");
    expect(text).toContain("ripgrep (rg) was not found");
    expect(result.details.engine).toBe("builtin");
    expect(result.details.truncated).toBe(false);
  });

  it("context 与 ignore_case 透传到结果，matches 只数命中行", async () => {
    const { root, ws } = await workspace();
    await writeFile(join(root, "a.ts"), ["before", "const NEEDLE = 1;", "after"].join("\n"));
    const tool = createFileTools(ws, { search: { probeRipgrep: () => ({}) } }).find(
      (item) => item.name === "search_files",
    );
    if (!tool) throw new Error("search_files tool is missing");

    const result = (await tool.execute(
      "call-1",
      { query: "needle", ignore_case: true, context: 1 },
      undefined,
      undefined as never,
      {} as never,
    )) as { content: Array<{ text?: string }>; details: { matches: number; truncated: boolean } };

    const text = result.content[0]?.text ?? "";
    expect(text).toContain("a.ts-1-before");
    expect(text).toContain("a.ts:2:const NEEDLE = 1;");
    expect(text).toContain("a.ts-3-after");
    expect(result.details.matches).toBe(1);
    expect(result.details.truncated).toBe(false);
  });

  it("没有命中时仍然返回 (no matches)", async () => {
    const { root, ws } = await workspace();
    await writeFile(join(root, "a.ts"), "nothing here\n");
    const tool = createFileTools(ws, { search: { probeRipgrep: () => ({}) } }).find(
      (item) => item.name === "search_files",
    );
    if (!tool) throw new Error("search_files tool is missing");

    const result = (await tool.execute(
      "call-1",
      { query: "absent-needle" },
      undefined,
      undefined as never,
      {} as never,
    )) as { content: Array<{ text?: string }> };

    expect(result.content[0]?.text ?? "").toContain("(no matches)");
  });
});

describe("clipForModel", () => {
  it("按行截断并报出丢掉的行数与字符数", () => {
    const lines = Array.from({ length: 300 }, (_, index) => `row-${index + 1}-${"c".repeat(90)}`);
    const text = lines.join("\n");

    const clipped = clipForModel(text);
    expect(clipped).toMatch(/\.\.\. output truncated \(\d+ line\(s\) \/ \d+ chars omitted\) \.\.\./u);
    // 不出现半行：头尾每一非空行都能在原文里找到。
    const seen = new Set(lines);
    for (const line of clipped.split("\n")) {
      if (!line || line.startsWith("... output truncated")) continue;
      expect(seen.has(line)).toBe(true);
    }
  });

  it("单行超长时说明两个半段不相邻", () => {
    const clipped = clipForModel(`head${"m".repeat(20_000)}tail`);
    expect(clipped).toContain("not adjacent");
  });

  it("不超预算时原样返回", () => {
    const text = "a\nb\nc";
    expect(clipForModel(text)).toBe(text);
  });
});
