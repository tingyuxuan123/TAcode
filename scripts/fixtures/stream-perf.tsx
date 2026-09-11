import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantTurn } from "../../src/renderer/ui";
import { LocaleProvider } from "../../src/renderer/i18n";
import type { ChatMessage, ToolActivity, WorkItem } from "../../src/renderer/conversation";
import "../../src/renderer/styles.css";

/**
 * 流式渲染性能探针。
 *
 * 用生产组件 `AssistantTurn`（→ ExecutionFlow → useStreamText → Markdown → CodeBlock）
 * 复现主会话流式输出，采集真实渲染进程的帧率、长任务、DOM 变更与落字延迟，
 * 由 `scripts/stream-perf-main.mjs` 采样 CPU 并抓 CDP CPU profile 做归因。
 *
 * 场景（location.hash）：
 * - `reply`：长回复流式（约 7k 字符，含标题/列表/加粗/行内 code/表格）。
 * - `reply-code`：回复内含约 60 行代码块，且代码块在流式早期出现。
 * - `thinking`：长思考流式（约 6k 字符）+ 已完成的工具行。
 * - `long`：40 个历史轮 + 当前轮流式（`?turns=N` 可改历史轮数），检查长会话下的每帧固定开销。
 * - `huge`：约 12k 字符的回复流式，观察长文本下每帧成本随长度增长的趋势。
 *
 * 说明：探针走 `vite build`（React 生产构建）。用户日常 `pnpm dev` 下 StrictMode 会
 * 再翻一倍开销，因此探针数据是同一份代码的保守下界，用于前后对比而非绝对复现。
 */

type Scenario = "reply" | "reply-code" | "thinking" | "long" | "huge";

interface Metrics {
  scenario: Scenario;
  chunkCount: number;
  charCount: number;
  streamMs: number;
  frameCount: number;
  fps: number;
  maxFrameGapMs: number;
  longTaskCount: number;
  longTaskMs: number;
  domAdds: number;
  domRemoves: number;
  codeBlockAdds: number;
  codeBlockRemoves: number;
  renderedChars: number;
  settleLagMs: number;
}

interface ProbeGlobal {
  done: boolean;
  metrics?: Metrics;
}

declare global {
  interface Window {
    __streamPerf: ProbeGlobal;
    harness: unknown;
  }
}

// 探针只用到少数 harness 接口：外链跳转与 `Chat` 的浏览器展示订阅。
window.harness = {
  platform: "darwin",
  app: {
    getLocale: async () => "zh",
    openExternal: async () => undefined,
    version: async () => "0.0.0-probe",
  },
  browser: { onAgentPresentation: () => () => undefined },
};
window.__streamPerf = { done: false };

const PARAGRAPHS = [
  "这里先说结论：问题不在模型侧，而在渲染进程把「每个动画帧」都当成了「一次完整重绘」。页面上看起来只是一小段文字在长出来，渲染进程实际做的事情却是重新解析整段 Markdown、重建整棵子树，再把它们全部交给布局与绘制。",
  "把这条链路拆开看，一共四段：事件到达渲染层、按帧合并后写进状态、Markdown 解析成元素树、React 提交并触发样式与布局。任何一段做了超出「增量」范围的工作，都会被帧率直接放大。",
  "第一段通常不是瓶颈：事件按帧合并之后，一秒钟最多触发几十次状态写入。第二段才是分水岭——如果状态里存的是整段文本，那么每次写入都意味着整段文本要重新走一遍解析管线。",
  "第三条要注意的是布局抖动：滚动跟随需要知道内容高度，而高度只有在布局之后才能拿到。如果在同一帧里反复「写滚动位置 → 读内容高度 → 再写滚动位置」，浏览器就会反复强制同步布局。",
  "第四段是重绘与合成。半透明叠层、模糊背景、阴影这类效果在内容高度持续变化时会被反复重绘，即使它们的视觉内容没变。把这类元素限制在稳定的图层里，能省掉相当一部分合成开销。",
  "还有一个容易被忽略的点：代码高亮。语法高亮器通常是「整段代码 → 全部 token」的一次性计算，没有增量接口。如果每帧都重新高亮一遍，代价与代码长度成正比，而帧与帧之间只有最后几行有变化。",
  "所以优化的落点很清楚：让「解析」与「提交」的次数远低于「帧」的次数，把每帧的工作量压到与增量成正比。判断依据是探针数据，而不是代码观感。",
];

