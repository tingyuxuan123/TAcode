/**
 * 搜索后端：rg 探测优先级、无 rg 时的内置兜底、以及 limit 的真实总量语义。
 */

import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeRipgrep, searchWorkspace, type SearchOutcome } from "./search";

const roots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 强制走内置兜底：假装机器上没有 rg。 */
const builtinOnly = { probeRipgrep: () => ({}) };

async function builtinSearch(
  root: string,
  params: Partial<Parameters<typeof searchWorkspace>[0]> = {},
): Promise<SearchOutcome> {
  return searchWorkspace(
    {
      root,
      searchPath: root,
      query: "needle",
      literal: false,
      ignoreCase: false,
      context: 0,
      limit: 200,
      ...params,
    },
    builtinOnly,
  );
}

/** 默认走真实 rg；机器上没有 rg 时这些用例会被跳过。 */
async function rgSearch(
  root: string,
  params: Partial<Parameters<typeof searchWorkspace>[0]> = {},
): Promise<SearchOutcome> {
  return searchWorkspace({ root, searchPath: root, query: "needle", literal: false, ignoreCase: false, context: 0, limit: 200, ...params });
}

async function makeFakeExecutable(file: string): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
}

describe("probeRipgrep", () => {
  it("TACODE_RG_PATH 指向可执行文件时优先使用", async () => {
    const root = await tempDir("tacode-rg-");
    const fake = join(root, "my-rg");
    await makeFakeExecutable(fake);

    expect(probeRipgrep({ env: { TACODE_RG_PATH: fake, PATH: "" } })).toEqual({
      command: fake,
      source: "env",
    });
  });

  it("TACODE_RG_PATH 失效时不静默回退到 PATH", async () => {
    const root = await tempDir("tacode-rg-");
    const missing = join(root, "not-there");
    const onPath = join(root, "bin", "rg");
    await makeFakeExecutable(onPath);

    expect(probeRipgrep({ env: { TACODE_RG_PATH: missing, PATH: join(root, "bin") } })).toEqual({
      invalidOverride: missing,
    });
  });

  it("PATH 命中", async () => {
    const root = await tempDir("tacode-rg-");
    const rg = join(root, "bin", "rg");
    await makeFakeExecutable(rg);

    expect(probeRipgrep({ env: { PATH: join(root, "bin") } })).toEqual({ command: rg, source: "path" });
  });

  it("PATH 未命中时回退到已知安装目录", async () => {
    const home = await tempDir("tacode-home-");
    const rg = join(home, ".cargo", "bin", "rg");
    await makeFakeExecutable(rg);

    expect(probeRipgrep({ env: { PATH: "", HOME: home } })).toEqual({
      command: rg,
      source: "known-directory",
    });
  });

  it("全都找不到时返回空结果（调用方走内置搜索）", () => {
    // win32 下探测的是 rg.exe，因此已知目录里真实的 rg 不会被误命中。
    expect(probeRipgrep({ env: { PATH: "", HOME: "/nonexistent" }, platform: "win32" })).toEqual({});
  });
});

