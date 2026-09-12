import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { Brain, ChevronDown, ChevronRight, CircleAlert, CircleHelp, FilePenLine, FileText, Globe, LoaderCircle, Search, SquareTerminal, Workflow, Wrench } from "lucide-react";
import { toolRow, type buildTurnPresentation, type ToolActivity, type WorkItem } from "./conversation";
import { useI18n } from "./i18n";

type Presentation = ReturnType<typeof buildTurnPresentation>;
type TextRenderer = (text: string, streaming?: boolean) => ReactNode;

/** 流式中仅让最近这些项参与高频更新（对齐 Proma-main PROCESS_GROUP_LIVE_CHILD_WINDOW）。 */
const LIVE_CHILD_WINDOW = 4;

/** 折叠态默认完整展开的最近步数；更早的收成一行「更早的 N 步」，点击才渲染。 */
const RECENT_STEP_WINDOW = 4;

/**
 * 折叠态（2 行 `line-clamp`）只渲染思考开头的这一小段。
 *
 * 为什么必须截断：条目一旦不再是「当前项」，`Markdown` 就从流式切到 `streaming={false}`，
 * 对**整段**文本跑三个全文预处理器 + Streamdown 静态整段解析。实测这一帧的 React 提交
 * 4.8k=14.2ms、30k=47.6ms、93k=127.5ms（dev，布局另有 9ms）——而折叠态可见的只有前两行，
 * 整段渲染纯属白付。展开时仍渲染全文。
 */
const CLIPPED_PREVIEW_CHARS = 800;

const FlowText = memo(function FlowText({ text, streaming, render }: { text: string; streaming?: boolean; render: TextRenderer }) {
  // `live` 供流式光标的 CSS 使用（贴在最后一个段落之后的伪元素）。
  return <div className={streaming ? "markdown flow-text live" : "markdown flow-text"}>{render(text, streaming)}</div>;
});