const BULLETS = [
  "按帧合并事件，但不要按帧重解析：解析频率由时间阈值驱动，而不是由帧驱动。",
  "组件的元素类型必须是稳定引用，否则 React 会认为换了类型，卸载并重建整棵子树。",
  "昂贵的派生数据（高亮、度量、格式化）要有缓存键，命中就直接复用。",
  "滚动跟随要一次读完目标位置、一次写入，避免同帧内的读写交替。",
  "长过程里已经冻结的历史项不要参与高频重渲染，签名不变就复用上次结果。",
  "工具结果详情按需渲染，未展开时不产生任何 DOM。",
];

const SECTIONS = ["渲染链路", "事件合并", "解析频率", "布局抖动", "绘制与合成", "代码高亮", "取舍", "验证方式"];

const CODE_LINES = [
  "import { useEffect, useMemo, useRef, useState } from \"react\";",
  "",
  "interface StreamState {",
  "  identity: string;",
  "  text: string;",
  "  streaming: boolean;",
  "}",
  "",
  "export function createStreamScheduler(dispatch: (chunk: string) => void) {",
  "  let pending: string[] = [];",
  "  let frame: number | undefined;",
  "  let disposed = false;",
  "",
  "  const flush = () => {",
  "    frame = undefined;",
  "    if (disposed || pending.length === 0) return;",
  "    const batch = pending;",
  "    pending = [];",
  "    dispatch(batch.join(\"\"));",
  "  };",
  "",
  "  return {",
  "    push(chunk: string) {",
  "      if (disposed) return;",
  "      pending.push(chunk);",
  "      if (frame === undefined) frame = requestAnimationFrame(flush);",
  "    },",
  "    dispose() {",
  "      disposed = true;",
  "      if (frame !== undefined) cancelAnimationFrame(frame);",
  "      pending = [];",
  "    },",
  "  };",
  "}",
  "",
  "export function useStreamText(text: string, streaming: boolean) {",
  "  const [shown, setShown] = useState(text);",
  "  const animator = useRef<{ dispose(): void } | undefined>(undefined);",
  "  if (!animator.current) animator.current = createStreamScheduler(setShown);",
  "  useEffect(() => () => animator.current?.dispose(), []);",
  "  return streaming ? shown : text;",
  "}",
  "",
  "export function nextStreamText(displayed: string, target: string, elapsed: number) {",
  "  if (!target.startsWith(displayed)) return target;",
  "  if (elapsed >= 160) return target;",
  "  const remaining = Array.from(target.slice(displayed.length));",
  "  const take = Math.max(1, Math.ceil(remaining.length / 3));",
  "  return displayed + remaining.slice(0, take).join(\"\");",
  "}",
  "",
  "export function joinThinking(previous: string, incoming: string) {",
  "  const parts = [...previous.split(/\\n{2,}/), ...incoming.split(/\\n{2,}/)];",
  "  return parts.map((part) => part.trim()).filter(Boolean).join(\"\\n\\n\");",
  "}",
];

function buildReply(withCode: boolean, minChars = 7000): string {
  const parts: string[] = ["## 渲染热路径复盘", "", PARAGRAPHS[0]!, ""];
  if (withCode) {
    parts.push("先看参考实现：", "", "```ts", ...CODE_LINES, "```", "");
  }
  for (let section = 0; section < 40 && parts.join("\n").length < minChars; section += 1) {
    parts.push(`### ${SECTIONS[section % SECTIONS.length]}`, "");
    for (let index = 0; index < 3; index += 1) parts.push(PARAGRAPHS[(section * 3 + index + 1) % PARAGRAPHS.length]!, "");
    for (let index = 0; index < 3; index += 1) parts.push(`- ${BULLETS[(section + index) % BULLETS.length]!}`);
    parts.push("");
    parts.push("| 指标 | 变化 | 说明 |", "| --- | --- | --- |", `| 帧耗时 | ${section + 3}ms → 1ms | 解析频率下调后 |`, `| 长任务 | ${section + 1} 个 | 单帧超过 50ms |`, "");
  }
  if (withCode) parts.push("上面那段就是本次要收敛的范围，**判定标准**是 `parseThrottleMs` 与帧率解耦。", "");
  parts.push("### 收尾", "", PARAGRAPHS[6]!, "");
  return parts.join("\n");
}