describe("searchWorkspace 的内置兜底", () => {
  it("按 path:line:text 返回命中并说明为什么没用 rg", async () => {
    const root = await tempDir("tacode-search-");
    await writeFile(join(root, "a.ts"), ["const x = 1;", "const needle = 2;", "const y = 3;"].join("\n"));

    const outcome = await builtinSearch(root);

    expect(outcome.engine).toBe("builtin");
    expect(outcome.lines).toEqual(["a.ts:2:const needle = 2;"]);
    expect(outcome.truncated).toBe(false);
    expect(outcome.notes.join(" ")).toContain("ripgrep (rg) was not found");
  });

  it("limit 是所有文件合计的总量上限，而不是每个文件一条", async () => {
    const root = await tempDir("tacode-search-");
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await writeFile(join(root, name), ["needle 1", "needle 2", "needle 3"].join("\n"));
    }

    const outcome = await builtinSearch(root, { limit: 4 });

    expect(outcome.lines).toHaveLength(4);
    expect(outcome.truncated).toBe(true);
    expect(outcome.notes.join(" ")).toContain("Only the first 4 matches are shown");
  });

  it("命中数正好等于 limit 时不算截断", async () => {
    const root = await tempDir("tacode-search-");
    await writeFile(join(root, "a.txt"), ["needle 1", "needle 2"].join("\n"));

    const outcome = await builtinSearch(root, { limit: 2 });

    expect(outcome.lines).toHaveLength(2);
    expect(outcome.truncated).toBe(false);
    expect(outcome.notes.join(" ")).not.toContain("Only the first");
  });

  it("默认跳过 node_modules 等生成目录", async () => {
    const root = await tempDir("tacode-search-");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "needle\n");
    await writeFile(join(root, "src.ts"), "needle\n");

    const outcome = await builtinSearch(root);

    expect(outcome.lines).toEqual(["src.ts:1:needle"]);
  });

  it("glob 过滤按 basename 匹配任意层级", async () => {
    const root = await tempDir("tacode-search-");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "needle\n");
    await writeFile(join(root, "src", "a.md"), "needle\n");

    const outcome = await builtinSearch(root, { glob: "*.ts" });

    expect(outcome.lines).toEqual(["src/a.ts:1:needle"]);
  });

  it("literal 模式下正则元字符按字面量处理", async () => {
    const root = await tempDir("tacode-search-");
    await writeFile(join(root, "a.txt"), ["a.c", "abc"].join("\n"));

    expect((await builtinSearch(root, { query: "a.c", literal: true })).lines).toEqual(["a.txt:1:a.c"]);
    expect((await builtinSearch(root, { query: "a.c" })).lines).toEqual(["a.txt:1:a.c", "a.txt:2:abc"]);
  });

  it("path 指向单个文件时只搜该文件", async () => {
    const root = await tempDir("tacode-search-");
    await writeFile(join(root, "a.txt"), "needle\n");
    await writeFile(join(root, "b.txt"), "needle\n");

    const outcome = await builtinSearch(root, { searchPath: join(root, "b.txt") });

    expect(outcome.lines).toEqual(["b.txt:1:needle"]);
  });

  it("跳过二进制文件", async () => {
    const root = await tempDir("tacode-search-");
    await writeFile(join(root, "bin.dat"), Buffer.from("needle\0binary"));
    await writeFile(join(root, "text.txt"), "needle\n");

    const outcome = await builtinSearch(root);

    expect(outcome.lines).toEqual(["text.txt:1:needle"]);
  });

  it("非法正则给出可读错误", async () => {
    const root = await tempDir("tacode-search-");
    await expect(builtinSearch(root, { query: "([unclosed" })).rejects.toThrow(/Invalid regular expression/);
  });

  it("ignore_case 在字面量与正则两种模式下都生效", async () => {
    const root = await tempDir("tacode-search-");
    await writeFile(join(root, "a.txt"), ["NEEDLE", "needle", "NeEdLe"].join("\n"));

    expect((await builtinSearch(root)).matches).toBe(1);
    expect((await builtinSearch(root, { ignoreCase: true })).matches).toBe(3);
    expect((await builtinSearch(root, { literal: true, query: "NEEDLE", ignoreCase: true })).matches).toBe(3);
  });

  it("context 输出命中前后的行，格式与 ripgrep 一致", async () => {
    const root = await tempDir("tacode-search-");
    await writeFile(join(root, "a.txt"), ["before", "needle", "after", "tail"].join("\n"));

    const outcome = await builtinSearch(root, { context: 1 });

    expect(outcome.lines).toEqual(["a.txt-1-before", "a.txt:2:needle", "a.txt-3-after"]);
    expect(outcome.matches).toBe(1);
  });

  it("相邻命中的上下文窗口合并且不重复，间隔处插分隔行", async () => {
    const root = await tempDir("tacode-search-");
    // 命中在 1 / 3 / 10 行，context=2 时前两个窗口重叠、第三个与它们之间有空隙。
    const content = ["needle 1", "x", "needle 2", "y", "y", "y", "y", "z", "z", "needle 3"];
    await writeFile(join(root, "a.txt"), content.join("\n"));

    const outcome = await builtinSearch(root, { context: 2 });

    expect(outcome.lines).toEqual([
      "a.txt:1:needle 1",
      "a.txt-2-x",
      "a.txt:3:needle 2",
      "a.txt-4-y",
      "a.txt-5-y",
      "--",
      "a.txt-8-z",
      "a.txt-9-z",
      "a.txt:10:needle 3",
    ]);
    expect(outcome.matches).toBe(3);
  });

  it("limit 只数命中行，不数上下文行", async () => {
    const root = await tempDir("tacode-search-");
    await writeFile(join(root, "a.txt"), ["needle 1", "b", "needle 2", "c", "needle 3"].join("\n"));

    const outcome = await builtinSearch(root, { context: 1, limit: 2 });

    expect(outcome.matches).toBe(2);
    expect(outcome.truncated).toBe(true);
    expect(outcome.notes.join(" ")).toContain("Only the first 2 matches are shown");
  });

  it("超长行裁到 500 字符并给出提示", async () => {
    const root = await tempDir("tacode-search-");
    await writeFile(join(root, "min.js"), `var a=1;needle${"x".repeat(2_000)};`);

    const outcome = await builtinSearch(root);

    const line = outcome.lines[0] ?? "";
    expect(line).toContain("needle");
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThan(600);
    expect(outcome.truncated).toBe(true);
    expect(outcome.notes.join(" ")).toContain("truncated to 500 chars");
  });
});