const Thought = memo(function Thought({ itemId, text, active, expanded, pending, onToggle, render }: {
  itemId: string; text: string; active: boolean; expanded: boolean; pending?: boolean; onToggle(id: string): void; render: TextRenderer;
}) {
  const { t } = useI18n();
  const content = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const id = useId();
  useLayoutEffect(() => {
    const node = content.current;
    // 展开态没有裁剪，clientHeight 等于全文高度，测量会得出「没超出」的假结论，
    // 因此展开时跳过测量、保留上一次判定，按钮才不会在展开后消失。
    if (!node || active || expanded) return;
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [active, text, expanded]);
  const clipped = !active && !expanded && text.length > CLIPPED_PREVIEW_CHARS;
  return (
    <section className="flow-thought">
      <div className="flow-thought-label"><Brain size={15} aria-hidden="true" /><span>{t("trace.think")}</span>{active && <LoaderCircle size={13} className="flow-spinner" aria-hidden="true" />}</div>
      <div className="flow-thought-body">
        <div ref={content} id={id} className={`markdown flow-thought-text${active ? " live" : ""}${clipped ? " clipped" : ""}`}>{render(clipped ? text.slice(0, CLIPPED_PREVIEW_CHARS) : text, active)}</div>
        {!active && (overflowing || expanded) && <button type="button" className="flow-thought-toggle" data-pending={pending || undefined} aria-expanded={expanded} aria-controls={id} onClick={() => onToggle(itemId)}>
          <ChevronDown size={13} className={expanded ? "rotated" : ""} aria-hidden="true" />{t(expanded ? "flow.collapseThinking" : "flow.expandThinking")}
        </button>}
      </div>
    </section>
  );
});

const toolIcons = { think: Brain, run: SquareTerminal, write: FilePenLine, read: FileText, search: Search, look: Globe, tool: Wrench };
const ToolLine = memo(function ToolLine({ itemId, tool, expanded, onToggle, render }: {
  itemId: string; tool: ToolActivity; expanded: boolean; onToggle(id: string, defaultOpen?: boolean): void; render(tool: ToolActivity): ReactNode;
}) {
  const { t } = useI18n();
  const row = toolRow(tool);
  const Glyph = tool.name === "delegate" ? Workflow : toolIcons[row.kind];
  const pending = tool.status === "running";
  const error = tool.status === "error";
  const unknown = tool.resultRecorded === false && !pending;
  const state = tool.interrupted ? t("flow.interrupted") : pending ? t("flow.running") : error ? t("flow.failed") : unknown ? t("flow.unrecorded") : "";
  const id = useId();
  return (
    <div className={`flow-tool${error ? " error" : ""}`} data-tool-id={tool.id}>
      <button type="button" className="flow-tool-line" aria-expanded={expanded} aria-controls={id} onClick={() => onToggle(itemId, error)} title={[tool.name, row.label, row.chip, state].filter(Boolean).join(" · ")}>
        {pending ? <LoaderCircle size={15} className="flow-spinner" aria-hidden="true" /> : error ? <CircleAlert size={15} aria-hidden="true" /> : unknown ? <CircleHelp size={15} aria-hidden="true" /> : <Glyph size={15} aria-hidden="true" />}
        <span className="flow-tool-label">{row.label}</span>
        {row.chip && <><span className="flow-separator" aria-hidden="true">·</span><span className={`flow-tool-summary${row.mono ? " mono" : ""}`}>{row.chip}</span></>}
        {state && <span className="flow-tool-state">{state}</span>}
        <ChevronRight size={13} className={expanded ? "rotated" : ""} aria-hidden="true" />
      </button>
      {expanded && <div id={id} className="flow-tool-detail">{render(tool) || <span className="flow-empty-detail">{t(pending ? "flow.awaitingResult" : "flow.noOutput")}</span>}</div>}
    </div>
  );
});

/** 计算过程项的内容签名：流式中旧项内容/状态不变时冻结，避免重复渲染（对齐 Proma-main StableProcessChild）。 */
function processItemSignature(item: WorkItem, expanded: Record<string, boolean>): string {
  if (item.type === "tool") return `tool:${item.toolId}`;
  return `${item.type}:${item.text}:${item.type === "thinking" ? (expanded[item.id] ?? false) : ""}`;
}

/** 惰性冻结器：冻结状态下若签名不变则复用上次渲染结果，避免长过程里旧项重复渲染高频内容。 */
const FreezeCell = memo(function FreezeCell({ freeze, signature, build }: {
  freeze: boolean; signature: string; build(): ReactNode;
}) {
  const cache = useRef<{ sig: string; node: ReactNode } | null>(null);
  if (!freeze) {
    const node = build();
    cache.current = { sig: signature, node };
    return node;
  }
  // 首次就以冻结状态挂载（例如用户展开「更早的 N 步」时旧项才被渲染）不能返回空缓存。
  if (!cache.current || cache.current.sig !== signature) {
    cache.current = { sig: signature, node: build() };
  }
  return cache.current.node;
});

export function ExecutionFlow({ view, live, streaming, awaiting, stopping, interrupted, error, errorTone, clock, canAutoCollapse, onRetry, renderText, renderTool }: {
  view: Presentation;
  live: boolean;
  streaming: boolean;
  awaiting: boolean;
  stopping: boolean;
  interrupted: boolean;
  error?: string;
  errorTone: "strong" | "weak";
  clock: ReactNode;
  canAutoCollapse(): boolean;
  onRetry?(): void;
  renderText: TextRenderer;
  renderTool(tool: ToolActivity): ReactNode;
}) {
  const { t } = useI18n();
  const failed = Boolean(error) || view.tools.some((tool) => tool.status === "error");
  const unknown = view.tools.some((tool) => tool.resultRecorded === false && tool.status !== "running");
  const [open, setOpen] = useState(() => live || awaiting || failed || interrupted || unknown || !view.reply.length);
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [offscreen, setOffscreen] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  const [togglePending, startToggleTransition] = useTransition();
  const interacted = useRef(false);
  const wasLive = useRef(live);
  const root = useRef<HTMLDivElement>(null);
  const processRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const earlierId = useId();
  const active = streaming ? view.items.at(-1) : undefined;
  const hasProcess = view.process.length > 0 || (live && !view.reply.length) || awaiting || failed || interrupted;

  useEffect(() => {
    if (open) { setMounted(true); return; }
    const timer = window.setTimeout(() => setMounted(false), 240);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 过程区是否已完全滚出视口。只有用户看不到它了，才允许自动收起，
  // 避免展开中的过程在阅读时被抽走。
  useEffect(() => {
    const node = processRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      setOffscreen(entry ? entry.intersectionRatio === 0 : false);
    }, { threshold: 0 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasProcess]);

  useEffect(() => {
    if (live) {
      if (!wasLive.current) {
        interacted.current = false;
        setShowEarlier(false);
        setOpen(true);
      }
      wasLive.current = true;
      return;
    }
    if (failed || interrupted || awaiting || unknown || !view.reply.length) {
      if (!interacted.current) setOpen(true);
      return;
    }
    if (!wasLive.current || interacted.current) return;
    // 用户看不到过程区了才静默收起：没有倒计时，不打断阅读的人。
    if (!offscreen || !canAutoCollapse()) return;
    const timer = window.setTimeout(() => {
      if (interacted.current || !canAutoCollapse()) return;
      setOpen(false);
      wasLive.current = false;
    }, 600);
    return () => window.clearTimeout(timer);
  }, [live, failed, interrupted, awaiting, unknown, view.reply.length, offscreen, canAutoCollapse]);

  const toggleItem = useCallback((key: string, defaultOpen = false) => {
    interacted.current = true;
    // 展开「思考全文 / 大段工具输出」可能要渲染几万字符，放低优先级：
    // 界面保持响应，重内容渲染完再上屏（按钮在 pending 期间降透明度）。
    startToggleTransition(() => {
      setExpanded((current) => ({ ...current, [key]: !(current[key] ?? defaultOpen) }));
    });
  }, []);
  const toggleEarlier = useCallback(() => {
    interacted.current = true;
    startToggleTransition(() => {
      setShowEarlier((value) => !value);
    });
  }, []);
  const toolMap = useMemo(() => new Map(view.tools.map((tool) => [tool.id, tool])), [view.tools]);
  const status = stopping ? t("flow.stopping") : awaiting ? t("flow.awaiting") : interrupted ? t("flow.interrupted") : live ? t("flow.running") : failed ? t("flow.failed") : unknown ? t("flow.unrecorded") : !view.reply.length ? t("flow.ended") : "";
  const runningCount = view.tools.filter((tool) => tool.status === "running").length;
  const summary = useMemo(() => {
    const toolCount = view.tools.length;
    const messageCount = view.process.filter((item) => item.type === "thinking" || item.type === "text").length;
    return t("flow.summary", { tools: toolCount, messages: messageCount });
  }, [view.tools.length, view.process, t]);
  const lastTool = view.tools.at(-1);
  const lastRow = lastTool ? toolRow(lastTool) : undefined;
  const lastLine = lastRow ? [lastRow.label, lastRow.chip].filter(Boolean).join(" · ") : "";
  const processToolGlyphs = useMemo(() => {
    const seen = new Set<string>();
    const glyphs: Array<{ name: string; Glyph: (typeof Workflow | typeof Brain) }> = [];
    for (const tool of view.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      const row = toolRow(tool);
      glyphs.push({ name: tool.name, Glyph: tool.name === "delegate" ? Workflow : toolIcons[row.kind] });
    }
    return glyphs;
  }, [view.tools]);
  const visibleToolGlyphs = processToolGlyphs.slice(0, 4);
  const hiddenToolCount = Math.max(0, processToolGlyphs.length - visibleToolGlyphs.length);
  const processEntries = useMemo(() => view.process.map((item, index) => ({ item, index })), [view.process]);
  const earlierCount = Math.max(0, processEntries.length - RECENT_STEP_WINDOW);
  const recentEntries = processEntries.slice(earlierCount);

  const renderEntry = ({ item, index }: { item: WorkItem; index: number }) => {
    const liveStart = Math.max(0, view.process.length - LIVE_CHILD_WINDOW);
    const freeze = live && index < liveStart && item.type !== "tool";
    const build = () => (
      <div key={item.id} data-scroll-anchor={item.id}>
        {item.type === "thinking" ? <Thought itemId={item.id} text={item.text} active={item.id === active?.id && live && !awaiting} expanded={expanded[item.id] ?? false} pending={togglePending} onToggle={toggleItem} render={renderText} />
          : item.type === "text" ? <FlowText text={item.text} streaming={item.id === active?.id && live} render={renderText} />
            : (() => {
              const tool = toolMap.get(item.toolId);
              return tool ? <ToolLine itemId={item.id} tool={tool} expanded={expanded[item.id] ?? tool.status === "error"} onToggle={toggleItem} render={renderTool} /> : null;
            })()}
      </div>
    );
    return <FreezeCell key={item.id} freeze={freeze} signature={freeze ? processItemSignature(item, expanded) : `${item.id}:${liveStart}`} build={build} />;
  };

  return (
    <div className="execution-flow" ref={root}>
      {hasProcess && <div className="flow-process" ref={processRef}>
        <button type="button" className="flow-header" aria-expanded={open} aria-controls={id} onClick={() => {
          interacted.current = true;
          setOpen((value) => !value);
        }}>
          <ChevronRight size={14} className={open ? "rotated" : ""} aria-hidden="true" />
          <span className="flow-title">{summary}</span>
          {!open && lastLine && <span className="flow-last" title={lastLine}>{t("flow.last", { label: lastLine })}</span>}
          {visibleToolGlyphs.length > 0 && <span className="flow-tool-icons" aria-hidden="true">
            {visibleToolGlyphs.map(({ name, Glyph }) => <Glyph key={name} size={14} />)}
            {hiddenToolCount > 0 && <span className="flow-tool-icon-more">+{hiddenToolCount}</span>}
          </span>}
          {status && <span className={`flow-status${failed ? " error" : ""}`}>{runningCount > 1 && live && !awaiting ? t("flow.parallel", { n: runningCount }) : status}</span>}
          {clock}
        </button>
        <div className={`flow-collapse${open ? " open" : ""}`} inert={!open} aria-hidden={!open}>
          <div className="flow-collapse-inner">
            {mounted && <div className="flow-viewport-wrap">
              <div id={id} className="flow-viewport scrollbar-none" aria-label={t("flow.process")}>
                <div className="flow-items">
                  {earlierCount > 0 && <div className="flow-earlier">
                    <button type="button" className="flow-earlier-toggle" data-pending={togglePending || undefined} aria-expanded={showEarlier} aria-controls={earlierId} onClick={toggleEarlier}>
                      <ChevronRight size={13} className={showEarlier ? "rotated" : ""} aria-hidden="true" />
                      <span>{t(showEarlier ? "flow.collapseEarlier" : "flow.earlierSteps", { n: earlierCount })}</span>
                    </button>
                    {showEarlier && <div id={earlierId} className="flow-earlier-items">{processEntries.slice(0, earlierCount).map(renderEntry)}</div>}
                  </div>}
                  {recentEntries.map(renderEntry)}
                  {live && !view.items.length && <div className="flow-pending"><LoaderCircle size={14} className="flow-spinner" aria-hidden="true" />{t("think.waiting")}</div>}
                </div>
              </div>
            </div>}
          </div>
        </div>
      </div>}
      {error && <div className={`flow-error ${errorTone}`} role="status"><CircleAlert size={15} aria-hidden="true" /><span>{error}</span>{onRetry && <button type="button" className="ghost" onClick={onRetry}>{t("common.continue")}</button>}</div>}
      {view.reply.map((item) => <div key={item.id} className="flow-reply" data-scroll-anchor={item.id}>
        <FlowText text={item.text} streaming={item.id === active?.id && live} render={renderText} />
      </div>)}
    </div>
  );
}
