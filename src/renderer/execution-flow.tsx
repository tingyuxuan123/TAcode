import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { Brain, ChevronRight, CircleAlert, CircleHelp, FilePenLine, FileText, Globe, LoaderCircle, Search, SquareTerminal, Workflow, Wrench } from "lucide-react";
import { toolRow, type buildTurnPresentation, type ToolActivity, type WorkItem } from "./conversation";
import { useI18n } from "./i18n";

type Presentation = ReturnType<typeof buildTurnPresentation>;
type TextRenderer = (text: string, streaming?: boolean) => ReactNode;

/** 流式中仅让最近这些项参与高频更新（对齐 Proma-main PROCESS_GROUP_LIVE_CHILD_WINDOW）。 */
const LIVE_CHILD_WINDOW = 4;

const FlowText = memo(function FlowText({ text, streaming, render }: { text: string; streaming?: boolean; render: TextRenderer }) {
  // `live` 供流式光标的 CSS 使用（贴在最后一个段落之后的伪元素）。
  return <div className={streaming ? "markdown flow-text live" : "markdown flow-text"}>{render(text, streaming)}</div>;
});

/**
 * 思考条目（对齐 ZCode）：默认收起成一行——图标 + 「思考」+ 最新一句思考预览
 * （流式时实时跟着尾部走），进行中整行文字带微光扫过动画；点击展开全文。
 *
 * 展开态是**纯文本 pre-wrap**（对齐 ZCode 的 ReasoningContent：思考是草稿不是
 * 正文，不走 markdown，代码块就是原始字符），240→320px 高度上限 + 块内滚动，
 * 内容超出时上/下边缘渐隐提示；流式中自动跟到最新一句（用户上翻即停）。
 *
 * 收起态不构造任何内容子树，预览只取尾部一小段字符串：长思考（真实会话量到过
 * 93k 字符）在折叠态曾经为「只看得到两行」白付整段渲染（实测这一帧 127ms），
 * 现在彻底不付。`expanded` 就是 ExecutionFlow 的 `expanded[item.id]`（默认 false），
 * 与工具行同一套状态。
 */
const Thought = memo(function Thought({ itemId, text, active, expanded, pending, onToggle }: {
  itemId: string; text: string; active: boolean; expanded: boolean; pending?: boolean; onToggle(id: string): void;
}) {
  const { t } = useI18n();
  const bodyId = useId();
  // 展开块有高度上限：流式中内容在块内部增长，只要用户没有往上翻（距底 8px 内
  // 算贴着底），就自动跟到最新一句；同 CodeBlock 的内部跟随行为。
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const selfScroll = useRef(false);
  /** 内容超出可视区时，上/下边缘渐隐提示（对齐 ZCode 的 scroll mask）。 */
  const [mask, setMask] = useState<"none" | "top" | "bottom" | "both">("none");
  const syncMask = useCallback(() => {
    const node = bodyRef.current;
    if (!node) { setMask("none"); return; }
    const top = node.scrollTop > 1;
    const bottom = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    setMask(top && bottom ? "both" : top ? "top" : bottom ? "bottom" : "none");
  }, []);
  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!expanded || !node) return;
    pinned.current = true;
    if (active) {
      // 进行中展开：直接看最新内容（已结束的思考从顶部读起）
      selfScroll.current = true;
      node.scrollTop = node.scrollHeight;
      requestAnimationFrame(() => { selfScroll.current = false; });
    }
    const follow = () => {
      if (pinned.current && active) {
        selfScroll.current = true;
        node.scrollTop = node.scrollHeight;
        requestAnimationFrame(() => { selfScroll.current = false; });
      }
      syncMask();
    };
    const onScroll = () => {
      if (selfScroll.current) { selfScroll.current = false; syncMask(); return; }
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 8;
      syncMask();
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    // 容器与内容层都观察：文字增长改变 scrollHeight 时（容器高度不变）也能跟到
    const observer = new ResizeObserver(follow);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    syncMask();
    return () => {
      node.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [expanded, active, syncMask]);
  // 预览取最后一个非空行：流式时正好是「正在想的那句」，尾部 600 字符足够覆盖它。
  const preview = useMemo(() => {
    if (!text) return "";
    const tail = text.length > 600 ? text.slice(-600) : text;
    const clippedHead = tail.length < text.length;
    const lines = tail.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!.trim();
      if (!line) continue;
      const lead = clippedHead && index === 0 ? "…" : "";
      return line.length > 140 ? `${lead}${line.slice(-140)}` : lead + line;
    }
    return "";
  }, [text]);
  const maskStyle = mask === "none" ? undefined : {
    WebkitMaskImage: mask === "both"
      ? "linear-gradient(to bottom, transparent 0, #000 20px, #000 calc(100% - 20px), transparent)"
      : mask === "top"
        ? "linear-gradient(to bottom, transparent 0, #000 20px)"
        : "linear-gradient(to bottom, #000 calc(100% - 20px), transparent)",
    maskImage: mask === "both"
      ? "linear-gradient(to bottom, transparent 0, #000 20px, #000 calc(100% - 20px), transparent)"
      : mask === "top"
        ? "linear-gradient(to bottom, transparent 0, #000 20px)"
        : "linear-gradient(to bottom, #000 calc(100% - 20px), transparent)",
  };
  return (
    <section className={expanded ? "flow-thought open" : "flow-thought"}>
      <button
        type="button"
        className={`flow-thought-label${active ? " active" : ""}`}
        data-pending={pending || undefined}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => onToggle(itemId)}
      >
        <Brain size={15} aria-hidden="true" />
        <span className="flow-thought-name">{t("trace.think")}</span>
        {!expanded && <span className="flow-thought-preview">{preview}</span>}
        <ChevronRight size={13} className={expanded ? "rotated" : ""} aria-hidden="true" />
      </button>
      {expanded && (
        <div id={bodyId} ref={bodyRef} className="flow-thought-body" style={maskStyle}>
          <div className="flow-thought-plain">{text}</div>
        </div>
      )}
    </section>
  );
});

