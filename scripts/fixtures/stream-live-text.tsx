import { Profiler, StrictMode, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ProfilerOnRenderCallback, type RefObject } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Streamdown } from "streamdown";
import { LocaleProvider } from "../../src/renderer/i18n";
import { MARKDOWN_COMPONENTS, MARKDOWN_REHYPE_PLUGINS, MARKDOWN_REMARK_PLUGINS, Markdown } from "../../src/renderer/ui";
import { highlightToTokens, isHighlighterReady } from "../../src/renderer/shiki";
import "../../src/renderer/styles.css";

/**
 * 流式落字路径探针（可视化版）。
 *
 * 目的：能**亲眼看**到同一段文本、同一个每帧字数下，「整段分块」（旧）与
 * 「分段渲染」（新，见 src/renderer/stream-blocks.ts）的每帧开销差多少。
 *
 * 两种用法：
 * 1. 看：点「开始流式」——按 60fps 往思考卡片里累计文本，屏幕顶部实时显示
 *    帧间隔 p50/p95/最长、React 提交耗时、长帧数；随时切「旧路径 / 新路径」对比。
 * 2. 量：点「跑对照测量」——对 4k/30k/90k × 16/48 字两种路径各跑一遍 `flushSync`
 *    同步提交 + 强制布局，把 React 与布局分开计时，结果落到下方表格。
 *
 * 为什么量的时候不用帧间隔：60fps 的垂直同步会把 16ms 以内的开销全部抹平，
 * 90k 文本下每帧 5ms 和 0.5ms 在帧间隔上完全一样。所以量化用同步提交，
 * 观感用 rAF 间隔，两者分开看。
 *
 * 用法（不要在生产构建里看，dev 才是你日常的环境）：
 *   pnpm exec vite --port 5199
 *   打开 http://127.0.0.1:5199/scripts/fixtures/stream-live-text.html
 */

const T0 = 1_760_000_000_000;

/** 一行一条的真实思考形状：长短句混合、少量列表与围栏、每 9 行一个空行。 */
const LINE_POOL = [
  "先把结论说清楚：卡的是渲染进程主线程，不是网络，也不是模型出字速度。",
  "每次事件到达都会把整棵消息列表重新过一遍，历史越长，每帧的固定开销越高。",
  "窗口化之后一帧里只有视口附近的那几条真正渲染，成本与可见范围相关，与历史长度无关。",
  "这里要确认的是落字路径本身的成本是否随累积文本线性增长。",
  "如果增长成立，那么任何与内容体量无关的优化（例如给外壳加 memo）都只是次要项。",
  "反过来，如果不增长，就得回到「外壳每帧重渲染」那条线上继续查。",
  "先量再改：这一轮只测一个变量，其他条件（每帧字数、组件链路）全部固定。",
  "测量方式是用同步提交加强制布局近似一帧的主线程成本，而不是看帧间隔。",
  "长任务用 PerformanceObserver 收集，能看出有没有单帧超过 50ms 的卡顿。",
  "注意 dev 构建与生产构建的差距：dev 下每次渲染会多跑一遍校验，StrictMode 还会双跑。",
  "真实会话里单条思考最长量到过 93,613 字符、3,192 个换行。",
  "正文（最终回复）最长只有 6,457 字符，所以思考条目才是体量所在。",
  "落地手段大致三类：只渲染尾部、把已完成的块冻结、把流式状态移出 App。",
  "无论走哪条，判断依据都应该是这里的数字，而不是探针在生产构建下跑出来的漂亮结果。",
  "最后要能在真实会话里用一次，带上侧边栏、输入区、右面板全开。",
];

function genText(chars: number): string {
  const parts: string[] = [];
  let length = 0;
  let index = 0;
  while (length < chars) {
    index += 1;
    if (index % 97 === 0) {
      // 真实输出里的代码块常常超过代码区高度（280px），要造够长才能看出内部跟随。
      const body = Array.from({ length: 30 }, (_, line) => `  const step${line} = applyAgentEvent(current, event${line});`);
      parts.push("```ts", ...body, "return next;", "```");
      length += body.reduce((sum, line) => sum + line.length + 1, 0) + 14;
      continue;
    }
    if (index % 9 === 0) {
      parts.push("");
      length += 1;
      continue;
    }
    const line = LINE_POOL[index % LINE_POOL.length]!;
    const rendered = index % 53 === 0 ? `- ${line}` : line;
    parts.push(rendered);
    length += rendered.length + 1;
  }
  return parts.join("\n");
}