function buildThinking(minChars = 6000): string {
  const parts: string[] = [];
  for (let round = 0; round < 40 && parts.join("\n").length < minChars; round += 1) {
    parts.push(`第 ${round + 1} 轮核对：`);
    parts.push(PARAGRAPHS[round % PARAGRAPHS.length]!);
    parts.push(`- ${BULLETS[round % BULLETS.length]!}`);
    parts.push("");
  }
  return parts.join("\n");
}

const FIXED_TIME = 1_760_000_000_000;

function tools(): ToolActivity[] {
  return [
    { id: "t1", name: "read", title: "读取文件", status: "complete", startedAt: FIXED_TIME, endedAt: FIXED_TIME + 120, resultRecorded: true, output: "src/renderer/ui.tsx" },
    { id: "t2", name: "search", title: "搜索符号", status: "complete", startedAt: FIXED_TIME + 200, endedAt: FIXED_TIME + 640, resultRecorded: true, output: "3 处匹配" },
    { id: "t3", name: "run", title: "运行命令", status: "complete", startedAt: FIXED_TIME + 700, endedAt: FIXED_TIME + 1800, resultRecorded: true, output: "ok" },
  ];
}

function buildWork(scenario: Scenario, text: string): WorkItem[] {
  const toolItems: WorkItem[] = tools().map((tool) => ({ type: "tool", id: `tool-${tool.id}`, toolId: tool.id }));
  if (scenario !== "thinking") return [{ type: "text", id: "beat-0", text }];
  // 思考流式：最后一项是 thinking，活跃项才会被动画驱动（text 已定稿）。
  return [toolItems[0]!, { type: "text", id: "beat-0", text: "先给出结论，再逐项核对。" }, toolItems[1]!, toolItems[2]!, { type: "thinking", id: "think-0", text }];
}

function historicalTurns(count: number): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (let index = 0; index < count; index += 1) {
    groups.push([{
      id: `assistant-${index}`,
      role: "assistant",
      text: `第 ${index + 1} 轮复盘：把解析频率与帧率解耦之后，这一轮的落字就不再抖动。`,
      streaming: false,
      timestamp: FIXED_TIME + index * 1000,
      images: [],
      tools: [],
      work: [{ type: "text", id: `beat-${index}`, text: `第 ${index + 1} 轮复盘：把解析频率与帧率解耦之后，这一轮的落字就不再抖动。` }, { type: "thinking", id: `think-${index}`, text: PARAGRAPHS[index % PARAGRAPHS.length]! }],
    }]);
  }
  return groups;
}

function Probe({ scenario }: { scenario: Scenario }) {
  const [text, setText] = useState("");
  const work = useMemo(() => buildWork(scenario, text), [scenario, text]);
  const messages = useMemo<ChatMessage[]>(() => [{
    id: "assistant-live",
    role: "assistant",
    text: scenario === "thinking" ? "先给出结论，再逐项核对。" : text,
    streaming: true,
    timestamp: FIXED_TIME,
    images: [],
    tools: scenario === "thinking" ? tools() : [],
    work,
  }], [scenario, text, work]);
  const turns = Number(new URLSearchParams(location.search).get("turns") ?? "") || 40;
  const history = useMemo(() => historicalTurns(scenario === "long" ? turns : 0), [scenario, turns]);
  const canAutoCollapse = useCallback(() => true, []);
  const onOpenFile = useCallback(() => undefined, []);

  useEffect(() => {
    sink = setText;
    return () => { if (sink === setText) sink = undefined; };
  }, []);

  return (
    <div className="app darwin" style={{ height: "100vh", display: "flex" }}>
      <div className="conversation" style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        <div className="messages" data-perf-root>
          {history.map((group, index) => (
            <AssistantTurn key={`history-${index}`} messages={group} canAutoCollapse={canAutoCollapse} onOpenFile={onOpenFile} />
          ))}
          <AssistantTurn messages={messages} running canAutoCollapse={canAutoCollapse} onOpenFile={onOpenFile} />
        </div>
      </div>
    </div>
  );
}

/** 由模块级驱动循环写入，避免 StrictMode 双重挂载把定时器打断。 */
let sink: ((text: string) => void) | undefined;