const toolIcons = { think: Brain, run: SquareTerminal, write: FilePenLine, read: FileText, search: Search, look: Globe, tool: Wrench };
const ToolLine = memo(function ToolLine({ itemId, tool, expanded, onToggle, onOpenFile, render }: {
  itemId: string; tool: ToolActivity; expanded: boolean; onToggle(id: string, defaultOpen?: boolean): void;
  /** 文件类工具行点击时在右侧面板开文件标签（对齐 ZCode 的 code viewer）；缺省回退行内展开。 */
  onOpenFile?(path: string): void;
  render(tool: ToolActivity): ReactNode;
}) {
  const { t } = useI18n();
  const row = toolRow(tool);
  const Glyph = tool.name === "delegate" ? Workflow : toolIcons[row.kind];
  const pending = tool.status === "running";
  const error = tool.status === "error";
  const unknown = tool.resultRecorded === false && !pending;
  const state = tool.interrupted ? t("flow.interrupted") : pending ? t("flow.running") : error ? t("flow.failed") : unknown ? t("flow.unrecorded") : "";
  const id = useId();
  // 文件行（读取/写入/编辑）点击开右侧文件标签，不做行内展开——对齐 ZCode 的
  // code viewer 交互；没有 onOpenFile（探针环境）时保持旧行为。
  const fileRow = Boolean(row.path) && Boolean(onOpenFile);
  return (
    <div className={`flow-tool${error ? " error" : ""}`} data-tool-id={tool.id}>
      <button type="button" className="flow-tool-line" aria-expanded={fileRow ? undefined : expanded} aria-controls={fileRow ? undefined : id} onClick={() => { if (fileRow) onOpenFile?.(row.path!); else onToggle(itemId, error); }} title={[tool.name, row.label, row.chip, state].filter(Boolean).join(" · ")}>
        {pending ? <LoaderCircle size={15} className="flow-spinner" aria-hidden="true" /> : error ? <CircleAlert size={15} aria-hidden="true" /> : unknown ? <CircleHelp size={15} aria-hidden="true" /> : <Glyph size={15} aria-hidden="true" />}
        <span className="flow-tool-label">{row.label}</span>
        {row.chip && <><span className="flow-separator" aria-hidden="true">·</span><span className={`flow-tool-summary${row.mono ? " mono" : ""}`}>{row.chip}</span></>}
        {row.diff && (row.diff.added > 0 || row.diff.removed > 0) && (
          <span className="flow-tool-diff">
            {row.diff.added > 0 && <b className="add">+{row.diff.added}</b>}
            {row.diff.removed > 0 && <b className="del">−{row.diff.removed}</b>}
          </span>
        )}
        {state && <span className="flow-tool-state">{state}</span>}
        <ChevronRight size={13} className={fileRow ? "" : expanded ? "rotated" : ""} aria-hidden="true" />
      </button>
      {!fileRow && expanded && <div id={id} className="flow-tool-detail">{render(tool) || <span className="flow-empty-detail">{t(pending ? "flow.awaitingResult" : "flow.noOutput")}</span>}</div>}
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
  // 首次以冻结状态挂载旧项时也需要构建内容，不能返回空缓存。
  if (!cache.current || cache.current.sig !== signature) {
    cache.current = { sig: signature, node: build() };
  }
  return cache.current.node;
});

export function ExecutionFlow({ view, live, streaming, awaiting, stopping, interrupted, error, errorTone, clock, canAutoCollapse = true, onRetry, onOpenFile, renderText, renderTool }: {
  view: Presentation;
  live: boolean;
  streaming: boolean;
  awaiting: boolean;
  stopping: boolean;
  interrupted: boolean;
  error?: string;
  errorTone: "strong" | "weak";
  clock: ReactNode;
  /** 结束后是否自动收起过程区（默认开）；侧栏面板、性能探针传 false 维持常展开。 */
  canAutoCollapse?: boolean;
  onRetry?(): void;
  /** 文件类工具行点击时开右侧文件标签（App 层接 browserPanels.openFile）。 */
  onOpenFile?(path: string): void;
  renderText: TextRenderer;
  renderTool(tool: ToolActivity): ReactNode;
}) {
  const { t } = useI18n();
  const failed = Boolean(error) || view.tools.some((tool) => tool.status === "error");
  const unknown = view.tools.some((tool) => tool.resultRecorded === false && tool.status !== "running");
  // 已结束的回合（历史加载、切会话、上一轮）默认收起，过程区只在回合进行中展开；
  // canAutoCollapse 为 false 的表面（侧栏面板、探针）维持旧的「默认展开」。
  const [open, setOpen] = useState(() => live || awaiting || !canAutoCollapse);
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [togglePending, startToggleTransition] = useTransition();
  const interacted = useRef(false);
  const wasLive = useRef(live);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const active = streaming ? view.items.at(-1) : undefined;
  const hasProcess = view.process.length > 0 || (live && !view.reply.length) || awaiting || failed || interrupted;

  useEffect(() => {
    if (open) { setMounted(true); return; }
    const timer = window.setTimeout(() => setMounted(false), 240);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    // 关闭自动收起的表面（侧栏面板、性能探针）：维持常展开，只有手动点标题才收起。
    if (!canAutoCollapse) {
      if (!interacted.current) setOpen(true);
      return;
    }
    if (live) {
      if (!wasLive.current) {
        interacted.current = false;
        setOpen(true);
      }
      wasLive.current = true;
      return;
    }
    if (awaiting) {
      if (!interacted.current) setOpen(true);
      return;
    }
    // 回合结束（含失败/中断/无回复）就收起，不看滚动位置：长会话里每轮都留一整段
    // 展开的过程，时间线很快被撑爆。只有用户手动点开过条目/标题（interacted）
    // 才尊重手动状态不再收。
    if (!wasLive.current || interacted.current) return;
    const timer = window.setTimeout(() => {
      if (interacted.current) return;
      setOpen(false);
      wasLive.current = false;
    }, 600);
    return () => window.clearTimeout(timer);
  }, [live, awaiting, canAutoCollapse]);

  const toggleItem = useCallback((key: string, defaultOpen = false) => {
    interacted.current = true;
    // 展开「思考全文 / 大段工具输出」可能要渲染几万字符，放低优先级：
    // 界面保持响应，重内容渲染完再上屏（按钮在 pending 期间降透明度）。
    startToggleTransition(() => {
      setExpanded((current) => ({ ...current, [key]: !(current[key] ?? defaultOpen) }));
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

  const renderEntry = ({ item, index }: { item: WorkItem; index: number }) => {
    const liveStart = Math.max(0, view.process.length - LIVE_CHILD_WINDOW);
    const freeze = live && index < liveStart && item.type !== "tool";
    const build = () => (
      <div key={item.id} data-scroll-anchor={item.id}>
        {item.type === "thinking" ? <Thought itemId={item.id} text={item.text} active={item.id === active?.id && live && !awaiting} expanded={expanded[item.id] ?? false} pending={togglePending} onToggle={toggleItem} />
          : item.type === "text" ? <FlowText text={item.text} streaming={item.id === active?.id && live} render={renderText} />
            : (() => {
              const tool = toolMap.get(item.toolId);
              return tool ? <ToolLine itemId={item.id} tool={tool} expanded={expanded[item.id] ?? tool.status === "error"} onToggle={toggleItem} onOpenFile={onOpenFile} render={renderTool} /> : null;
            })()}
      </div>
    );
    return <FreezeCell key={item.id} freeze={freeze} signature={freeze ? processItemSignature(item, expanded) : `${item.id}:${liveStart}`} build={build} />;
  };

  return (
    <div className="execution-flow" ref={root}>
      {hasProcess && <div className="flow-process">
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
                  {processEntries.map(renderEntry)}
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