function chunkText(index: number, chunk: number): string {
  const seed = `片段${index}：落字成本要跟着累积长度一起量。`;
  let out = "";
  while (out.length < chunk) out += seed;
  return out.slice(0, chunk);
}

/** 可见流式专用的增量：像真实输出那样断行，否则尾部会永远卡在一个未闭合围栏里。 */
function liveChunk(index: number, chunk: number): string {
  const line = chunkText(index, chunk);
  return index % 11 === 0 ? `${line}\n\n` : `${line}\n`;
}

type Mode = "legacy" | "segmented";

const MODE_LABEL: Record<Mode, string> = {
  legacy: "旧路径（整段分块）",
  segmented: "新路径（分段渲染）",
};

interface Sample {
  p50: number;
  p95: number;
  max: number;
}

const quantile = (values: number[], q: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return Number(sorted[at]!.toFixed(2));
};
const sample = (values: number[]): Sample => ({
  p50: quantile(values, 0.5),
  p95: quantile(values, 0.95),
  max: Number(Math.max(0, ...values).toFixed(2)),
});

/**
 * 折叠态的静态渲染成本：思考条目不再是当前项时，`Markdown` 会切到 `streaming={false}`，
 * 走三个全文预处理器 + Streamdown static 整段解析。这里单独量这一帧。
 */
const staticProbe: { render?: (text: string) => Promise<{ chars: number; react: number; layout: number }> } = {};

/** 工具输出/文件详情的高亮代价：`useShikiTokens` 没有节流，代码每变一次就同步分词一次。 */
async function highlightProbe(chars: number, runs = 8) {
  const lines: string[] = [];
  let length = 0;
  let index = 0;
  while (length < chars) {
    index += 1;
    const line = `  const value${index} = applyAgentEvent(current, event${index}); // 读取文件结果里的普通一行代码`;
    lines.push(line);
    length += line.length + 1;
  }
  const code = lines.join("\n");
  for (let i = 0; i < 200 && !isHighlighterReady(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const values: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    highlightToTokens(code, "ts", "dark");
    values.push(performance.now() - started);
  }
  values.sort((a, b) => a - b);
  return { chars: code.length, lines: lines.length, ready: isHighlighterReady(), p50: Number((values[Math.floor(values.length / 2)] ?? 0).toFixed(2)), max: Number((values.at(-1) ?? 0).toFixed(2)) };
}

/** 旧路径：就是改造前 `Markdown` 在流式时交给 Streamdown 的那组 props。 */
function LegacyMarkdown({ children }: { children: string }) {
  return (
    <Streamdown
      mode="streaming"
      parseIncompleteMarkdown
      controls={false}
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {children}
    </Streamdown>
  );
}

/** 新路径：真实组件（内部走 createStreamSegments 分段）。 */
function SegmentedMarkdown({ children }: { children: string }) {
  return <Markdown streaming>{children}</Markdown>;
}

/** 实时读数：只由驱动函数通过 ref 写 DOM，自己永不重渲染，避免读数本身影响测量。 */
const Readout = memo(function Readout({ refs }: {
  refs: {
    chars: RefObject<HTMLSpanElement | null>;
    frames: RefObject<HTMLSpanElement | null>;
    react: RefObject<HTMLSpanElement | null>;
    long: RefObject<HTMLSpanElement | null>;
    mode: RefObject<HTMLSpanElement | null>;
    follow: RefObject<HTMLSpanElement | null>;
    note: RefObject<HTMLSpanElement | null>;
  };
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "18px", padding: "10px 14px", background: "#f5f2ec", borderBottom: "1px solid #d9d2c6", font: "12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace", color: "#2f2a24" }}>
      <span>路径 <b ref={refs.mode}>—</b></span>
      <span>累积字数 <b ref={refs.chars}>—</b></span>
      <span>帧间隔 p50/p95/最长 <b ref={refs.frames}>—</b></span>
      <span>React 提交 p50/p95 <b ref={refs.react}>—</b></span>
      <span>长帧(&gt;20ms) <b ref={refs.long}>0</b></span>
      <span>跟随 <b ref={refs.follow}>—</b></span>
      <span style={{ color: "#7a7268" }} ref={refs.note} />
    </div>
  );
});