const scenario = ((): Scenario => {
  const hash = location.hash.replace(/^#/, "");
  return hash === "reply-code" || hash === "thinking" || hash === "long" || hash === "huge" ? hash : "reply";
})();

const full = scenario === "reply-code" ? buildReply(true)
  : scenario === "reply" ? buildReply(false)
    : scenario === "long" ? buildReply(true, 4000)
      : scenario === "huge" ? buildReply(true, 12000)
        : buildThinking();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <Probe scenario={scenario} />
    </LocaleProvider>
  </StrictMode>,
);

const CHUNK_CHARS = 10;
const CHUNK_INTERVAL_MS = 16;

function descendants(root: Node): Element[] {
  const found: Element[] = [];
  const pending: Node[] = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (node instanceof Element && node.classList.contains("code-block-wrapper")) found.push(node);
    node.childNodes.forEach((child) => pending.push(child));
  }
  return found;
}

function start() {
  const chunks: string[] = [];
  for (let index = 0; index < full.length; index += CHUNK_CHARS) chunks.push(full.slice(index, index + CHUNK_CHARS));

  let domAdds = 0;
  let domRemoves = 0;
  let codeBlockAdds = 0;
  let codeBlockRemoves = 0;
  const root = document.querySelector("[data-perf-root]")!;
  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        domAdds += 1;
        codeBlockAdds += descendants(node).length;
      }
      for (const node of Array.from(record.removedNodes)) {
        domRemoves += 1;
        codeBlockRemoves += descendants(node).length;
      }
    }
  });
  mutations.observe(root, { childList: true, subtree: true });

  let longTaskCount = 0;
  let longTaskMs = 0;
  let longTasks: PerformanceObserver | undefined;
  try {
    longTasks = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) { longTaskCount += 1; longTaskMs += entry.duration; }
    });
    longTasks.observe({ entryTypes: ["longtask"] });
  } catch { longTasks = undefined; }

  let frames = 0;
  let maxFrameGapMs = 0;
  let lastFrameAt = 0;
  let raf = 0;
  const countFrame = (now: number) => {
    frames += 1;
    if (lastFrameAt) maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrameAt);
    lastFrameAt = now;
    raf = requestAnimationFrame(countFrame);
  };

  const renderedChars = () => (document.querySelector("[data-perf-root]")?.textContent ?? "").length;

  let index = 0;
  let startedAt = 0;
  let lastChunkAt = 0;
  let done = false;

  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    mutations.disconnect();
    longTasks?.disconnect();
    const streamMs = performance.now() - startedAt;
    const metrics: Metrics = {
      scenario,
      chunkCount: chunks.length,
      charCount: full.length,
      streamMs: Math.round(streamMs),
      frameCount: frames,
      fps: Number((frames / (streamMs / 1000)).toFixed(1)),
      maxFrameGapMs: Math.round(maxFrameGapMs),
      longTaskCount,
      longTaskMs: Math.round(longTaskMs),
      domAdds,
      domRemoves,
      codeBlockAdds,
      codeBlockRemoves,
      renderedChars: renderedChars(),
      settleLagMs: Math.round(performance.now() - lastChunkAt),
    };
    window.__streamPerf = { done: true, metrics };
    // 走控制台通道回传，避免主进程轮询 executeJavaScript 干扰渲染线程。
    console.log(`__STREAM_PERF__${JSON.stringify(metrics)}`);
  };

  const tick = () => {
    if (index >= chunks.length) {
      // 落字收敛：等渲染出的字符数稳定（Markdown 标记会被吃掉，不能与源长度比较）。
      let previous = -1;
      let stableFrames = 0;
      const deadline = performance.now() + 5000;
      const waitSettled = () => {
        const chars = renderedChars();
        stableFrames = chars === previous ? stableFrames + 1 : 0;
        previous = chars;
        if (stableFrames >= 20 || performance.now() > deadline) { finish(); return; }
        requestAnimationFrame(waitSettled);
      };
      waitSettled();
      return;
    }
    const first = index === 0;
    sink?.(chunks.slice(0, ++index).join(""));
    const now = performance.now();
    if (first) { startedAt = now; raf = requestAnimationFrame(countFrame); console.log("__STREAM_PERF_START__"); }
    lastChunkAt = now;
    window.setTimeout(tick, CHUNK_INTERVAL_MS);
  };

  // 等 React 首次挂载与字体/样式稳定后再开始计时。
  window.setTimeout(tick, 600);
}

window.setTimeout(start, 200);