const hasRipgrep = Boolean(probeRipgrep().command);

describe.skipIf(!hasRipgrep)("searchWorkspace 的 ripgrep 路径", () => {
  it("同样遵守总量上限，并标记仍有更多命中", async () => {
    const root = await tempDir("tacode-search-");
    const lines = Array.from({ length: 50 }, (_, index) => `needle ${index + 1}`);
    await writeFile(join(root, "a.txt"), lines.join("\n"));

    const outcome = await rgSearch(root, { limit: 3 });

    expect(outcome.engine).toBe("ripgrep");
    expect(outcome.lines).toHaveLength(3);
    expect(outcome.matches).toBe(3);
    expect(outcome.truncated).toBe(true);
  });

  it("结果路径相对工作区，且遵守默认忽略目录", async () => {
    const root = await tempDir("tacode-search-");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "needle\n");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "needle\n");

    const outcome = await rgSearch(root);

    expect(outcome.lines).toEqual(["src/a.ts:1:needle"]);
  });

  it("只搜单个文件时也带路径前缀", async () => {
    const root = await tempDir("tacode-search-");
    await writeFile(join(root, "b.txt"), "needle\n");
    await writeFile(join(root, "a.txt"), "needle\n");

    const outcome = await rgSearch(root, { searchPath: join(root, "b.txt") });

    expect(outcome.lines).toEqual(["b.txt:1:needle"]);
  });

  it("路径含 `-数字-`（如日期文件名）时上下文仍可解析", async () => {
    const root = await tempDir("tacode-search-");
    await writeFile(join(root, "report-2024-01-01.md"), ["before", "needle", "after"].join("\n"));

    const outcome = await rgSearch(root, { context: 1 });

    expect(outcome.lines).toEqual([
      "report-2024-01-01.md-1-before",
      "report-2024-01-01.md:2:needle",
      "report-2024-01-01.md-3-after",
    ]);
    expect(outcome.matches).toBe(1);
  });

  it("ignore_case 与 literal 都能生效", async () => {
    const root = await tempDir("tacode-search-");
    await writeFile(join(root, "a.txt"), ["NEEDLE", "needle", "a.c"].join("\n"));

    expect((await rgSearch(root, { ignoreCase: true, limit: 5 })).matches).toBe(2);
    expect((await rgSearch(root, { query: "a.c", literal: true })).lines).toEqual(["a.txt:3:a.c"]);
  });

  it("与内置搜索产出完全一致的上下文输出", async () => {
    const root = await tempDir("tacode-search-");
    const content = ["needle 1", "x", "needle 2", "y", "y", "y", "y", "z", "z", "needle 3"];
    await writeFile(join(root, "a.txt"), content.join("\n"));

    const viaRg = await rgSearch(root, { context: 2 });
    const viaBuiltin = await builtinSearch(root, { context: 2 });

    // 两个后端必须给出同一份文本，模型和界面看到的格式才不会随机器变化。
    expect(viaRg.lines).toEqual(viaBuiltin.lines);
    expect(viaRg.matches).toBe(viaBuiltin.matches);
  });
});
