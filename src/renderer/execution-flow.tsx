import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Brain, ChevronDown, ChevronRight, CircleAlert, CircleHelp, FilePenLine, FileText, Globe, LoaderCircle, Search, SquareTerminal, Workflow, Wrench } from "lucide-react";
import { toolRow, type buildTurnPresentation, type ToolActivity, type WorkItem } from "./conversation";
import { useI18n } from "./i18n";
import { useStreamText } from "./use-stream-text";
import { useFollowScroll } from "./use-follow-scroll";

type Presentation = ReturnType<typeof buildTurnPresentation>;
type TextRenderer = (text: string, streaming?: boolean) => ReactNode;

/** 流式中仅让最近这些项参与高频更新（对齐 Proma-main PROCESS_GROUP_LIVE_CHILD_WINDOW）。 */
const LIVE_CHILD_WINDOW = 4;

const FlowText = memo(function FlowText({ text, streaming, render }: { text: string; streaming?: boolean; render: TextRenderer }) {
  return <div className="markdown flow-text">{render(text, streaming)}</div>;
});

const Thought = memo(function Thought({ itemId, text, active, expanded, onToggle, render }: {
  itemId: string; text: string; active: boolean; expanded: boolean; onToggle(id: string): void; render: TextRenderer;
}) {
  const { t } = useI18n();
  const content = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const id = useId();
  useLayoutEffect(() => {
    const node = content.current;
    if (!node || active) return;
    const measure = () => setLong(node.scrollHeight > (parseFloat(getComputedStyle(node).lineHeight) || 22.4) * 4 + 2);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [active, text]);
  return (
    <section className="flow-thought">
      <div className="flow-thought-label"><Brain size={15} aria-hidden="true" /><span>{t("trace.think")}</span>{active && <LoaderCircle size={13} className="flow-spinner" aria-hidden="true" />}</div>
      <div className="flow-thought-body">
        <div ref={content} id={id} className={`markdown flow-thought-text${!active && !expanded ? " clipped" : ""}`}>{render(text, active)}</div>
        {!active && long && <button type="button" className="flow-thought-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => onToggle(itemId)}>
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
function processItemSignature(item: WorkItem, textOf: (item: { id: string; text: string }) => string, expanded: Record<string, boolean>): string {
  if (item.type === "tool") return `tool:${item.toolId}`;
  return `${item.type}:${textOf(item)}:${item.type === "thinking" ? (expanded[item.id] ?? false) : ""}`;
}

/** 惰性冻结器：冻结状态下若签名不变则复用上次渲染结果，避免长过程里旧项重复渲染高频内容。 */
const FreezeCell = memo(function FreezeCell({ freeze, signature, build }: {
  freeze: boolean; signature: string; build(): ReactNode;
}) {
  const cache = useRef<{ sig: string; node: ReactNode }>({ sig: signature, node: null });
  if (!freeze) {
    const node = build();
    cache.current = { sig: signature, node };
    return node;
  }
  if (cache.current.sig !== signature) {
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
  const [bounded, setBounded] = useState(live && view.reply.length > 0);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapseCountdown, setCollapseCountdown] = useState<number | null>(null);
  const collapseTimers = useRef<number[]>([]);
  const interacted = useRef(false);
  const wasLive = useRef(live);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const scroll = useFollowScroll(id, mounted && open);
  const active = streaming ? view.items.at(-1) : undefined;
  const source = active && active.type !== "tool" ? active.text : "";
  const displayed = useStreamText(source, Boolean(source && live && !awaiting), active?.id ?? "idle");
  const pendingText = displayed !== source;
  const hasProcess = view.process.length > 0 || (live && !view.reply.length) || awaiting || failed || interrupted;

  useEffect(() => {
    if (open) { setMounted(true); return; }
    const timer = window.setTimeout(() => setMounted(false), 240);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    const clearCountdown = () => {
      for (const timer of collapseTimers.current) window.clearTimeout(timer);
      collapseTimers.current = [];
      setCollapseCountdown(null);
    };
    if (live) {
      if (!wasLive.current) {
        interacted.current = false;
        setOpen(true);
        setBounded(true);
      }
      wasLive.current = true;
      clearCountdown();
      return clearCountdown;
    }
    clearCountdown();
    if (failed || interrupted || awaiting || unknown || !view.reply.length) {
      if (!interacted.current) setOpen(true);
      return clearCountdown;
    }
    if (!wasLive.current || interacted.current || pendingText || !scroll.atBottom) return clearCountdown;
    // 完成后倒计时再折叠（对齐 Proma-main：3 秒后自动收起）
    const startCountdown = () => {
      const guard = () => {
        if (interacted.current || !canAutoCollapse() || !scroll.following.current) return true;
        if (root.current?.contains(document.activeElement) || window.getSelection()?.toString()) return true;
        return false;
      };
      if (guard()) { setCollapseCountdown(null); return; }
      setCollapseCountdown(3);
      collapseTimers.current.push(window.setTimeout(() => setCollapseCountdown(2), 1000));
      collapseTimers.current.push(window.setTimeout(() => setCollapseCountdown(1), 2000));
      collapseTimers.current.push(window.setTimeout(() => {
        if (guard()) { setCollapseCountdown(null); return; }
        setCollapseCountdown(null);
        setOpen(false);
        wasLive.current = false;
      }, 3000));
    };
    startCountdown();
    return () => { clearCountdown(); };
  }, [live, failed, interrupted, awaiting, unknown, view.reply.length, pendingText, scroll.atBottom, canAutoCollapse]);

  // 第一次思考期间（live 但还没有回复文本）不 bounded，让过程自然展开填满空间；
  // 一旦 agent 开始输出回复文本，恢复 max-height 截断，避免过程吃掉整个视口。
  useEffect(() => {
    if (live && view.reply.length > 0) setBounded(true);
  }, [live, view.reply.length]);

  const toggleItem = useCallback((key: string, defaultOpen = false) => {
    interacted.current = true;
    setExpanded((current) => ({ ...current, [key]: !(current[key] ?? defaultOpen) }));
  }, []);
  const toolMap = useMemo(() => new Map(view.tools.map((tool) => [tool.id, tool])), [view.tools]);
  const textOf = (item: { id: string; text: string }) => item.id === active?.id ? displayed : item.text;
  const status = stopping ? t("flow.stopping") : awaiting ? t("flow.awaiting") : interrupted ? t("flow.interrupted") : live ? t("flow.running") : failed ? t("flow.failed") : unknown ? t("flow.unrecorded") : !view.reply.length ? t("flow.ended") : "";
  const runningCount = view.tools.filter((tool) => tool.status === "running").length;
  const summary = useMemo(() => {
    const toolCount = view.tools.length;
    const messageCount = view.process.filter((item) => item.type === "thinking" || item.type === "text").length;
    return t("flow.summary", { tools: toolCount, messages: messageCount });
  }, [view.tools.length, view.process, t]);
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

  return (
    <div className="execution-flow" ref={root}>
      {hasProcess && <div className="flow-process">
        <button type="button" className="flow-header" aria-expanded={open} aria-controls={id} onClick={() => {
          interacted.current = true;
          if (!live) setBounded(false);
          setOpen((value) => !value);
        }}>
          <ChevronRight size={14} className={open ? "rotated" : ""} aria-hidden="true" />
          <span className="flow-title">{summary}</span>
          {visibleToolGlyphs.length > 0 && <span className="flow-tool-icons" aria-hidden="true">
            {visibleToolGlyphs.map(({ name, Glyph }) => <Glyph key={name} size={14} />)}
            {hiddenToolCount > 0 && <span className="flow-tool-icon-more">+{hiddenToolCount}</span>}
          </span>}
          {collapseCountdown !== null && <span className="flow-countdown">{t("flow.collapseIn", { n: collapseCountdown })}</span>}
          {status && <span className={`flow-status${failed ? " error" : ""}`}>{runningCount > 1 && live && !awaiting ? t("flow.parallel", { n: runningCount }) : status}</span>}
          {clock}
        </button>
        <div className={`flow-collapse${open ? " open" : ""}`} inert={!open} aria-hidden={!open}>
          <div className="flow-collapse-inner">
            {mounted && <div className="flow-viewport-wrap">
              <div id={id} ref={scroll.viewportRef} className={`flow-viewport scrollbar-none${bounded ? " bounded" : ""}`} tabIndex={bounded ? 0 : undefined} aria-label={t("flow.process")} onWheelCapture={(event) => { if (event.currentTarget.scrollHeight > event.currentTarget.clientHeight + 1) interacted.current = true; }} onPointerDownCapture={() => { interacted.current = true; }} onKeyDownCapture={() => { interacted.current = true; }}>
                <div className="flow-items" ref={scroll.contentRef}>
                  {view.process.map((item, index) => {
                    const liveStart = Math.max(0, view.process.length - LIVE_CHILD_WINDOW);
                    const freeze = live && index < liveStart && item.type !== "tool";
                    const build = () => (
                      <div key={item.id} data-scroll-anchor={item.id}>
                        {item.type === "thinking" ? <Thought itemId={item.id} text={textOf(item)} active={item.id === active?.id && live && !awaiting} expanded={expanded[item.id] ?? false} onToggle={toggleItem} render={renderText} />
                          : item.type === "text" ? <FlowText text={textOf(item)} streaming={item.id === active?.id && live} render={renderText} />
                            : (() => {
                              const tool = toolMap.get(item.toolId);
                              return tool ? <ToolLine itemId={item.id} tool={tool} expanded={expanded[item.id] ?? tool.status === "error"} onToggle={toggleItem} render={renderTool} /> : null;
                            })()}
                      </div>
                    );
                    return <FreezeCell key={item.id} freeze={freeze} signature={freeze ? processItemSignature(item, textOf, expanded) : `${item.id}:${liveStart}`} build={build} />;
                  })}
                  {live && !view.items.length && <div className="flow-pending"><LoaderCircle size={14} className="flow-spinner" aria-hidden="true" />{t("think.waiting")}</div>}
                </div>
              </div>
            </div>}
          </div>
        </div>
      </div>}
      {error && <div className={`flow-error ${errorTone}`} role="status"><CircleAlert size={15} aria-hidden="true" /><span>{error}</span>{onRetry && <button type="button" className="ghost" onClick={onRetry}>{t("common.continue")}</button>}</div>}
      {view.reply.map((item) => <div key={item.id} className="flow-reply" data-scroll-anchor={item.id}>
        <FlowText text={textOf(item)} streaming={item.id === active?.id && live} render={renderText} />
      </div>)}
    </div>
  );
}
