import { describe, expect, it } from "vitest";
import { collapseThinking } from "./conversation";

/**
 * `collapseThinking` 是流式热路径（每条 `message_update` 都会经 `mergeAssistant` 调它一次）。
 * 2026-09-11 在真实 dev 窗口里采样发现它和 `mergeAssistant` 是 JS 自耗时的第一位——
 * 原实现按空行切块后两两比较前缀，块数平方级（93k 思考 ≈ 848 块）。
 *
 * 优化后（先查等值表、查不到再线性扫）必须与原实现**逐字节一致**，这里用一份
 * 原实现的拷贝做基准，跑随机输入与「追加式快照」两种形态。
 */

/** 原实现（优化前的代码），只作为基准保留在这里。 */
function collapseThinkingReference(...parts: Array<string | undefined>): string {
  const result: string[] = [];
  for (const part of parts) {
    for (const piece of (part ?? "").split(/\n{2,}/)) {
      const text = piece.trim();
      if (!text) continue;
      const index = result.findIndex((item) => item.startsWith(text) || text.startsWith(item));
      if (index < 0) result.push(text);
      else if (text.length > result[index]!.length) result[index] = text;
    }
  }
  return result.join("\n\n");
}

/** 造随机块：覆盖重复块、前缀关系、空白、空块。 */
function piece(random: () => number): string {
  const pool = ["a", "ab", "abc", "abcd", "b", "bc", "思考一段", "思考一段更长的内容", "  spaced  ", "", "\n", "列表\n- 一", "列表\n- 一\n- 二"];
  const head = pool[Math.floor(random() * pool.length)]!;
  return random() < 0.2 ? `${head}${Math.floor(random() * 100)}` : head;
}

function document(random: () => number): string {
  const count = 1 + Math.floor(random() * 6);
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    parts.push(piece(random));
    if (random() < 0.75) parts.push("\n\n");
    if (random() < 0.15) parts.push("\n\n\n");
  }
  return parts.join("");
}

function randomSource(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("collapseThinking", () => {
  it("matches the pairwise reference on randomised documents", () => {
    const random = randomSource(7);
    for (let step = 0; step < 3000; step += 1) {
      const parts = [document(random)];
      if (random() < 0.5) parts.push(document(random));
      expect(collapseThinking(...parts)).toBe(collapseThinkingReference(...parts));
    }
  });

  it("matches the reference for append-only streaming snapshots", () => {
    const random = randomSource(21);
    for (let step = 0; step < 600; step += 1) {
      let text = "";
      for (let round = 0; round < 12; round += 1) {
        text += document(random);
        // 追加式：新快照以旧文本为前缀。
        const previous = text;
        text += piece(random) + "\n\n";
        expect(collapseThinking(previous, text)).toBe(collapseThinkingReference(previous, text));
      }
    }
  });

  it("keeps the documented invariant: no result block is a prefix of another", () => {
    const random = randomSource(99);
    for (let step = 0; step < 500; step += 1) {
      const parts = [document(random), document(random)];
      const blocks = collapseThinking(...parts).split("\n\n").filter(Boolean);
      for (const a of blocks) {
        for (const b of blocks) {
          if (a === b) continue;
          expect(a.startsWith(b), `${JSON.stringify(a)} 是 ${JSON.stringify(b)} 的前缀`).toBe(false);
          expect(b.startsWith(a), `${JSON.stringify(b)} 是 ${JSON.stringify(a)} 的前缀`).toBe(false);
        }
      }
    }
  });

  it("handles the streaming shape: growing last block", () => {
    expect(collapseThinking("第一段\n\n正在写", "第一段\n\n正在写下去")).toBe("第一段\n\n正在写下去");
    expect(collapseThinking("a\n\nb", "a\n\nb\n\nb")).toBe("a\n\nb");
    expect(collapseThinking("a\n\nb", "a\n\nb\n\nc")).toBe("a\n\nb\n\nc");
    expect(collapseThinking(undefined, "只有一段")).toBe("只有一段");
  });
});
