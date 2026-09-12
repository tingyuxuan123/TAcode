import { parseMarkdownIntoBlocks } from "streamdown";
import remend from "remend";

/**
 * 流式文本的「分段」缓存。
 *
 * 背景（2026-09-11 实测，dev React + StrictMode，单条思考累积 90k 字符）：
 * - `Streamdown` 每次渲染都做两件与累积文本成正比的事：`remend()` 修尾（~0.7ms@90k）
 *   和标记级分块 `parseMarkdownIntoBlocks`（~1.9ms@90k）；再加上为「每块一个 Block 组件」
 *   做对账（93k 文本 = 600+ 块），单帧 React 提交从 4k 文本的 1.7ms 涨到 7.2ms（p95 11.9ms）。
 * - 但流式是追加式的：真正在变的只有最后一两个块。真实会话里那条 93,613 字符的思考被空行
 *   切成 848 块，最大块只有 1,934 字符，所以「只有尾部会变」不是近似，而是事实。
 *
 * 这个模块把文本切成**段**（每段由若干完整块拼成，约 `target` 字符），并保证：
 * - 段边界一定落在 markdown 块边界上（复用 Streamdown 自己的分块函数），所以逐段渲染的
 *   DOM 与整段渲染一致：块元素的内容、顺序、边距都不变，只是包的 `Block` 组件少了。
 * - 分块本身也是增量的：只在末尾「倒数两块 + 新内容」这个小窗口里重新分块。
 * - 只有最后一段（可能含未闭合结构）做 `remend` 修补；已定稿的段是完整 markdown，不需要修。
 *
 * 结果：单帧成本从「∝ 累积文本」变成「∝ 最后一段」，与历史长度解耦。
 */

const DEFAULT_TARGET = 1_200;

export interface StreamSegmentsOptions {
  /** 每段目标字符数；越大则组件越少、每帧重解析的段越大。 */
  target?: number;
  /** 分块函数，默认 Streamdown 自己的实现（保证块边界与它一致）。 */
  parse?: (text: string) => string[];
  /** 尾部修补函数，默认 remend。 */
  repair?: (text: string) => string;
}

const parseBlocks = (text: string) => parseMarkdownIntoBlocks(text);
const repairText = (text: string) => remend(text);

/** 追加式文本下的公共前缀长度；用定长切片比较走原生字符串比较，比逐字符快得多。 */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  if (max === 0) return 0;
  if (a.length <= b.length ? b.startsWith(a) : a.startsWith(b)) return max;
  const CHUNK = 4_096;
  let index = 0;
  while (index + CHUNK <= max && a.slice(index, index + CHUNK) === b.slice(index, index + CHUNK)) index += CHUNK;
  while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

/**
 * 创建**有状态**的文本 → 分段函数。每个 `Markdown` 实例持有一个（用 `useRef`），
 * 因为缓存的一生只服务一条持续追加的文本。
 */
export function createStreamSegments(options: StreamSegmentsOptions = {}): (text: string) => string[] {
  const target = options.target ?? DEFAULT_TARGET;
  const parse = options.parse ?? parseBlocks;
  const repair = options.repair ?? repairText;

  let text = "";
  let blocks: string[] = [];
  /** 增量重分块的窗口起点：倒数第二块的起点。窗口之前的块一概复用。 */
  let windowStart = 0;
  let cached: string[] = [];

  const windowOffset = (list: string[], total: number): number =>
    list.length >= 2 ? total - list[list.length - 2]!.length - list[list.length - 1]!.length : 0;

  // 按块边界聚合：满 `target` 就收一段，保证段边界永远是块边界。
  const group = (): string[] => {
    const segments: string[] = [];
    let current = "";
    for (const block of blocks) {
      current += block;
      if (current.length >= target) {
        segments.push(current);
        current = "";
      }
    }
    if (current || !segments.length) segments.push(current);
    return segments;
  };

  // 只有最后一段可能是未闭合的 markdown，只有它需要修补。
  const emit = (segments: string[]): string[] => {
    const last = segments.at(-1);
    if (last === undefined) return segments;
    const fixed = repair(last);
    if (fixed === last) return segments;
    const next = segments.slice();
    next[next.length - 1] = fixed;
    return next;
  };

  const rebuild = (input: string): void => {
    blocks = parse(input);
    text = input;
    windowStart = windowOffset(blocks, input.length);
  };

  return (input: string): string[] => {
    if (input === text && cached.length) return cached;

    const extend = text.length > 0
      && blocks.length >= 2
      && input.length >= text.length
      && commonPrefixLength(text, input) >= windowStart;

    if (extend) {
      // 窗口内可能发生的合并（`$$` 配对、HTML 容器、围栏收尾）都落在最后两块里，
      // 所以只重算它们；窗口起点之前的内容保持字节不变。
      const rebuilt = parse(input.slice(windowStart));
      blocks = [...blocks.slice(0, blocks.length - 2), ...rebuilt];
      text = input;
      windowStart = windowOffset(blocks, input.length);
    } else {
      rebuild(input);
    }

    cached = emit(group());
    return cached;
  };
}