interface Row {
  id: string;
  mode: Mode;
  startChars: number;
  chunk: number;
  react: Sample;
  layout: Sample;
  total: Sample;
  longTasks: number;
  longMs: number;
}

const driver: {
  push?: (text: string) => void;
  profile?: { collecting: boolean; durations: number[] };
} = {};

function Harness() {
  const [mode, setMode] = useState<Mode>("segmented");
  const [text, setText] = useState(() => genText(30_000));
  const [startChars, setStartChars] = useState(30_000);
  const [chunk, setChunk] = useState(16);
  const [streaming, setStreaming] = useState(false);
  const [followOn, setFollowOn] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  const textRef = useRef(text);
  const modeRef = useRef(mode);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const chars = useRef<HTMLSpanElement>(null);
  const frames = useRef<HTMLSpanElement>(null);
  const reactOut = useRef<HTMLSpanElement>(null);
  const longOut = useRef<HTMLSpanElement>(null);
  const modeOut = useRef<HTMLSpanElement>(null);
  const followOut = useRef<HTMLSpanElement>(null);
  const note = useRef<HTMLSpanElement>(null);
  const follow = useRef(true);
  follow.current = followOn;

  driver.push = (next) => {
    textRef.current = next;
    setText(next);
  };
  driver.profile = driver.profile ?? { collecting: false, durations: [] };
  modeRef.current = mode;

  const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    const profile = driver.profile!;
    if (profile.collecting) profile.durations.push(actualDuration);
  };

  // 跟随要写在提交之后：layout effect 在 DOM 更新后、绘制前跑，读到的是新高度。
  // 写在 rAF 里（提交之前）会永远差一帧的新增量，看起来就是「没跟随」。
  useLayoutEffect(() => {
    if (!follow.current) return;
    const view = scroller.current;
    if (view) view.scrollTop = view.scrollHeight;
  }, [text]);

  // ---- 观感：rAF 驱动的可见流式，帧间隔与提交耗时实时上屏 ----
  const live = useRef({ raf: 0, index: 0, last: 0, intervals: [] as number[], durations: [] as number[], long: 0 });

  const refresh = useCallback(() => {
    const state = live.current;
    if (chars.current) chars.current.textContent = textRef.current.length.toLocaleString("en-US");
    if (modeOut.current) modeOut.current.textContent = MODE_LABEL[modeRef.current];
    const recent = state.intervals.slice(-180);
    if (frames.current) {
      frames.current.textContent = recent.length
        ? `${quantile(recent, 0.5).toFixed(1)} / ${quantile(recent, 0.95).toFixed(1)} / ${Math.max(...recent).toFixed(1)} ms`
        : "—";
      const p95 = quantile(recent, 0.95);
      frames.current.style.color = !recent.length ? "" : p95 < 20 ? "#1d5c3a" : p95 < 34 ? "#8a5a12" : "#a03030";
    }
    const view = scroller.current;
    if (followOut.current && view) {
      const fromBottom = Math.round(view.scrollHeight - view.scrollTop - view.clientHeight);
      followOut.current.textContent = follow.current ? `开（距底 ${fromBottom}px）` : `关（距底 ${fromBottom}px）`;
    }
    const commits = state.durations.slice(-180);
    if (reactOut.current) reactOut.current.textContent = commits.length
      ? `${quantile(commits, 0.5).toFixed(2)} / ${quantile(commits, 0.95).toFixed(2)} ms`
      : "—";
    if (longOut.current) longOut.current.textContent = String(state.long);
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(live.current.raf);
    live.current.raf = 0;
    setStreaming(false);
    if (note.current) note.current.textContent = "已停止";
  }, []);

  const start = useCallback(() => {
    if (live.current.raf) cancelAnimationFrame(live.current.raf);
    driver.push!(genText(startChars));
    live.current.index = 0;
    live.current.intervals = [];
    live.current.durations = [];
    live.current.long = 0;
    live.current.last = 0;
    driver.profile!.durations = [];
    driver.profile!.collecting = true;
    setStreaming(true);
    if (note.current) note.current.textContent = "流式中：每帧追加文本，数字是最近 180 帧的滚动统计";
    const tick = () => {
      const state = live.current;
      const now = performance.now();
      if (state.last) {
        const delta = now - state.last;
        state.intervals.push(delta);
        if (delta > 20) state.long += 1;
        if (state.intervals.length > 600) state.intervals.splice(0, 300);
      }
      state.last = now;
      state.index += 1;
      driver.push!(textRef.current + liveChunk(state.index, chunk));
      const profile = driver.profile!;
      state.durations = profile.durations.slice(-180);
      state.raf = requestAnimationFrame(tick);
      if (state.index % 8 === 0) refresh();
      if (textRef.current.length > 250_000) stop();
    };
    live.current.raf = requestAnimationFrame(tick);
  }, [chunk, refresh, startChars, stop]);

  useEffect(() => () => cancelAnimationFrame(live.current.raf), []);
  useEffect(() => { refresh(); }, [mode, refresh]);

  // 首屏自动播起来，打开就能看到字在流（只跑一次）。
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const timer = window.setTimeout(() => start(), 400);
    return () => window.clearTimeout(timer);
  }, [start]);

  // ---- 量化：flushSync 同步提交 + 强制布局，React 与布局分开计时 ----
  const measure = useCallback(async (target: Mode, chars_: number, updates: number, chunk_: number): Promise<Row> => {
    const profile = driver.profile!;
    profile.collecting = false;
    setMode(target);
    modeRef.current = target;
    let current = genText(chars_);
    driver.push!(current);
    // 等两帧让模式切换与新文本落到 DOM（StrictMode 下会双渲染）。
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const reactValues: number[] = [];
    const layoutValues: number[] = [];
    const totalValues: number[] = [];
    let longTasks = 0;
    let longMs = 0;
    const observer = typeof PerformanceObserver !== "undefined"
      ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) { longTasks += 1; longMs += entry.duration; }
      })
      : undefined;
    try { observer?.observe({ entryTypes: ["longtask"] }); } catch { /* 不支持就只报提交耗时 */ }

    for (let i = 0; i < updates; i += 1) {
      current += chunkText(i, chunk_);
      const started = performance.now();
      flushSync(() => driver.push!(current));
      const afterReact = performance.now();
      void box.current?.offsetHeight;
      const afterLayout = performance.now();
      reactValues.push(afterReact - started);
      layoutValues.push(afterLayout - afterReact);
      totalValues.push(afterLayout - started);
    }
    observer?.disconnect();
    return {
      id: `${target}-${chars_}-${chunk_}`,
      mode: target,
      startChars: chars_,
      chunk: chunk_,
      react: sample(reactValues),
      layout: sample(layoutValues),
      total: sample(totalValues),
      longTasks,
      longMs: Number(longMs.toFixed(1)),
    };
  }, []);

  const runAll = useCallback(async () => {
    setBusy(true);
    stop();
    const plan: Array<{ chars: number; chunk: number }> = [
      { chars: 4_000, chunk: 16 },
      { chars: 30_000, chunk: 16 },
      { chars: 90_000, chunk: 16 },
      { chars: 90_000, chunk: 48 },
    ];
    const out: Row[] = [];
    for (const step of plan) {
      for (const target of ["legacy", "segmented"] as Mode[]) {
        const row = await measure(target, step.chars, 120, step.chunk);
        out.push(row);
        setRows([...out]);
      }
    }
    setBusy(false);
    if (note.current) note.current.textContent = "测量完成：同一段文本、同一每帧字数，只有分块策略不同";
    return out;
  }, [measure, stop]);

  // 供脚本驱动（也可在控制台里用）：跑一遍对照并把结果返回。
    (window as unknown as Record<string, unknown>).__streamPerf = { genText, start, stop, runAll, measure, push: (next: string) => driver.push!(next), highlight: highlightProbe, staticRender: (next: string) => staticProbe.render!(next) };

  const container = mode === "segmented" ? <SegmentedMarkdown>{text}</SegmentedMarkdown> : <LegacyMarkdown>{text}</LegacyMarkdown>;

  const staticBox = useRef<HTMLDivElement>(null);
  const [staticText, setStaticText] = useState("");
  staticProbe.render = async (next: string) => {
    const started = performance.now();
    flushSync(() => setStaticText(next));
    const afterReact = performance.now();
    void staticBox.current?.offsetHeight;
    const afterLayout = performance.now();
    return { chars: next.length, react: Number((afterReact - started).toFixed(2)), layout: Number((afterLayout - afterReact).toFixed(2)) };
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#fbfaf7" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px", padding: "10px 14px", borderBottom: "1px solid #e6e0d4", background: "#fff" }}>
        <button type="button" onClick={streaming ? stop : start}>{streaming ? "停止流式" : "开始流式"}</button>
        <button type="button" onClick={() => { stop(); void runAll(); }} disabled={busy}>{busy ? "测量中…" : "跑对照测量"}</button>
        <span style={{ width: 1, height: 22, background: "#e6e0d4" }} />
        <label>路径
          <select value={mode} onChange={(event) => { setMode(event.target.value as Mode); modeRef.current = event.target.value as Mode; }} style={{ marginLeft: 6 }}>
            <option value="segmented">新路径（分段渲染）</option>
            <option value="legacy">旧路径（整段分块）</option>
          </select>
        </label>
        <label>起始字数
          <select value={startChars} onChange={(event) => setStartChars(Number(event.target.value))} style={{ marginLeft: 6 }}>
            <option value={4_000}>4k</option>
            <option value={30_000}>30k</option>
            <option value={90_000}>90k</option>
          </select>
        </label>
        <label>落字速率
          <select value={chunk} onChange={(event) => setChunk(Number(event.target.value))} style={{ marginLeft: 6 }}>
            <option value={3}>约 100 token/s（3 字/帧）</option>
            <option value={5}>约 200 token/s（5 字/帧）</option>
            <option value={7}>约 280 token/s（7 字/帧）</option>
            <option value={16}>16 字/帧（之前用的基线）</option>
            <option value={48}>48 字/帧（压力）</option>
          </select>
        </label>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={followOn} onChange={(event) => setFollowOn(event.target.checked)} />
          跟随底部（真实 App 的行为）
        </label>
        <span style={{ color: "#7a7268", fontSize: 12 }}>改这些只在下次「开始流式」时生效</span>
      </div>

      <Readout refs={{ chars, frames, react: reactOut, long: longOut, mode: modeOut, note }} />

      <div style={{ height: 1, overflow: "hidden" }} aria-hidden="true">
        <div className="markdown flow-thought-text" ref={staticBox}>
          {staticText ? <Markdown>{staticText}</Markdown> : null}
        </div>
      </div>
      <div className="conversation" ref={scroller} style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>
        <div className="flow-thought-body">
          <Profiler id="turn" onRender={onRender}>
            <div className="markdown flow-thought-text" ref={box}>{container}</div>
          </Profiler>
        </div>
      </div>

      <div style={{ maxHeight: "34vh", overflow: "auto", borderTop: "1px solid #e6e0d4", background: "#fff" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace" }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#7a7268" }}>
              <th style={cell}>路径</th><th style={cell}>起始字数</th><th style={cell}>每帧字数</th>
              <th style={cell}>React 提交 p50 / p95</th><th style={cell}>布局 p50 / p95</th><th style={cell}>合计 p50 / p95 / max</th><th style={cell}>长任务</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} style={{ color: row.mode === "segmented" ? "#1d5c3a" : "#7a3b1d" }}>
                <td style={cell}>{MODE_LABEL[row.mode]}</td>
                <td style={cell}>{(row.startChars / 1000)}k</td>
                <td style={cell}>{row.chunk}</td>
                <td style={cell}>{row.react.p50} / {row.react.p95} ms</td>
                <td style={cell}>{row.layout.p50} / {row.layout.p95} ms</td>
                <td style={cell}>{row.total.p50} / {row.total.p95} / {row.total.max} ms</td>
                <td style={cell}>{row.longTasks} 个 / {row.longMs}ms</td>
              </tr>
            ))}
            {!rows.length && (
              <tr><td style={cell} colSpan={7}>点「跑对照测量」：4k/30k/90k × 16/48 字，各跑一遍新旧路径，结果落在这里。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cell: CSSProperties = { padding: "5px 10px", borderBottom: "1px solid #f0ece2", whiteSpace: "nowrap" };

// 探针页面不接主进程：给组件链用到的 harness 面一个最小实现。
(window as unknown as Record<string, unknown>).harness = {
  platform: "darwin",
  app: {
    getLocale: async () => "zh",
    openExternal: async () => undefined,
    version: async () => "0.0.0-probe",
  },
  browser: { onAgentPresentation: () => () => undefined },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <Harness />
    </LocaleProvider>
  </StrictMode>,
);
