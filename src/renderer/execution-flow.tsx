import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Brain, ChevronDown, ChevronRight, CircleAlert, CircleHelp, FilePenLine, FileText, Globe, LoaderCircle, Search, SquareTerminal, Workflow, Wrench } from "lucide-react";
import { toolRow, type buildTurnPresentation, type ToolActivity } from "./conversation";
import { useI18n } from "./i18n";
import { useStreamText } from "./use-stream-text";
import { useFollowScroll } from "./use-follow-scroll";

type Presentation = ReturnType<typeof buildTurnPresentation>;
type TextRenderer = (text: string, streaming?: boolean) => ReactNode;

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
  const [bounded, setBounded] = useState(live);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
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
    if (live) {
      if (!wasLive.current) {
        interacted.current = false;
        setOpen(true);
        setBounded(true);
      }
      wasLive.current = true;
      return;
    }
    if (failed || interrupted || awaiting || unknown || !view.reply.length) {
      if (!interacted.current) setOpen(true);
      return;
    }
    if (!wasLive.current || interacted.current || pendingText || !scroll.atBottom) return;
    const timer = window.setTimeout(() => {
      if (interacted.current || !canAutoCollapse() || !scroll.following.current) return;
      if (root.current?.contains(document.activeElement) || window.getSelection()?.toString()) return;
      setOpen(false);
      wasLive.current = false;
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [live, failed, interrupted, awaiting, unknown, view.reply.length, pendingText, scroll.atBottom, canAutoCollapse]);

  const toggleItem = useCallback((key: string, defaultOpen = false) => {
    interacted.current = true;
    setExpanded((current) => ({ ...current, [key]: !(current[key] ?? defaultOpen) }));
  }, []);
  const toolMap = useMemo(() => new Map(view.tools.map((tool) => [tool.id, tool])), [view.tools]);
  const textOf = (item: { id: string; text: string }) => item.id === active?.id ? displayed : item.text;
  const status = stopping ? t("flow.stopping") : awaiting ? t("flow.awaiting") : interrupted ? t("flow.interrupted") : live ? t("flow.running") : failed ? t("flow.failed") : unknown ? t("flow.unrecorded") : !view.reply.length ? t("flow.ended") : "";
  const runningCount = view.tools.filter((tool) => tool.status === "running").length;

  return (
    <div className="execution-flow" ref={root}>
      {hasProcess && <div className="flow-process">
        <button type="button" className="flow-header" aria-expanded={open} aria-controls={id} onClick={() => {
          interacted.current = true;
          if (!live) setBounded(false);
          setOpen((value) => !value);
        }}>
          <ChevronRight size={14} className={open ? "rotated" : ""} aria-hidden="true" />
          <span className="flow-title">{t("flow.process")}</span>
          {view.tools.length > 0 && <span className="flow-count">{t("flow.toolCount", { n: view.tools.length })}</span>}
          {status && <span className={`flow-status${failed ? " error" : ""}`}>{runningCount > 1 && live && !awaiting ? t("flow.parallel", { n: runningCount }) : status}</span>}
          {clock}
        </button>
        <div className={`flow-collapse${open ? " open" : ""}`} inert={!open} aria-hidden={!open}>
          <div className="flow-collapse-inner">
            {mounted && <div className="flow-viewport-wrap">
              <div id={id} ref={scroll.viewportRef} className={`flow-viewport${bounded ? " bounded" : ""}`} tabIndex={bounded ? 0 : undefined} aria-label={t("flow.process")} onWheelCapture={(event) => { if (event.currentTarget.scrollHeight > event.currentTarget.clientHeight + 1) interacted.current = true; }} onPointerDownCapture={() => { interacted.current = true; }} onKeyDownCapture={() => { interacted.current = true; }}>
                <div className="flow-items" ref={scroll.contentRef}>
                  {view.process.map((item) => <div key={item.id} data-scroll-anchor={item.id}>
                    {item.type === "thinking" ? <Thought itemId={item.id} text={textOf(item)} active={item.id === active?.id && live && !awaiting} expanded={expanded[item.id] ?? false} onToggle={toggleItem} render={renderText} />
                      : item.type === "text" ? <FlowText text={textOf(item)} streaming={item.id === active?.id && live} render={renderText} />
                        : (() => {
                          const tool = toolMap.get(item.toolId);
                          return tool ? <ToolLine itemId={item.id} tool={tool} expanded={expanded[item.id] ?? tool.status === "error"} onToggle={toggleItem} render={renderTool} /> : null;
                        })()}
                  </div>)}
                  {live && !view.items.length && <div className="flow-pending"><LoaderCircle size={14} className="flow-spinner" aria-hidden="true" />{t("think.waiting")}</div>}
                </div>
              </div>
              {bounded && !scroll.atBottom && <button type="button" className="flow-latest" title={t("flow.latest")} aria-label={t("flow.latest")} onClick={scroll.followLatest}><ArrowDown size={15} /></button>}
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
