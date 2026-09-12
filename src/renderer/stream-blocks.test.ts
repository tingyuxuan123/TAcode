import { describe, expect, it } from "vitest";
import { parseMarkdownIntoBlocks } from "streamdown";
import { commonPrefixLength, createStreamSegments } from "./stream-blocks";

/** 段边界的累计偏移（不含 0 与末尾），用来核对「段边界一定落在块边界上」。 */
function boundaryOffsets(segments: string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const segment of segments.slice(0, -1)) {
    offset += segment.length;
    offsets.push(offset);
  }
  return offsets;
}

function trueBoundaries(text: string): Set<number> {
  const found = new Set<number>();
  let offset = 0;
  for (const block of parseMarkdownIntoBlocks(text)) {
    offset += block.length;
    found.add(offset);
  }
  return found;
}

/**
 * 分块函数本身会规范化尾部空白（末尾单个空格会变成换行），所以拿它自己的结果当基准，
 * 而不是拿原始输入；这里要保证的是「分段不改变分块语义」。
 */
const expected = (text: string) => parseMarkdownIntoBlocks(text).join("");

const passthrough = { repair: (text: string) => text };

describe("commonPrefixLength", () => {
  it("measures appended text", () => {
    expect(commonPrefixLength("abcdef", "abcdefgh")).toBe(6);
    expect(commonPrefixLength("abcdefgh", "abcdef")).toBe(6);
    expect(commonPrefixLength("", "abc")).toBe(0);
  });

  it("stops at the first difference", () => {
    expect(commonPrefixLength("abcdef", "abcXef")).toBe(3);
    expect(commonPrefixLength("x".repeat(9000) + "a", "x".repeat(9000) + "b")).toBe(9000);
  });
});

describe("createStreamSegments", () => {
  it("splits at block boundaries and concatenates back to the source", () => {
    const text = [
      "第一段。",
      "",
      "第二段，带一个列表：",
      "",
      "- 一",
      "- 二",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "结尾段落。",
    ].join("\n");
    const segments = createStreamSegments({ target: 20, ...passthrough })(text);
    expect(segments.join("")).toBe(expected(text));
    expect(segments.length).toBeGreaterThan(1);
    const boundaries = trueBoundaries(text);
    for (const offset of boundaryOffsets(segments)) expect(boundaries.has(offset)).toBe(true);
  });

  it("keeps the boundary subset invariant while text is appended token by token", () => {
    const source = Array.from({ length: 60 }, (_, index) => [
      `第 ${index} 段：这里是一段说明文字，长度适中，用来把分块推过 target。`,
      "",
      index % 5 === 0 ? "```\ncode\n```" : `- 要点 ${index}\n- 另一个要点`,
      "",
    ].join("\n")).join("");
    const split = createStreamSegments({ target: 200, ...passthrough });
    for (let end = 1; end <= source.length; end += 7) {
      const text = source.slice(0, end);
      const segments = split(text);
      expect(segments.join("")).toBe(expected(text));
      const boundaries = trueBoundaries(text);
      for (const offset of boundaryOffsets(segments)) {
        expect(boundaries.has(offset), `offset ${offset} of ${text.length} is not a block boundary`).toBe(true);
      }
    }
  });

  it("survives randomised appends of markdown-significant characters", () => {
    const pieces = ["段落文字。", "\n", "\n\n", "# 标题", "\n", "- 列表项", "\n", "```", "code", "```", "\n", "| a | b |", "\n", "|---|---|", "\n", "$$", "x^2", "$$", "\n", "**粗体", "**", "\n", "`代码", "`", "\n", "<div>", "</div>"];
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const split = createStreamSegments({ target: 120, ...passthrough });
    let text = "";
    for (let step = 0; step < 400; step += 1) {
      text += pieces[Math.floor(random() * pieces.length)]!;
      const segments = split(text);
      expect(segments.join("")).toBe(expected(text));
      const boundaries = trueBoundaries(text);
      for (const offset of boundaryOffsets(segments)) {
        expect(boundaries.has(offset), `step ${step}: offset ${offset} of ${text.length} is not a block boundary`).toBe(true);
      }
    }
  });

  it("starts over when the text is not an extension of the previous one", () => {
    const split = createStreamSegments({ target: 40, ...passthrough });
    split("第一段内容，够长到可以切成两段，于是边界出现。\n\n第二段内容也一样长，继续撑开分段。\n\n");
    const next = "换了一条消息，内容完全不同，也不该沿用上次的分块。\n\n后续内容。\n\n";
    const replaced = split(next);
    expect(replaced.join("")).toBe(expected(next));
  });

  it("returns the cached result for an unchanged text", () => {
    const split = createStreamSegments({ target: 40, ...passthrough });
    const first = split("一段内容，够长了，应当被切成多段以便观察缓存。\n\n第二段。\n\n");
    expect(split("一段内容，够长了，应当被切成多段以便观察缓存。\n\n第二段。\n\n")).toBe(first);
  });

  it("repairs only the last segment", () => {
    const split = createStreamSegments({ target: 20 });
    const settled = "第一段已经写完，是完整 markdown，不需要任何修补。";
    const segments = split(`${settled}\n\n第二段正在流式，粗体还没闭合：**强调`);
    expect(segments.length).toBeGreaterThan(1);
    // 已定稿的前段保持原样（不被 remend 改动），只有尾段补上了未闭合的粗体标记。
    expect(segments[0]).toBe(settled);
    expect(segments.some((segment) => segment.includes(settled))).toBe(true);
    expect(segments.at(-1)!.endsWith("**")).toBe(true);
  });
});
