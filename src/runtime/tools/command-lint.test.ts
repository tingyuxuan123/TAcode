import { describe, expect, it } from "vitest";
import {
  detectEqualsWordMisuse,
  detectRipgrepReplaceMisuse,
  lintShellCommand,
  splitCommandSegments,
} from "./command-lint";

describe("splitCommandSegments", () => {
  it("按未加引号的分隔符切段，并保持引号内的内容完整", () => {
    const segments = splitCommandSegments('rg -n "a|b" src && echo "x;y" | wc -l');
    expect(segments.map((segment) => segment.words.map((word) => word.text))).toEqual([
      ["rg", "-n", "a|b", "src"],
      ["echo", "x;y"],
      ["wc", "-l"],
    ]);
  });

  it("把重定向留在词内", () => {
    expect(splitCommandSegments("pnpm test 2>&1 | tail -5").map((segment) => segment.words.map((word) => word.text))).toEqual([
      ["pnpm", "test", "2>&1"],
      ["tail", "-5"],
    ]);
  });
});

describe("detectRipgrepReplaceMisuse", () => {
  it("把 -rn 解析成 -r n，并给出想要的命令", () => {
    const [misuse] = detectRipgrepReplaceMisuse('rg -rn "webview" src');
    expect(misuse).toBeDefined();
    expect(misuse!.cluster).toBe("-rn");
    expect(misuse!.replacement).toBe("n");
    expect(misuse!.parsed).toBe('rg -r n "webview" src');
    expect(misuse!.intended).toBe('rg -n "webview" src');
  });

  it("识别 -rni 这类多字母簇", () => {
    const [misuse] = detectRipgrepReplaceMisuse('rg -rni "x" .');
    expect(misuse!.cluster).toBe("-rni");
    expect(misuse!.parsed).toBe('rg -r ni "x" .');
    expect(misuse!.intended).toBe('rg -ni "x" .');
  });

  it("单独的 -r 会吃掉下一个参数作为替换文本", () => {
    const [misuse] = detectRipgrepReplaceMisuse('rg -r n "x" .');
    expect(misuse!.replacement).toBe("n");
    expect(misuse!.parsed).toBe('rg -r n "x" .');
    expect(misuse!.intended).toBe('rg -n "x" .');
  });

  it("不误伤 grep -rn（递归搜索）", () => {
    expect(detectRipgrepReplaceMisuse('grep -rn "x" src')).toEqual([]);
  });

  it("忽略引号内的旗标文本", () => {
    expect(detectRipgrepReplaceMisuse('rg -n "-rn" src')).toEqual([]);
  });

  it("不干预显式的 --replace", () => {
    expect(detectRipgrepReplaceMisuse('rg --replace=n -n "x" .')).toEqual([]);
  });
});

describe("detectEqualsWordMisuse", () => {
  it("识别裸词 === 与 =cmd", () => {
    expect(detectEqualsWordMisuse("echo ===").map((item) => item.word)).toEqual(["==="]);
    expect(detectEqualsWordMisuse("echo ==").map((item) => item.word)).toEqual(["=="]);
    expect(detectEqualsWordMisuse("=foo --version").map((item) => item.word)).toEqual(["=foo"]);
  });

  it("不误伤单个 =、赋值、引号内与被转义的 =", () => {
    expect(detectEqualsWordMisuse("echo =")).toEqual([]);
    expect(detectEqualsWordMisuse("echo a=b")).toEqual([]);
    expect(detectEqualsWordMisuse("echo --x==y")).toEqual([]);
    expect(detectEqualsWordMisuse('echo "===" ')).toEqual([]);
    expect(detectEqualsWordMisuse("echo \\=== ")).toEqual([]);
  });
});

describe("lintShellCommand", () => {
  it("长任务接 tail 时提示管道会吞掉进度", () => {
    const warnings = lintShellCommand("pnpm install 2>&1 | tail -15");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tail/head");
    expect(warnings[0]).toContain("process_id");
    expect(warnings[0]).toContain("rg -n");
  });

  it("npx 之类的长任务也算在内", () => {
    expect(lintShellCommand("npx uni build | tail -25").join("\n")).toContain("tail/head");
  });

  it("rg -r 误用同时给出 warning", () => {
    const warnings = lintShellCommand('rg -rn "webview" src');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("parsed:");
    expect(warnings[0]).toContain('intended: rg -n "webview" src');
  });

  it("zsh 下警告 = 展开，并说清短路后果", () => {
    const warnings = lintShellCommand("ls src && echo === && rg -n x src", { shell: "/bin/zsh" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("zsh expands a bare word");
    expect(warnings[0]).toContain("intended: use quotes — \"===\"");
    expect(warnings[0]).toContain("short-circuits");
  });

  it("bash 下不警告 = 展开（那是正常写法）", () => {
    expect(lintShellCommand("echo ===", { shell: "/bin/bash" })).toEqual([]);
    expect(lintShellCommand("echo ===", { shell: "/bin/sh" })).toEqual([]);
  });

  it("zsh 下警告 $PIPESTATUS 并给出 pipestatus 写法", () => {
    const warnings = lintShellCommand('echo "EXIT=${PIPESTATUS[0]}"', { shell: "/bin/zsh" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bash-only");
    expect(warnings[0]).toContain("${pipestatus[1]}");
  });

  it("bash 下使用 $PIPESTATUS 不告警", () => {
    expect(lintShellCommand('echo "EXIT=${PIPESTATUS[0]}"', { shell: "/bin/bash" })).toEqual([]);
  });

  it("正常搜索与普通管道都不告警", () => {
    expect(lintShellCommand('rg -n "webview" src')).toEqual([]);
    expect(lintShellCommand("echo hi | tail -1")).toEqual([]);
    expect(lintShellCommand("rg -n \"x\" src && echo \">>> done\"")).toEqual([]);
  });
});
