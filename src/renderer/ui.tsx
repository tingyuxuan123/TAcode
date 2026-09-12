import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, Download, Info, MessageCirclePlus, PanelLeftClose, PanelLeftOpen, Target, X } from "lucide-react";
import { Streamdown, defaultRehypePlugins, defaultRemarkPlugins, type Components } from "streamdown";
import type { AgentSessionStats, ExtensionUiRequest, PermissionMode } from "../shared/types";
import { workspacePreviewUrl } from "../shared/preview";
import { skillUserDisplay } from "../shared/skills";
import { visibleUserText, visionResultSections, visionToolChips } from "../shared/vision-api";
import { defaultCustomProfile, type CustomApiProfile } from "../shared/chat-profiles";
import { ProviderListPage, ProviderSetupDialog } from "./provider-dialog";
import { useBackdropClose } from "./use-backdrop-close";
import type { ProviderRecord } from "../shared/types";
import { AppearanceSettings } from "./appearance-settings";
import { effortLabelKey, reasoningLevelsAvailable } from "../shared/thinking";
import type { ModelOption } from "../shared/model-selection";
import { EffortPicker, ModelPicker, usePickerPopover } from "./composer-pickers";
import { PromptToolbar } from "./prompt-toolbar";
import { approvalTitle, baseName, cacheHitRate, collectFileChanges, delegateProgress, delegateStatusLabel, filterMentionPaths, formatCommand, isRecoverableRequestError, liveStatus, repairMarkdownTables, splitHttpUrls, splitPatch, stripEmptyMarkdown, spliceFileMention, toolCommand, toolPath, toolSummary, toolWritePreview, toolWriteSource, traceRows, webSearchCard, workspaceRelative, type ChatImage, type ChatMessage, type DelegateTaskState, type FileChange, type SessionFile, type SessionTodo, type ToolActivity, type TraceRow, type WorkItem } from "./conversation";
import { tokenizeCode } from "./highlight";
import { isTightTableCell } from "./markdown-table";
import type { AgentSkillCommand } from "../shared/skills";
import { PROJECT_SKILL_ROOTS, USER_SKILL_ROOTS, skillSlashCommand } from "../shared/skills";
import { useI18n } from "./i18n";
import { usePanelActions } from "./panel-actions";
import { delegationPanelKey } from "./browser/panel-state";
import type { MessageKey } from "../shared/i18n";
import { ExecutionFlow } from "./execution-flow";
import { startPanelResize } from "./panel-resize";
import { clampInspectWidth, readInspectWidth, shouldAutoCollapseSidebar, writeInspectWidth } from "./panel-width";
import { buildTurnPresentation, toolRow } from "./conversation";
import { SubagentsSettings } from "./subagent-settings";
import logo from "./logo.svg";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { CodeBlock, HighlightedFileCode } from "./codeblock";
import { FilePathChip } from "./file-path-chip";
import { isFilePath } from "./file-path";
import { createStreamSegments } from "./stream-blocks";
import { highlightToTokens, isHighlighterReady, onHighlighterReady } from "./shiki";

const MAX_UPLOAD_IMAGES = 4;
const PATH_MIME = "text/tacode-path";
// 只移动面板标签栏；网页内容仍留在原组件树中，保留 guest 与页面状态。
const PanelTabHeaderContext = createContext<HTMLElement | null>(null);
let treeDragPath = "";

function isPromptFileDrag(transfer: DataTransfer): boolean {
  if (treeDragPath) return true;
  const types = [...transfer.types];
  return types.includes(PATH_MIME) || types.includes("Files");
}

function setDragGhost(transfer: DataTransfer, label: string) {
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.textContent = label;
  document.body.appendChild(ghost);
  transfer.setDragImage(ghost, 16, 14);
  requestAnimationFrame(() => ghost.remove());
}

function beginTreeDrag(event: DragEvent<HTMLElement>, path: string, label: string) {
  treeDragPath = path;
  event.dataTransfer.effectAllowed = "copy";
  // Override the button's default text/html; otherwise contenteditable clones the row.
  event.dataTransfer.setData("text/html", "<span></span>");
  event.dataTransfer.setData(PATH_MIME, path);
  setDragGhost(event.dataTransfer, label);
}

export function Icon({ path, size = 16, className }: { path: string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {path.split("\n").map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

function UserText({ text }: { text: string }) {
  return (
    <>
      {splitHttpUrls(text).map((part, index) =>
        part.type === "url" ? (
          <a
            key={`${part.value}-${index}`}
            className="user-url"
            href={part.value}
            onClick={(event) => {
              event.preventDefault();
              void window.harness.app.openExternal(part.value);
            }}
          >
            {part.value}
          </a>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </>
  );
}

export function UserTurn({ text, images = [], anchor }: { text: string; images?: ChatImage[]; anchor?: string }) {
  const skill = skillUserDisplay(text);
  const shown = skill ? skill.command : visibleUserText(text);
  const [view, setView] = useState<string>();
  const single = images.length === 1;
  return (
    <div className="user-turn" id={anchor}>
      {images.length > 0 && (
        <div className={single ? "user-images single" : "user-images"}>
          {images.map((image, index) => {
            const src = image.src ?? `data:${image.mimeType};base64,${image.data}`;
            return (
              <div key={`${image.mimeType}-${index}`} className="user-image-wrap">
                <button type="button" className={single ? "user-image single" : "user-image"} onClick={() => setView(src)}>
                  <img src={src} alt="" />
                </button>
                <a
                  className="user-image-save"
                  href={src}
                  download={`image-${index + 1}`}
                  aria-label="保存图片"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Download size={14} />
                </a>
              </div>
            );
          })}
        </div>
      )}
      <article className="user">
        {skill ? <code className="user-skill-tag">{shown}</code> : <UserText text={shown} />}
      </article>
      <div className="bubble-actions">
        <CopyAction text={shown} />
      </div>
      {view && createPortal(
        <div className="modal" onClick={() => setView(undefined)} onKeyDown={(event) => { if (event.key === "Escape") setView(undefined); }}>
          <img className="lightbox" src={view} alt="" />
        </div>,
        document.body,
      )}
    </div>
  );
}

export function CopyButton({
  text,
  className = "bubble-action",
  size = 14,
  label,
}: {
  text: string;
  className?: string;
  size?: number;
  label?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async (host: HTMLElement) => {
    const markdown = host.closest(".turn")?.querySelector(".stream .markdown");
    const plain = markdown instanceof HTMLElement
      ? markdown.innerText.replace(/\n{3,}/g, "\n\n").trim()
      : "";
    try {
      await navigator.clipboard.writeText(plain || text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* silent: icon-only affordance already covers the happy path */
    }
  };
  return (
    <button type="button" className={className} aria-label={copied ? t("common.copied") : label ?? t("common.copy")} onClick={(event) => void copy(event.currentTarget)}>
      <Icon path={copied ? "M5 12.5l4 4 10-10" : "M8 8h12v12H8zM4 16V4h12"} size={size} />
    </button>
  );
}

function CopyAction({ text }: { text: string }) {
  if (!text.trim()) return null;
  return <CopyButton text={text} />;
}

export function Dots() {
  return (
    <span className="dots" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => <i key={index} />)}
    </span>
  );
}

function formatDuration(start?: number, end?: number) {
  if (!start) return "";
  const seconds = Math.max(0, ((end ?? Date.now()) - start) / 1000);
  if (seconds < 0.05) return "";
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function Elapsed({ start, end, live }: { start?: number; end?: number; live?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live || !start) return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [live, start]);
  const label = formatDuration(start, live ? now : end);
  if (!label) return null;
  return <time>{label}</time>;
}

export function SidebarNav({
  collapsed,
  onToggle,
  onNew,
  onOpen,
  account,
  children,
}: {
  collapsed: boolean;
  onToggle(): void;
  onNew(): void;
  onOpen(): void;
  account: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <aside className={collapsed ? "sidebar is-collapsed" : "sidebar"}>
      <header className="sidebar-titlebar">
        <div className="sidebar-brand">
          <img className="brand-mark" src={logo} alt="" width={24} height={15} />
          <strong>TACode</strong>
        </div>
        <button
          type="button"
          className="sidebar-toggle"
          onClick={onToggle}
          title={t(collapsed ? "nav.expandSidebar" : "nav.collapseSidebar")}
          aria-label={t(collapsed ? "nav.expandSidebar" : "nav.collapseSidebar")}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeftOpen size={17} strokeWidth={1.8} /> : <PanelLeftClose size={17} strokeWidth={1.8} />}
        </button>
      </header>
      <div className="sidebar-primary">
        <button type="button" className="nav-btn new" onClick={onNew} title={t("nav.newThread")} aria-label={t("nav.newThread")}>
          <Icon path="M12 5v14M5 12h14" />
          <span className="nav-label">{t("nav.newThread")}</span>
        </button>
        <button type="button" className="nav-btn" onClick={onOpen} title={t("nav.projects")} aria-label={t("nav.projects")}>
          <Icon path="M3 7h6l2 2h10v10H3z" />
          <span className="nav-label">{t("nav.projects")}</span>
        </button>
      </div>
      <div className="thread-list">{children}</div>
      <footer className="sidebar-footer">{account}</footer>
    </aside>
  );
}

export function Chat({
  children,
  composer,
  home,
  inspect,
  nav,
  title,
  crumb,
  onSidebarAutoCollapse,
}: {
  children: ReactNode;
  composer?: ReactNode;
  home?: boolean;
  inspect?: ReactNode;
  nav?: ReactNode;
  title?: string;
  crumb?: ReactNode;
  onSidebarAutoCollapse?(): void;
}) {
  const { t } = useI18n();
  const [drawer, setDrawer] = useState(true);
  const [panelHeaderHost, setPanelHeaderHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => window.harness.browser.onAgentPresentation((event) => {
    if (event.action !== "close") setDrawer(true);
  }), []);
  const [preferredInspectWidth, setPreferredInspectWidth] = useState(readInspectWidth);
  const [chatBodyWidth, setChatBodyWidth] = useState<number>();
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const inspectWidth = clampInspectWidth(preferredInspectWidth, chatBodyWidth);
  const widthRef = useRef(inspectWidth);
  widthRef.current = inspectWidth;

  useLayoutEffect(() => {
    const body = chatBodyRef.current;
    if (!body) return;
    const measure = () => setChatBodyWidth(body.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const finishResizeRef = useRef<(() => void) | null>(null);
  const hasInspect = Boolean(inspect);
  useEffect(() => {
    if (!drawer || !hasInspect) finishResizeRef.current?.();
    return () => { finishResizeRef.current?.(); };
  }, [drawer, hasInspect]);

  const startInspectResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    finishResizeRef.current?.();
    const startX = event.clientX;
    const startWidth = widthRef.current;
    let requestedWidth = startWidth;
    finishResizeRef.current = startPanelResize(event.currentTarget, event, (clientX) => {
      requestedWidth = clampInspectWidth(startWidth + startX - clientX);
      const availableWidth = chatBodyRef.current?.clientWidth;
      if (availableWidth !== undefined && shouldAutoCollapseSidebar(startWidth, requestedWidth, availableWidth)) {
        onSidebarAutoCollapse?.();
      }
      widthRef.current = clampInspectWidth(requestedWidth, availableWidth);
      // 保留指针对应的目标，侧栏动画释放空间后仍可继续向目标宽度变化。
      setPreferredInspectWidth(requestedWidth);
    }, () => {
      finishResizeRef.current = null;
      // 松开时固定当前可显示的宽度；之后的侧栏动画只给会话区增加空间。
      const next = clampInspectWidth(requestedWidth, chatBodyRef.current?.clientWidth);
      widthRef.current = next;
      setPreferredInspectWidth(next);
      writeInspectWidth(next);
    });
  };

  return (
    <section className={home ? "chat home" : "chat"}>
      <header className="chat-bar">
        <div className="chat-heading">
          {!home && title && <h1 className="chat-title" title={title}>{title}</h1>}
          {!home && crumb}
          {!home && nav}
        </div>
        <div className={inspect && drawer ? "inspect-heading is-open" : "inspect-heading"} style={{ width: inspect && drawer ? inspectWidth : undefined }}>
          <div className="inspect-header-tabs" ref={setPanelHeaderHost} style={{ display: inspect && drawer ? undefined : "none" }} />
          {inspect && (
            <button
              type="button"
              className={drawer ? "inspect-toggle on" : "inspect-toggle"}
              aria-label={drawer ? t("nav.closeDrawer") : t("nav.openDrawer")}
              onClick={() => setDrawer((current) => !current)}
            >
              <Icon path="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M15.5 4v16" />
            </button>
          )}
          <WindowControls />
        </div>
      </header>
      <div className="chat-body" ref={chatBodyRef}>
        <div className="chat-main">
          {children}
          {composer}
        </div>
        {inspect && (
          <div className="inspect-shell" style={{ width: inspectWidth, display: drawer ? undefined : "none" }}>
            <div
              className="inspect-resize"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("inspect.resize")}
              onPointerDown={startInspectResize}
            />
            <PanelTabHeaderContext.Provider value={panelHeaderHost}>{inspect}</PanelTabHeaderContext.Provider>
          </div>
        )}
      </div>
    </section>
  );
}

/** Caption buttons for the frameless window on Windows/Linux; macOS keeps its traffic lights. */
function WindowControls() {
  const { t } = useI18n();
  if (window.harness.platform === "darwin") return null;
  return (
    <div className="win-controls">
      <button type="button" aria-label={t("nav.minimize")} onClick={() => void window.harness.window.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button type="button" aria-label={t("nav.maximize")} onClick={() => void window.harness.window.toggleMaximize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button type="button" className="close" aria-label={t("nav.closeWindow")} onClick={() => void window.harness.window.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}

export function ContextStats({
  stats,
  model,
  effort,
  effortLevels,
  up,
  running = false,
  busy = false,
  onCompact,
}: {
  stats?: AgentSessionStats;
  model?: string;
  effort?: string;
  effortLevels?: string[];
  up?: boolean;
  running?: boolean;
  busy?: boolean;
  onCompact?(): void;
}) {
  const { t } = useI18n();
  const popover = usePickerPopover(!up, 286, 430);
  const { open, setOpen } = popover;

  const percent = stats?.contextUsage?.percent !== null && stats?.contextUsage?.percent !== undefined
    ? Math.round(stats.contextUsage.percent * 10) / 10
    : undefined;
  const contextTokens = stats?.contextUsage?.tokens ?? (stats?.tokens?.total ? stats.tokens.total : undefined);
  const contextWindow = stats?.contextUsage?.contextWindow ?? 128_000;
  const rate = cacheHitRate(stats?.tokens);
  const canCompact = Boolean(onCompact) && !running && !busy;
  const showCompact = Boolean(onCompact) && percent !== undefined;

  return (
    <div className={`context-stats-wrap${open ? " open" : ""}${up ? " up" : ""}`}>
      <button
        type="button"
        ref={popover.trigger}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popover.id : undefined}
        className={`stats-toggle${open ? " on" : ""}${
          percent !== undefined && percent >= 90 ? " hot" : percent !== undefined && percent >= 80 ? " warm" : ""
        }`}
        aria-label={t("context.monitor")}
        title={t("context.monitor")}
        onClick={() => setOpen((was) => !was)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" className="stats-dial" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.34" />
          {percent !== undefined && (
            <circle
              cx="8"
              cy="8"
              r="6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.34"
              strokeDasharray={40.84}
              strokeDashoffset={40.84 - (Math.min(100, Math.max(0, percent)) / 100) * 40.84}
              strokeLinecap="round"
              transform="rotate(-90 8 8)"
            />
          )}
        </svg>
        <span className="toolbar-label">{percent !== undefined ? `${percent}%` : t("context.label")}</span>
      </button>

      {open && popover.placement && createPortal(
        <div ref={popover.panel} id={popover.id} data-picker-popover={popover.id} data-toolbar-owner={popover.toolbarOwner} className="context-popover picker-panel" role="dialog" aria-label={t("context.title")} style={popover.placement}>
          <div className="context-popover-head">
            <span className="context-popover-title">{t("context.title")}</span>
            {rate !== undefined && (
              <span className="context-badge-hit">
                <i /> {t("context.cacheRate", { rate: rate.toFixed(0) })}
              </span>
            )}
          </div>

          <div className="context-section context-capacity">
            <div className="context-ring-wrap">
              <svg width="48" height="48" viewBox="0 0 48 48" className="context-ring-svg" aria-hidden="true">
                <circle cx="24" cy="24" r="20" fill="none" stroke="var(--line)" strokeWidth="3" />
                {percent !== undefined && (
                  <circle
                    cx="24"
                    cy="24"
                    r="20"
                    fill="none"
                    stroke={percent >= 90 ? "var(--red)" : percent >= 80 ? "var(--accent)" : "var(--green)"}
                    strokeWidth="3"
                    strokeDasharray={125.66}
                    strokeDashoffset={125.66 - (Math.min(100, Math.max(0, percent)) / 100) * 125.66}
                    strokeLinecap="round"
                    transform="rotate(-90 24 24)"
                  />
                )}
              </svg>
              <div className="context-ring-label">
                <strong>{percent !== undefined ? `${percent}%` : "—"}</strong>
                <small>{percent !== undefined ? t("context.used") : t("context.untracked")}</small>
              </div>
            </div>
            <div className="context-capacity-info">
              <span className="context-label">{t("context.capacity")}</span>
              <span className="context-ratio">
                {contextTokens !== undefined ? formatCompactNumber(contextTokens) : "—"} / {formatCompactNumber(contextWindow)}
              </span>
              <small className={`context-hint ${percent && percent >= 80 ? "warn" : ""}`}>
                {percent === undefined
                  ? t("context.waitFirst")
                  : percent >= 90
                    ? t("context.critical")
                    : percent >= 75
                      ? t("context.high")
                      : t("context.ok")}
              </small>
            </div>
            {showCompact && (
              <button
                type="button"
                className="context-compact-btn"
                disabled={!canCompact}
                title={running ? t("toast.waitBeforeCompact") : undefined}
                onClick={() => {
                  if (!canCompact) return;
                  onCompact?.();
                }}
              >
                {busy ? t("context.compacting") : t("context.compact")}
              </button>
            )}
          </div>

          <div className="context-section">
            <div className="context-section-head">
              <span>{t("context.tokenTotal")}</span>
              {stats?.tokens?.total ? (
                <span className="context-token-sum">{t("context.tokenSum", { n: formatCompactNumber(stats.tokens.total) })}</span>
              ) : null}
            </div>
            <div className="context-stat-row">
              <span>{t("context.input")} <b>{stats?.tokens?.input !== undefined ? formatCompactNumber(stats.tokens.input) : "—"}</b></span>
              <span>{t("context.output")} <b>{stats?.tokens?.output !== undefined ? formatCompactNumber(stats.tokens.output) : "—"}</b></span>
            </div>
          </div>

          <div className="context-section">
            <div className="context-section-head">
              <span>{t("context.cacheTitle")}</span>
              <strong className="context-rate-text">{rate !== undefined ? `${rate.toFixed(1)}%` : "—"}</strong>
            </div>
            <div className="context-bar-track">
              <div
                className="context-bar-fill"
                style={{ width: `${Math.min(100, Math.max(0, rate ?? 0))}%` }}
              />
            </div>
            <div className="context-cache-meta">
              <span>{t("context.cacheHit")} <b>{stats?.tokens?.cacheRead ? formatCompactNumber(stats.tokens.cacheRead) : "0"}</b></span>
              {Boolean(stats?.tokens?.cacheWrite) ? (
                <span>{t("context.cacheWrite")} <b>{formatCompactNumber(stats!.tokens.cacheWrite)}</b></span>
              ) : (
                <span>{t("context.cacheMiss")} <b>{stats?.tokens?.input !== undefined ? formatCompactNumber(stats.tokens.input) : "—"}</b></span>
              )}
            </div>
          </div>

          <div className="context-popover-foot">
            <div className="context-foot-item context-foot-item-model">
              <span className="context-foot-label">{t("common.model")}</span>
              <code className="context-model-tag">{model || t("context.defaultModel")}</code>
            </div>
            {reasoningLevelsAvailable(effortLevels ?? []) && effort && (
              <div className="context-foot-row">
                <div className="context-foot-item">
                  <span className="context-foot-label">{t("composer.effort")}</span>
                  <span className="context-effort-val">{t(effortLabelKey(effort))}</span>
                </div>
              </div>
            )}
          </div>
        </div>, document.body,
      )}
    </div>
  );
}

function formatCompactNumber(value: number) {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function TurnNav({ items, onJump }: { items: Array<{ id: string; label: string }>; onJump?(id: string): void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string>();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (items.length < 2) return null;

  /** Last question whose card already scrolled past the top of the reading area.
   *  列表窗口化后，早期轮次不在 DOM 里，所以“当前轮”只能从已挂载的锚点里取；
   *  仍在屏上（或刚滚过顶部）的那一轮一定已挂载，取到的就是用户正在看的那一轮。 */
  const visibleTurn = () => items
    .filter((item) => {
      const node = document.getElementById(item.id);
      if (!node) return false;
      return node.getBoundingClientRect().top < 160;
    })
    .at(-1)?.id;

  return (
    <div ref={box} className={`combo down turn-nav${open ? " open" : ""}`}>
      <button
        type="button"
        className="combo-trigger turn-nav-trigger"
        aria-label={t("context.jumpTurn")}
        onClick={() => {
          setActive(visibleTurn());
          setOpen((was) => !was);
        }}
      >
        <Icon path="M4 6h16M4 12h10M4 18h6" size={14} />
        <span>{t("context.turns", { n: items.length })}</span>
      </button>
      {open && (
        <div className="combo-menu turn-nav-menu" role="listbox">
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={item.id === active ? "combo-item selected" : "combo-item"}
              onClick={() => {
                // 窗口化后目标条目可能还没挂载，`scrollIntoView` 找不到节点，
                // 交给虚拟列表按索引滚动（见 message-list.tsx）。
                if (onJump) onJump(item.id);
                else document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                setActive(item.id);
                setOpen(false);
              }}
            >
              <small>{index + 1}</small>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Thinking({
  text,
  work,
  tools,
  live,
  label,
  startedAt,
  endedAt,
  error,
  errorTone = "strong",
  onRetry,
}: {
  text: string;
  work: WorkItem[];
  tools: ToolActivity[];
  live: boolean;
  label?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  errorTone?: "strong" | "weak";
  onRetry?(): void;
}) {
  const { t, locale } = useI18n();
  const [open, setOpen] = useState(() => Boolean(error && errorTone === "strong"));
  const [dismissedError, setDismissedError] = useState(false);
  const [born] = useState(() => Date.now());
  useEffect(() => {
    if (error && errorTone === "strong") setOpen(true);
  }, [error, errorTone]);
  useEffect(() => {
    setDismissedError(false);
  }, [error]);
  useEffect(() => {
    if (!error || errorTone !== "weak" || live || dismissedError) return;
    const timer = window.setTimeout(() => setDismissedError(true), 4000);
    return () => window.clearTimeout(timer);
  }, [error, errorTone, live, dismissedError]);
  const showError = error && !dismissedError;
  const rows = useMemo(() => traceRows(work, tools, text), [work, tools, text, locale]);
  const start = startedAt ?? (live ? born : undefined);
  const summary = useMemo(
    () => toolSummary(tools, rows.filter((row) => row.kind === "think").length),
    [tools, rows, locale],
  );
  const current = useMemo(() => liveStatus(tools), [tools, locale]);
  const header = live ? label ?? t("think.live") : t("think.done");
  const showLive = live && current !== header;
  const hasBody = rows.length > 0 || showLive || Boolean(showError);
  const expandable = live || hasBody;
  if (!expandable && !live) return null;
  return (
    <div className={live ? (open ? "trace live open" : "trace live") : open ? "trace open" : "trace"}>
      <button type="button" className="trace-toggle" onClick={() => expandable && setOpen((value) => !value)}>
        {live ? <Dots /> : <img className="trace-logo" src={logo} alt="" width={18} height={11} />}
        <span className={live ? "shimmer trace-label" : "trace-label"}>
          {header}
        </span>
        {summary && <span className="trace-subtle">{summary}</span>}
        {!open && showError && (
          <span className={errorTone === "weak" ? "trace-subtle trace-failed weak" : "trace-subtle trace-failed"}>
            {t("trace.requestFailed")}
          </span>
        )}
        <Elapsed start={start} end={endedAt} live={live} />
        {expandable ? <Icon className="chevron" path="M6 9l6 6 6-6" size={14} /> : null}
      </button>
      {open && expandable && (
        <div className="trace-rows">
          {rows.map((row) => <TraceRowView key={row.id} row={row} />)}
          {(showLive || (live && rows.length === 0)) && (
            <div className="trace-row-live">
              <span className="shimmer">{rows.length === 0 ? header : current}</span>
            </div>
          )}
          {showError && (
            <div className={errorTone === "weak" ? "trace-row-wrap weak-error" : "trace-row-wrap error"}>
              <div className="trace-row">
                <button
                  type="button"
                  className="trace-row-dismiss"
                  aria-label={t("common.close")}
                  onClick={() => setDismissedError(true)}
                >
                  <Icon className="trace-row-glyph" path="M18 6L6 18M6 6l12 12" size={13} />
                </button>
                <span className="trace-row-label">{t("trace.requestFailed")}</span>
                <span className="trace-row-chip">{error}</span>
                {onRetry && errorTone === "weak" && (
                  <button type="button" className="ghost" onClick={onRetry}>{t("common.continue")}</button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const TRACE_GLYPHS: Record<TraceRow["kind"], string> = {
  think: "M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z",
  write: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z",
  run: "M4 17l6-5-6-5M12 19h8",
  read: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  look: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  tool: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8v4l2.5 1.5",
};

function TraceRowView({ row }: { row: TraceRow }) {
  const { t } = useI18n();
  const isDelegate = row.tool?.name === "delegate";
  const progress = isDelegate && row.tool ? delegateProgress(row.tool, row.tools) : undefined;
  // total=0 说明还没解析出子任务，此时沿用原来的行文案（不要显示「0 个子代理」）。
  const delegate = progress && progress.total > 0 ? progress : undefined;
  const [open, setOpen] = useState(false);
  const detail = traceDetail(row);
  // 委托行运行中自动展开一次，让拓扑直接出现在对话里；用户手动收起后不再自动弹。
  const delegateRunning = Boolean(delegate?.tasks.some((task) => task.status === "running" || task.status === "pending"));
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!delegateRunning || autoOpened.current) return;
    autoOpened.current = true;
    setOpen(true);
  }, [delegateRunning]);
  const label = delegate ? delegateHeadLabel(t, delegate.tasks) : row.label;
  const chip = delegate
    ? `${t("delegate.headCount", { n: delegate.total })} · ${t("delegate.headRatio", { done: delegate.done, total: delegate.total })}`
    : row.tool?.name === "vision" ? visionToolChips(row.tool.details).join(" · ") : row.chip;
  return (
    <div className={`trace-row-wrap ${row.status ?? ""}${open ? " open" : ""}`}>
      <button
        type="button"
        className="trace-row"
        aria-expanded={open}
        disabled={!detail}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="trace-row-mark">
          <Icon className="trace-row-glyph" path={TRACE_GLYPHS[row.kind]} size={13} />
        </span>
        <span className="trace-row-label">{label}</span>
        {chip && <span className={row.mono || isDelegate ? "trace-row-chip mono" : "trace-row-chip"}>{chip}</span>}
        {detail ? <Icon className="trace-row-chevron chevron" path="M6 9l6 6 6-6" size={12} /> : null}
      </button>
      {open && detail && <div className={isDelegate ? "trace-row-detail is-delegate" : "trace-row-detail"}>{detail}</div>}
    </div>
  );
}

/** 委托行表头文案：运行中 / 完成但有失败 / 全部完成（对齐 PI-Desktop 的 subagent 分组表头）。 */
function delegateHeadLabel(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  tasks: readonly DelegateTaskState[],
): string {
  if (tasks.some((task) => task.status === "running" || task.status === "pending")) return t("delegate.headRunning");
  if (tasks.some((task) => task.status === "failed")) return t("delegate.headIssues");
  return t("delegate.headDone");
}

function traceDetail(row: TraceRow): ReactNode {
  if (row.kind === "think") {
    return row.text ? <div className="trace-detail-text markdown"><Markdown>{row.text}</Markdown></div> : null;
  }
  const tool = row.tool;
  if (!tool) return null;
  if (tool.name === "delegate") {
    return <DelegateDetail tool={tool} tools={row.tools} />;
  }
  const command = formatCommand(toolCommand(tool));
  if (command) return <TerminalBlock command={command} tool={tool} />;
  if (tool.name === "vision") {
    const sections = tool.status === "running" ? [] : visionResultSections(tool.output);
    if (sections.length === 0) return null;
    return (
      <div className="vision-tool">
        {sections.map((section) => (
          <div key={section.label} className="vision-section">
            <strong>{section.label}</strong>
            <p>{section.text.length > 280 ? `${section.text.slice(0, 280)}…` : section.text}</p>
          </div>
        ))}
      </div>
    );
  }
  const web = webSearchCard(tool);
  if (web && (web.sources.length > 0 || web.summary)) {
    return <WebSearchDetail card={web} />;
  }
  // File reads: render markdown sources as rich text and everything else as a
  // numbered, syntax-highlighted block instead of the plain pre fallback below.
  if (/read|cat|view/i.test(tool.name)) {
    const path = toolPath(tool);
    const text = tool.output?.trim() || "";
    if (!text) return null;
    if (/\\.(md|markdown)$/i.test(path)) {
      return <div className="trace-detail-text markdown"><Markdown>{text}</Markdown></div>;
    }
    return (
      <pre className="trace-detail-file">
        {/* 正文已由 read_file 嵌了真实行号，不再叠渲染层序号。 */}
        <HighlightedFileCode code={text} language={path} lineGutter={false} />
      </pre>
    );
  }
  if (/write|edit|patch/i.test(tool.name)) {
    const source = toolWriteSource(tool);
    if (source.patch.trim() || source.plain.trim()) return <WriteDiff tool={tool} />;
  }
  const preview = toolWritePreview(tool, 24);
  const body = preview || tool.output?.trim() || "";
  if (!body) return null;
  return (
    <pre className="trace-detail-code">
      {body.split("\n").slice(0, 24).map((line, index) => (
        <span key={index} className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}>{line}</span>
      ))}
    </pre>
  );
}

function WebSearchDetail({ card }: { card: NonNullable<ReturnType<typeof webSearchCard>> }) {
  return (
    <div className="web-tool">
      {card.summary ? <p className="web-tool-summary">{card.summary}</p> : null}
      {card.sources.map((source) => (
        <button
          key={source.url}
          type="button"
          className="web-source"
          onClick={() => void window.harness.app.openExternal(source.url)}
        >
          <span>{source.title}</span>
          <span className="web-source-host">{source.url.replace(/^https?:\/\//, "")}</span>
        </button>
      ))}
    </div>
  );
}

/** Line number comes from the file the row belongs to: old file for dels, new file otherwise. */
type WriteDiffRow = { kind: "ctx" | "add" | "del" | "plain"; text: string; no?: number };

function writeDiffRows(source: { patch: string; plain: string }): WriteDiffRow[] {
  if (source.patch.trim()) {
    let oldNo = 0;
    let nextNo = 0;
    return splitPatch(source.patch.replace(/\n+$/, ""))
      .filter((row) => row.kind === "ctx" || row.kind === "add" || row.kind === "del")
      .map((row) => ({
        kind: row.kind as WriteDiffRow["kind"],
        text: row.kind === "del" ? row.old : row.next,
        no: row.kind === "del" ? ++oldNo : ++nextNo,
      }));
  }
  return source.plain.replace(/\n+$/, "").split("\n").map((text, index) => ({ kind: "plain" as const, text, no: index + 1 }));
}

/** Inline write diff mirroring the drawer diff: numbered tinted rows with edge markers. */
function WriteDiff({ tool, limit = 24 }: { tool: ToolActivity; limit?: number }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const source = toolWriteSource(tool);
  const rows = writeDiffRows(source);
  const visible = expanded ? rows : rows.slice(0, limit);
  if (rows.length === 0) return null;
  return (
    <div className="write-diff">
      <div className="write-diff-table">
        {visible.map((row, index) => (
          <div key={index} className={`wd-row ${row.kind}`}>
            <i>{row.no}</i>
            <pre>{writeDiffTokens(row.text, source.path)}</pre>
          </div>
        ))}
        {!expanded && rows.length > visible.length && (
          <button type="button" className="wd-more" onClick={() => setExpanded(true)}>
            {t("trace.writeMore", { n: rows.length - visible.length })}
          </button>
        )}
      </div>
    </div>
  );
}

function writeDiffTokens(text: string, path: string): ReactNode {
  const tokens = tokenizeCode(text, path)[0] ?? [];
  if (tokens.length === 0) return " ";
  return tokens.map((token, spot) => token.kind
    ? <em key={spot} className={token.kind}>{token.text}</em>
    : <span key={spot}>{token.text}</span>);
}

/** 聚合委托卡：主智能体节点 + 连线 + 每个子代理一张节点卡（对齐 PI-Desktop 的 subagent 拓扑）；
 * 点击节点在右侧面板打开该子会话，节点右上「详情」按钮打开抽屉。 */
function DelegateDetail({ tool, tools }: { tool: ToolActivity; tools?: ToolActivity[] }) {
  const { t } = useI18n();
  const progress = delegateProgress(tool, tools);
  const details = tool.details && typeof tool.details === "object" ? tool.details as Record<string, unknown> : {};
  const results = Array.isArray(details.results) ? details.results : [];
  const [selected, setSelected] = useState<number | null>(null);
  if (progress.tasks.length === 0) return null;
  const tasks = progress.tasks;
  const total = progress.total || tasks.length;
  const startedAt = tasks.reduce<number | undefined>((min, item) => {
    if (item.startedAt === undefined) return min;
    return min === undefined ? item.startedAt : Math.min(min, item.startedAt);
  }, undefined) ?? tool.startedAt;
  const outputOf = (item: DelegateTaskState) => {
    const result = results.find((entry) => (
      entry
      && typeof entry === "object"
      && (entry as { role?: string }).role === item.role
      && (entry as { task?: string }).task === item.task
    )) as { output?: string; success?: boolean; diff?: string } | undefined;
    const output = typeof result?.output === "string" ? result.output : undefined;
    const diff = typeof result?.diff === "string" && result.diff.trim() ? result.diff.trim() : undefined;
    return diff ? [output, "```diff", diff, "```"].filter(Boolean).join("\n\n") : output;
  };
  const selectedTask = selected !== null ? tasks[selected] : undefined;
  const panelActions = usePanelActions();
  // 点击子代理行 = 在右侧面板打开它的标签（只读转录；没有子会话文件时展示卡片上的报告/活动流）。
  // 详情抽屉保留在行尾 ⓘ 按钮上；只有在桥接不可用（无 context）时才回退到抽屉。
  const openTask = (item: DelegateTaskState, index: number): void => {
    if (!panelActions.openChildSession) {
      setSelected(index);
      return;
    }
    // 身份由「委派 id 或子会话文件名」推导，保证与侧栏点到同一个标签页。
    const key = delegationPanelKey(item.id, item.childSessionPath);
    if (!key) {
      setSelected(index);
      return;
    }
    panelActions.openChildSession(key, {
      role: item.role,
      title: item.task.replace(/\s+/g, " ").trim().slice(0, 60),
      task: item.task,
      ...(item.childSessionPath ? { sessionPath: item.childSessionPath } : {}),
      status: item.status,
      ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
      ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
      ...(item.toolCalls !== undefined ? { toolCalls: item.toolCalls } : {}),
      ...(item.turns !== undefined ? { turns: item.turns } : {}),
      ...(item.usage?.totalTokens !== undefined ? { totalTokens: item.usage.totalTokens } : {}),
      ...(item.recent?.length ? { activity: item.recent } : {}),
      ...(outputOf(item) ? { report: outputOf(item) } : {}),
    });
  };
  return (
    <div className="delegate-tool">
      <div className="delegate-topology">
        <div className="delegate-root">
          <span className="delegate-root-icon" aria-hidden="true"><Target size={16} /></span>
          <span className="delegate-root-copy">
            <strong>{t("delegate.coordinator")}</strong>
            <span>{t("delegate.coordinating", { n: total })}</span>
          </span>
        </div>
        <span className="delegate-connector" aria-hidden="true" />
        <div className="delegate-agents" role="list" aria-label={t("delegate.agentsLabel")}>
          {tasks.map((item, index) => (
            <DelegateTaskRow
              key={`${item.role}-${index}`}
              task={item}
              fallbackStart={startedAt}
              output={outputOf(item)}
              onOpen={() => openTask(item, index)}
              onDetails={() => setSelected(index)}
            />
          ))}
        </div>
      </div>
      {selectedTask && (
        <SubagentDrawer
          task={selectedTask}
          fallbackStart={startedAt}
          output={outputOf(selectedTask)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function DelegateAvatar({ status, large, node }: { status: string; large?: boolean; node?: boolean }) {
  if (node) {
    // 节点头像：Bot 图标 + 右下角状态徽标（完成打勾 / 失败叉 / 进行中亮点），对齐 PI-Desktop。
    return (
      <span className={`delegate-avatar node ${status}`} aria-hidden="true">
        <Bot size={15} />
        <span className="delegate-avatar-badge">
          {status === "completed" ? <Check size={8} />
            : status === "failed" ? <X size={8} />
              : <span className="delegate-avatar-dot" />}
        </span>
      </span>
    );
  }
  return (
    <span className={`delegate-avatar${large ? " lg" : ""} ${status}`} aria-hidden="true">
      {status === "completed" ? <Icon path="M4 12l5 5 11-11" size={large ? 13 : 11} />
        : status === "failed" ? <Icon path="M6 6l12 12M18 6L6 18" size={large ? 13 : 11} />
          : null}
    </span>
  );
}

/** 单个子代理节点卡：状态徽标头像 + 标题行（角色 / 模型 / 状态·耗时）+ 任务摘要 + 步骤或实时预览。
 * 点击卡身 = 在右侧面板打开该子会话的只读转录；右上「详情」按钮 = 打开详情抽屉（活动流 + 最终报告）。 */
function DelegateTaskRow({
  task,
  output,
  fallbackStart,
  onOpen,
  onDetails,
}: {
  task: DelegateTaskState;
  output?: string;
  fallbackStart?: number;
  /** 主操作：打开该子代理的只读转录标签（没有子会话时回落到详情抽屉）。 */
  onOpen(): void;
  /** 打开详情抽屉（活动流 + 最终报告）。 */
  onDetails(): void;
}) {
  const { t } = useI18n();
  const summary = task.task.replace(/\s+/g, " ").trim();
  const [stale, setStale] = useState(false);
  const lastActivity = useRef(Date.now());
  useEffect(() => {
    if (task.status === "running") lastActivity.current = Date.now();
    else setStale(false);
  }, [task.status]);
  useEffect(() => {
    if (task.live?.trim()) lastActivity.current = Date.now();
  }, [task.live]);
  useEffect(() => {
    if (task.status !== "running") return;
    const anchor = task.startedAt ?? fallbackStart;
    const timer = setInterval(() => {
      const quietFor = Date.now() - Math.max(anchor ?? lastActivity.current, lastActivity.current);
      setStale(quietFor >= 120_000);
    }, 15_000);
    return () => clearInterval(timer);
  }, [task.startedAt, fallbackStart, task.status]);
  const running = task.status === "running";
  const showLive = running && Boolean(task.live?.trim());
  const preview = showLive
    ? task.live
    : !running && output ? output.replace(/\s+/g, " ").trim().slice(0, 160) : "";
  const meta = [
    task.toolCalls ? t("delegate.steps", { n: task.toolCalls }) : "",
    task.usage?.totalTokens ? `${task.usage.totalTokens.toLocaleString()} tokens` : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className={`delegate-node ${task.status}${stale ? " stale" : ""}`} role="listitem">
      <button
        type="button"
        className="delegate-node-header"
        title={task.childSessionPath ? t("delegate.openTab") : t("delegate.detailTitle")}
        onClick={onOpen}
      >
        <DelegateAvatar status={task.status} node />
        <span className="delegate-node-copy">
          <span className="delegate-node-title-row">
            <span className="delegate-role">{task.role}</span>
            {task.model && (
              <span className="delegate-node-model" title={`${task.model.providerId}/${task.model.modelId}`}>
                {task.model.modelId}
              </span>
            )}
            <span className="delegate-status">{stale ? t("trace.delegateStale") : delegateStatusLabel(task.status)}</span>
            <Elapsed start={task.startedAt ?? fallbackStart} end={task.completedAt} live={running} />
          </span>
          {summary && <span className="delegate-node-task">{summary}</span>}
          {showLive
            ? <span className="delegate-node-preview live">{preview}</span>
            : meta ? <span className="delegate-task-meta">{meta}</span>
              : preview ? <span className="delegate-node-preview">{preview}</span> : null}
        </span>
      </button>
      <button
        type="button"
        className="delegate-node-details"
        aria-haspopup="dialog"
        aria-label={t("delegate.detailTitle")}
        title={t("delegate.detailTitle")}
        onClick={onDetails}
      >
        <Info size={13} />
      </button>
    </div>
  );
}

/** 子代理详情抽屉：头部元信息 + 任务 + 活动流 + 最终报告（借鉴 PI-Desktop 的子智能体面板）。 */
function SubagentDrawer({
  task,
  output,
  fallbackStart,
  onClose,
}: {
  task: DelegateTaskState;
  output?: string;
  fallbackStart?: number;
  onClose(): void;
}) {
  const { t } = useI18n();
  const activity = task.recent ?? [];
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (event: WindowEventMap["keydown"]): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const running = task.status === "running";
  useEffect(() => {
    const node = bodyRef.current;
    if (node && running) node.scrollTop = node.scrollHeight;
  }, [activity.length, task.live, running]);
  const meta = [
    task.model ? `${task.model.providerId}/${task.model.modelId}` : "",
    delegateStatusLabel(task.status),
    task.toolCalls ? t("delegate.steps", { n: task.toolCalls }) : "",
    task.usage?.totalTokens ? `${task.usage.totalTokens.toLocaleString()} tokens` : "",
  ].filter(Boolean).join(" · ");
  return createPortal(
    <div className="drawer-backdrop" onClick={onClose}>
      <section className="drawer-panel delegate-drawer" role="dialog" aria-modal="true" aria-label={t("delegate.detailTitle")}>
        <header className="drawer-head">
          <DelegateAvatar status={task.status} large />
          <div className="drawer-head-copy">
            <strong>{task.role}</strong>
            <span className="drawer-head-meta">
              {meta}
              {meta && " · "}
              <Elapsed start={task.startedAt ?? fallbackStart} end={task.completedAt} live={running} />
            </span>
          </div>
          <button type="button" className="drawer-close" aria-label={t("common.close")} onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="drawer-body" ref={bodyRef}>
          <p className="delegate-task-text">{task.task}</p>
          {task.childSessionPath && (
            <p className="delegate-task-meta delegate-child-session">
              {t("delegate.detailChildSession")}：<code>{task.childSessionPath}</code>
            </p>
          )}
          <section className="delegate-drawer-section">
            <h4>{t("delegate.detailActivity")}</h4>
            {activity.length === 0 && !task.live?.trim()
              ? <p className="drawer-empty">{t("delegate.detailEmpty")}</p>
              : (
                <ul className="delegate-activity">
                  {activity.map((entry, index) => (
                    <li key={`${entry.at}-${index}`} className={`delegate-activity-item kind-${entry.kind}${entry.isError ? " is-error" : ""}`}>
                      <time>{new Date(entry.at).toLocaleTimeString()}</time>
                      <span>{entry.text}</span>
                    </li>
                  ))}
                  {running && task.live?.trim() && (
                    <li className="delegate-activity-item now"><time aria-hidden="true">•</time><span>{task.live}</span></li>
                  )}
                </ul>
              )}
          </section>
          {output?.trim() && (
            <section className="delegate-drawer-section">
              <h4>{t("delegate.detailReport")}</h4>
              <div className="delegate-task-output markdown">
                <Markdown>{output.trim()}</Markdown>
              </div>
            </section>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function TerminalBlock({ command, tool }: { command: string; tool: ToolActivity }) {
  const { t } = useI18n();
  const [showOutput, setShowOutput] = useState(tool.status === "error");
  const [expandedAll, setExpandedAll] = useState(false);
  const rawOutput = tool.output?.trim() ?? "";
  const hasOutput = Boolean(rawOutput);
  const isRunning = tool.status === "running";
  const isError = tool.status === "error";

  const lines = rawOutput ? rawOutput.split("\n") : [];
  const isTooLong = lines.length > 40;
  const displayOutput = isTooLong && !expandedAll ? `${lines.slice(0, 40).join("\n")}\n…` : rawOutput;

  return (
    <div className={`terminal-box ${tool.status}`}>
      <div className="terminal-bar">
        <div className="terminal-dots">
          <span className="terminal-dot red" />
          <span className="terminal-dot yellow" />
          <span className="terminal-dot green" />
          <span className="terminal-title">{tool.title || t("terminal.command")}</span>
        </div>
        <div className="terminal-actions">
          {isRunning && <span className="terminal-badge running"><i />{t("terminal.running")}</span>}
          {isError && <span className="terminal-badge error">{t("terminal.failed")}</span>}
          {!isRunning && !isError && tool.endedAt && tool.startedAt && (
            <span className="terminal-time">{formatDuration(tool.startedAt, tool.endedAt)}</span>
          )}
          {hasOutput && (
            <button
              type="button"
              className={`terminal-toggle-btn ${showOutput ? "on" : ""}`}
              onClick={() => setShowOutput((v) => !v)}
            >
              {showOutput ? t("terminal.hideOutput") : t("terminal.output")}
            </button>
          )}
        </div>
      </div>
      <div className="terminal-body">
        <div className="terminal-cmd-row">
          <span className="terminal-prompt">$</span>
          <pre className="terminal-cmd-text">{command}</pre>
        </div>
      </div>
      {showOutput && hasOutput && (
        <div className={`terminal-output ${isError ? "error" : ""}`}>
          <pre>{displayOutput}</pre>
          {isTooLong && (
            <button
              type="button"
              className="terminal-expand-btn"
              onClick={() => setExpandedAll((v) => !v)}
            >
              {expandedAll ? t("terminal.collapse") : t("terminal.expandAll", { n: lines.length })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Fold({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  return (
    <section className={open ? "fold open" : "fold"}>
      <button type="button" className="fold-head" onClick={onToggle}>
        {title}
        <Icon className="chevron" path="M6 9l6 6 6-6" size={14} />
      </button>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}

function copyMarkdownPlain(event: { preventDefault(): void; clipboardData: DataTransfer | null }) {
  const selected = window.getSelection()?.toString();
  if (!selected) return;
  event.preventDefault();
  event.clipboardData?.setData("text/plain", selected);
}

export function Markdown({ children, streaming }: { children: string; streaming?: boolean }) {
  // 流式中不做任何整段预处理：那些修复都要扫全文，正是「运行中卡」的来源。
  // 定稿后再做一次全文修复（表格 / 空围栏 / 空白压缩）。
  const source = useMemo(
    () => (streaming ? children : compactFencedCode(stripEmptyMarkdown(repairMarkdownTables(children)))),
    [children, streaming],
  );
  // 分段缓存的一生只服务一条持续追加的文本，所以按实例持有（见 stream-blocks.ts）。
  const segments = useRef<((text: string) => string[]) | null>(null);
  if (!segments.current) segments.current = createStreamSegments();
  if (!source.trim()) return null;
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      // 尾部修补改由分段器只对最后一段做：remend 会扫全文，是流式每帧 O(累积文本) 的一环，
      // 而更早的段都是已闭合的 markdown，本来就不需要补。
      parseIncompleteMarkdown={false}
      // 只有流式走分段；定稿时交回 Streamdown 的整段分块，保证最终 DOM 与分块语义不变。
      parseMarkdownIntoBlocksFn={streaming ? segments.current : undefined}
      // 流式时启用 Streamdown 的逐词淡入：它按「已渲染字符数」记账，只给真正新增的
      // 文本节点包淡入 span，旧内容不会重放动画（StrictMode 也有专门的 rewind 兜底）。
      // 注意 animated 只负责建时间线，插件要 isAnimating 为真才会挂进渲染链。
      // 动画的 keyframes 由宿主 CSS 提供（见 styles.css 的 [data-sd-animate]）。
      animated={streaming ? STREAMDOWN_ANIMATE_OPTIONS : undefined}
      isAnimating={streaming}
      // 关掉它自带的代码块/表格工具条：那些控件用 Tailwind 类排版，本仓库是纯 CSS；
      // 代码块与表格都由下面的 components 接管。
      controls={false}
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {source}
    </Streamdown>
  );
}

/** 流式落字的逐词淡入参数（引用必须稳定，避免 Streamdown 每帧重建动画时间线）。 */
const STREAMDOWN_ANIMATE_OPTIONS = { animation: "fadeIn", duration: 160, stagger: 32, maxBacklogMs: 240 } as const;

/**
 * 插件数组与自定义组件必须是**稳定引用**。
 *
 * `hast-util-to-jsx-runtime` 用 `components[tagName]` 直接当元素类型：内联箭头函数每
 * 次渲染都是新类型，React 会判定「换了类型」而卸载并重建整棵子树。流式期间该函数每
 * 帧执行一次，于是每个动画帧都在拆掉再重建 Markdown 子树（连带 CodeBlock 的高亮状态
 * 与滚动容器的度量），这正是会话运行中渲染进程满载的主因。
 */
// 导出供流式落字路径的对照测量复用（scripts/fixtures/stream-live-text.tsx）：
// 只比较「整段分块」与「分段渲染」，其余渲染管线必须完全一致。
export const MARKDOWN_REMARK_PLUGINS = [...Object.values(defaultRemarkPlugins), remarkMath];
export const MARKDOWN_REHYPE_PLUGINS = [...Object.values(defaultRehypePlugins), rehypeKatex];
export const MARKDOWN_COMPONENTS: Components = {
  // Streamdown 默认把强调渲染成 `<span class="font-semibold">`、把图片包进一层带下载/放大
  // 控件的外层，而那些样式全是 Tailwind 类名——本仓库是纯 CSS，没有 Tailwind，样式会直接丢。
  // 这里恢复语义标签与裸 `<img>`，继续吃 styles.css 里现有的 .markdown 规则。
  strong({ node: _node, children, ...props }) {
    return <strong {...props}>{children}</strong>;
  },
  img({ node: _node, ...props }) {
    return <img {...props} />;
  },
  // Streamdown 默认把链接渲染成按钮（走它自带的链接安全弹层，且用 Tailwind 类排版）。
  // 本仓库是纯 CSS，链接保持普通 <a>：主进程的 will-navigate / setWindowOpenHandler
  // 已经负责把外链交给系统浏览器（与改造前一致）。
  a({ node: _node, children, ...props }) {
    return <a {...props}>{children}</a>;
  },
  pre({ children }) {
    const plain = extractNodeText(children).trim();
    if (!plain) return null;
    return <CodeBlock>{children}</CodeBlock>;
  },
  code({ children, className, ...props }) {
    // 块级代码（带 language- 前缀）：交给 pre → CodeBlock 渲染，这里不再处理。
    if (className) return <code className={className} {...props}>{children}</code>;
    const plain = extractNodeText(children).trim();
    if (!plain) return null;
    // 行内 code 若是文件路径，渲染成可点击的文件 chip。
    if (isFilePath(plain)) return <FilePathChip filePath={plain} />;
    return <code {...props}>{children}</code>;
  },
  // 宽表格改为横向滚动容器：否则长内容列会把短标签列压到每行只剩一个字。
  table({ node: _node, children, ...props }) {
    return <div className="md-table-wrap"><table {...props}>{children}</table></div>;
  },
  th({ node: _node, children, ...props }) {
    return <th {...tightCellProps(children, props)}>{children}</th>;
  },
  td({ node: _node, children, ...props }) {
    return <td {...tightCellProps(children, props)}>{children}</td>;
  },
};

/**
 * 给「短标签」单元格加 `is-tight`（CSS 侧 `white-space: nowrap`）。
 * 只透传 react-markdown 给的 DOM 属性（`style` 承载 GFM 对齐），`node` 不落到 DOM 上。
 */
function tightCellProps(
  children: ReactNode,
  props: { style?: CSSProperties; className?: string },
): { style?: CSSProperties; className?: string } {
  const tight = isTightTableCell(extractNodeText(children));
  return { ...props, className: tight ? "is-tight" : props.className };
}

/** Drop blank lines inside fenced code so SVG/XML dumps don't look double-spaced. */
function compactFencedCode(text: string): string {
  return text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_full, lang: string, body: string) => {
    const tight = body.replace(/\n{2,}/g, "\n").replace(/^\n+|\n+$/g, "");
    return `\`\`\`${lang}\n${tight}\n\`\`\``;
  });
}

function extractNodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractNodeText).join("");
  if (typeof node === "object" && "props" in node) {
    return extractNodeText((node as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

export function StreamingText({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  if (!text && !streaming) return null;
  return (
    <div className={streaming ? "stream live" : "stream"}>
      {text ? (
        <div className="markdown">
          <Markdown streaming={streaming}>{text}</Markdown>
        </div>
      ) : null}
      {streaming ? <span className="caret" aria-hidden="true" /> : null}
    </div>
  );
}

const renderFlowText = (text: string, streaming?: boolean) => <Markdown streaming={streaming}>{text}</Markdown>;
const renderFlowTool = (tool: ToolActivity) => traceDetail(toolRow(tool));

export const AssistantTurn = memo(function AssistantTurn({
  messages,
  running = false,
  awaiting = false,
  stopping = false,
  canAutoCollapse,
  onOpenFile,
  onOpenPath,
  errorRecovered = false,
  recoverableFailStreak = 0,
  onRetry,
}: {
  messages: ChatMessage[];
  running?: boolean;
  awaiting?: boolean;
  stopping?: boolean;
  canAutoCollapse(): boolean;
  onOpenFile?(file: FileChange): void;
  /** 过程区文件行（读取/写入/编辑）点击时开右侧文件标签。 */
  onOpenPath?(path: string): void;
  errorRecovered?: boolean;
  recoverableFailStreak?: number;
  onRetry?(): void;
}) {
  const view = useMemo(() => buildTurnPresentation(messages), [messages]);
  const tools = view.tools;
  const text = view.replyText;
  const rawError = messages.map((item) => item.error).find(Boolean);
  const recoverable = isRecoverableRequestError(rawError);
  const errorTone = rawError
    ? (recoverable
      ? (errorRecovered ? "hidden" : recoverableFailStreak >= 2 ? "strong" : "weak")
      : "strong")
    : "hidden";
  const error = errorTone === "hidden" ? undefined : rawError;
  const live = running || awaiting;
  const streaming = !stopping && messages.some((item) => item.streaming);
  const interrupted = messages.some((item) => item.interrupted) || tools.some((tool) => tool.interrupted);
  const started = messages.find((item) => item.timestamp)?.timestamp ?? tools[0]?.startedAt;
  const ended = Math.max(0, ...messages.map((item) => item.endedAt ?? 0));
  const changes = useMemo(() => collectFileChanges(tools), [tools]);
  return (
    <article className="turn" data-scroll-anchor={messages[0]?.id} onCopy={copyMarkdownPlain}>
      <ExecutionFlow
        view={view}
        live={live}
        streaming={streaming}
        awaiting={awaiting}
        stopping={stopping}
        interrupted={interrupted}
        error={error}
        errorTone={errorTone === "weak" ? "weak" : "strong"}
        clock={live || ended ? <Elapsed start={started} end={ended || undefined} live={live} /> : null}
        canAutoCollapse={canAutoCollapse}
        onRetry={onRetry}
        onOpenFile={onOpenPath}
        renderText={renderFlowText}
        renderTool={renderFlowTool}
      />
      <ChangeSummary files={changes} onOpen={onOpenFile} />
      {!live && text.trim() && (
        <div className="bubble-actions assistant">
          <CopyAction text={text} />
        </div>
      )}
    </article>
  );
});

function fileGlyph(path: string) {
  return /\.(tsx?|jsx?|mjs|cjs|css|json|ya?ml)$/i.test(path) ? "M8 8l-4 4 4 4M16 8l4 4-4 4" : "M6 3h9l5 5v13H6z";
}

export type PanelTab = { id: string; label: string; title?: string };

export type PanelAddItem = { type: string; label: string; icon: ReactNode; hint?: string };

/**
 * Feature tab container for the right-hand panel. Renders a tab bar across the
 * top of the panel (tabs left, "+" right) with the active tab panel below.
 * "+" opens a small anchored menu of addable panel types (single-instance
 * types already open can be omitted by the caller).
 */
export function PanelTabs({
  tabs,
  active,
  onSelect,
  addItems,
  onPickType,
  onCloseTab,
  flush = false,
  children,
}: {
  tabs: PanelTab[];
  active: string;
  onSelect(id: string): void;
  /** Addable panel types shown in the "+" dropdown (already-open single-instance types should be filtered out). */
  addItems?: PanelAddItem[];
  onPickType?(type: string): void;
  /** Show a close control per tab (open panels can be dismissed). */
  onCloseTab?(id: string): void;
  /** No padding/scroll body — for full-bleed panes like the browser. */
  flush?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const headerHost = useContext(PanelTabHeaderContext);
  const [addMenuPos, setAddMenuPos] = useState<{ top: number; left: number } | null>(null);
  const addWrapRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const tabLayoutKey = tabs.map((tab) => `${tab.id}:${tab.label}`).join("\n");

  useEffect(() => {
    tabListRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabLayoutKey, headerHost]);

  useEffect(() => {
    if (!addMenuPos) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        (addWrapRef.current && addWrapRef.current.contains(target)) ||
        (addMenuRef.current && addMenuRef.current.contains(target))
      ) {
        return;
      }
      setAddMenuPos(null);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuPos(null);
    };
    const close = () => setAddMenuPos(null);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [addMenuPos]);

  const openAddMenu = (): void => {
    const rect = addWrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 200;
    const estimatedHeight = (addItems?.length ?? 0) * 40 + 8;
    let top = rect.bottom + 6;
    if (top + estimatedHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - estimatedHeight - 6);
    }
    setAddMenuPos({ top, left: Math.max(8, rect.right - width) });
  };

  const tabHeader = (
    <div className="inspect-tabs">
      <div className="inspect-tab-list" role="tablist" ref={tabListRef}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === active}
            className={tab.id === active ? "inspect-tab active" : "inspect-tab"}
            title={tab.title || tab.label}
            onClick={() => onSelect(tab.id)}
          >
            <span className="inspect-tab-label">{tab.label}</span>
            {onCloseTab && (
              <span
                className="inspect-tab-close"
                role="button"
                aria-label={t("panel.closeTab")}
                title={t("panel.closeTab")}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <X size={11} strokeWidth={2.2} />
              </span>
            )}
          </button>
        ))}
      </div>
      {addItems && addItems.length > 0 && onPickType && (
        <div className="inspect-add-wrap" ref={addWrapRef}>
          <button
            type="button"
            className="inspect-tab-add"
            aria-label={addItems.length === 1 ? addItems[0].label : t("panel.openTab")}
            title={addItems.length === 1 ? addItems[0].label : t("panel.openTab")}
            aria-expanded={addItems.length > 1 ? addMenuPos !== null : undefined}
            onClick={() => {
              if (addItems.length === 1) onPickType(addItems[0].type);
              else if (addMenuPos) setAddMenuPos(null);
              else openAddMenu();
            }}
          >
            <Icon path="M12 5v14M5 12h14" size={14} />
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="inspect">
      {headerHost ? createPortal(tabHeader, headerHost) : tabHeader}
      <div className={flush ? "inspect-body flush" : "inspect-body"}>{children}</div>
      {addMenuPos &&
        createPortal(
          <div
            ref={addMenuRef}
            className="panel-add-menu"
            style={{ top: addMenuPos.top, left: addMenuPos.left }}
            role="menu"
          >
            {(addItems ?? []).map((item) => (
              <button
                key={item.type}
                type="button"
                className="panel-add-item"
                role="menuitem"
                onClick={() => {
                  setAddMenuPos(null);
                  onPickType?.(item.type);
                }}
              >
                <span className="panel-add-item-icon">{item.icon}</span>
                <span>{item.label}</span>
                {item.hint && <span className="panel-add-item-hint">{item.hint}</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

export type PanelPickerItem = {
  id: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  hint?: string;
};

/**
 * 「打开标签页」选择器：面板内没有任何标签时，直接占满面板居中展示，
 * 以卡片列出可打开的面板类型（对齐设计稿的空态）。
 */
export function PanelPicker({
  title,
  subtitle,
  items,
  onPick,
}: {
  title: string;
  subtitle: string;
  items: PanelPickerItem[];
  onPick(id: string): void;
}) {
  return (
    <div className="panel-picker">
      <div className="panel-picker-body">
        <h2 className="panel-picker-title">{title}</h2>
        <p className="panel-picker-subtitle">{subtitle}</p>
        <div className="panel-picker-list">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="panel-picker-item"
              disabled={item.disabled}
              onClick={() => onPick(item.id)}
            >
              <span className="panel-picker-icon">{item.icon}</span>
              <span className="panel-picker-label">{item.label}</span>
              {item.hint && <span className="panel-picker-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 通用确认对话框（对齐 App 内 sandboxAsk 的 modal 结构），挂在 body 上避免被面板
 * 裁剪。可选「不再询问」勾选由调用方持久化。
 */
export function ConfirmDialog({ title, detail, confirmLabel, cancelLabel, dontAskLabel, dontAsk, onDontAskChange, onConfirm, onCancel }: {
  title: string;
  detail?: string;
  confirmLabel: string;
  cancelLabel: string;
  dontAskLabel?: string;
  dontAsk?: boolean;
  onDontAskChange?(next: boolean): void;
  onConfirm(): void;
  onCancel(): void;
}) {
  return createPortal(
    <div
      className="modal"
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        onCancel();
      }}
    >
      <div className="panel" role="dialog" aria-modal="true">
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
        {dontAskLabel && onDontAskChange && (
          <label className="modal-dont-ask">
            <input type="checkbox" checked={dontAsk ?? false} onChange={(event) => onDontAskChange(event.target.checked)} />
            <span>{dontAskLabel}</span>
          </label>
        )}
        <div className="row-actions">
          <button type="button" className="ghost" onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className="primary" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 主聊天「选中文字 → 在侧边聊天中询问」浮出工具条（对齐 Codex 的
 * selection overlay）。监听全局 selectionchange，只在转录容器内的非空选区上
 * 显示；按钮位置跟随选区首行，portal 到 body 避免被虚拟化列表裁剪。
 */
export function SelectionAskBar({ containerClassName = "conversation", onAsk }: {
  /** 转录滚动容器的 className（App 里是 .conversation / .conversation.home）。 */
  containerClassName?: string;
  onAsk(text: string): void;
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<{ top: number; left: number; text: string } | null>(null);

  useEffect(() => {
    const selector = containerClassName.split(/\s+/).map((name) => `.${name}`).join("");
    let frame = 0;
    const update = () => {
      frame = 0;
      const container = document.querySelector(selector);
      const selection = document.getSelection();
      if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        setAnchor(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
      // 只认转录区里的选区；输入框/命令菜单里的选择不触发。
      if (!element || !container.contains(element) || element.closest("input, textarea, [contenteditable='true'], .slash-menu")) {
        setAnchor(null);
        return;
      }
      const text = selection.toString().trim();
      if (!text) {
        setAnchor(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        setAnchor(null);
        return;
      }
      const top = rect.top > 52 ? rect.top - 44 : Math.min(rect.bottom + 10, window.innerHeight - 52);
      const centered = rect.left + rect.width / 2;
      const left = Math.min(Math.max(centered, 96), window.innerWidth - 96);
      setAnchor({ top, left, text });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // 任何滚动都可能移动选区的视口位置（含转录内的代码块），rAF 去重后重算即可。
    const onScroll = () => schedule();
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [containerClassName]);

  if (!anchor) return null;
  return createPortal(
    <div className="selection-ask-bar" role="toolbar" style={{ top: anchor.top, left: anchor.left }}>
      <button
        type="button"
        onClick={() => {
          const text = anchor.text;
          setAnchor(null);
          document.getSelection()?.removeAllRanges();
          onAsk(text);
        }}
      >
        <MessageCirclePlus size={13} strokeWidth={1.8} aria-hidden="true" />
        <span>{t("selection.askInSideChat")}</span>
      </button>
    </div>,
    document.body,
  );
}

export function InspectPanel({
  files = [],
  todos,
  running,
  planApproval = false,
  onApprovePlan,
  onRefinePlan,
  onOpen,
  onUndo,
}: {
  files?: SessionFile[];
  todos: SessionTodo[];
  running?: boolean;
  planApproval?: boolean;
  onApprovePlan?(): void;
  onRefinePlan?(text: string): void;
  onOpen(file: FileChange): void;
  onUndo?(): void;
}) {
  const { t } = useI18n();
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineText, setRefineText] = useState("");
  const [changesOpen, setChangesOpen] = useState(true);
  const dragging = useRef(false);
  const edits = files.filter((file) => file.kind === "edit");
  if (edits.length === 0 && todos.length === 0 && !planApproval) {
    return <div className="inspect-pane"><p className="panel-empty">{t("inspect.noReview")}</p></div>;
  }
  return (
    <div className="inspect-pane">
      {planApproval && onApprovePlan && (
        <div className="plan-approval">
          <p>{t("plan.approvalHint")}</p>
          <div className="plan-approval-actions">
            <button type="button" className="primary" onClick={onApprovePlan}>{t("plan.approve")}</button>
            <button
              type="button"
              className="ghost"
              onClick={() => setRefineOpen((current) => !current)}
            >
              {t("plan.refine")}
            </button>
          </div>
          {refineOpen && onRefinePlan && (
            <div className="plan-refine">
              <textarea
                value={refineText}
                onChange={(event) => setRefineText(event.target.value)}
                placeholder={t("plan.refinePlaceholder")}
                rows={3}
              />
              <button
                type="button"
                className="ghost"
                disabled={!refineText.trim()}
                onClick={() => {
                  const text = refineText.trim();
                  if (!text) return;
                  onRefinePlan(text);
                  setRefineText("");
                  setRefineOpen(false);
                }}
              >
                {t("plan.refineSubmit")}
              </button>
            </div>
          )}
        </div>
      )}
      {edits.length > 0 && (
        <Fold title={t("inspect.changes")} open={changesOpen} onToggle={() => setChangesOpen((current) => !current)}>
          <div className="inspect-changes">
            {edits.map((file) => (
              <button
                key={file.path}
                type="button"
                className="inspect-file edit"
                draggable
                onDragStart={(event) => {
                  dragging.current = true;
                  beginTreeDrag(event, file.path, baseName(file.path));
                }}
                onDragEnd={() => {
                  treeDragPath = "";
                  requestAnimationFrame(() => { dragging.current = false; });
                }}
                onClick={() => {
                  if (dragging.current) return;
                  onOpen(file);
                }}
              >
                <Icon path={fileGlyph(file.path)} size={14} />
                <span>{baseName(file.path)}</span>
                <small>
                  {file.additions > 0 ? <b className="add">+{file.additions}</b> : null}
                  {file.deletions > 0 ? <b className="del">-{file.deletions}</b> : null}
                  {file.additions === 0 && file.deletions === 0 ? t("inspect.changed") : null}
                </small>
              </button>
            ))}
            {onUndo && !running && (
              <button type="button" className="inspect-undo" onClick={onUndo}>{t("inspect.undo")}</button>
            )}
          </div>
        </Fold>
      )}
    </div>
  );
}

function ChangeSummary({ files, onOpen }: { files: FileChange[]; onOpen?(file: FileChange): void }) {
  if (files.length === 0) return null;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return (
    <div className="changes">
      {(additions > 0 || deletions > 0) && (
        <>
          <span className="add">+{additions}</span>
          <span className="del">-{deletions}</span>
        </>
      )}
      {files.map((file) => (
        <button key={file.path} type="button" className="change-file" onClick={() => onOpen?.(file)}>
          {baseName(file.path)}
          {(file.additions > 0 || file.deletions > 0) && (
            <small>
              {file.additions > 0 ? `+${file.additions}` : ""}
              {file.deletions > 0 ? ` -${file.deletions}` : ""}
            </small>
          )}
        </button>
      ))}
    </div>
  );
}

export function FileDrawer({ file, workspace, onClose }: { file: FileChange; workspace?: string; onClose(): void }) {
  const { t } = useI18n();
  const [body, setBody] = useState(() => t("preview.reading"));
  const [wide, setWide] = useState(false);
  const markdown = /\.(md|markdown)$/i.test(file.path);
  const html = /\.html?$/i.test(file.path);
  const [rendered, setRendered] = useState(markdown);
  const [diffOpen, setDiffOpen] = useState(false);
  useEffect(() => {
    setDiffOpen(false);
    setRendered(markdown);
  }, [file.path, markdown]);
  useEffect(() => {
    let gone = false;
    setBody(t("preview.reading"));
    void window.harness.workspace.read(file.path, workspace).then(
      (result) => {
        if (!gone) setBody(result.binary ? t("preview.binary") : result.content);
      },
      (error: unknown) => {
        if (!gone) setBody(error instanceof Error ? error.message : String(error));
      },
    );
    return () => {
      gone = true;
    };
  }, [file.path, workspace, t]);
  const preview = rendered && (markdown || html);
  const diff = Boolean(file.patch && diffOpen && !preview);
  return (
    <aside className={wide ? "drawer wide" : "drawer"}>
      <header>
        <div>
          <strong>{baseName(file.path)}</strong>
          <small>{file.path}</small>
        </div>
        {file.patch ? (
          <button
            type="button"
            className={diffOpen ? "diff-toggle on" : "diff-toggle"}
            onClick={() => {
              setDiffOpen((open) => !open);
              setRendered(false);
            }}
          >
            {diffOpen ? t("preview.currentFile") : t("preview.viewDiff")}
            {file.additions > 0 && <b className="add">+{file.additions}</b>}
            {file.deletions > 0 && <b className="del">-{file.deletions}</b>}
          </button>
        ) : (
          <span>
            {file.additions > 0 && <b className="add">+{file.additions}</b>}
            {file.deletions > 0 && <b className="del">-{file.deletions}</b>}
          </span>
        )}
        {(markdown || html) && (
          <button
            type="button"
            className={preview ? "drawer-btn on" : "drawer-btn"}
            aria-label={preview ? t("preview.source") : t("preview.preview")}
            onClick={() => setRendered((current) => !current)}
          >
            <Icon
              path={
                preview
                  ? "M15 7l5 5-5 5M9 17l-5-5 5-5"
                  : "M3.5 12s3.2-6.5 8.5-6.5S20.5 12 20.5 12 17.3 18.5 12 18.5 3.5 12 3.5 12M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5"
              }
              size={15}
            />
          </button>
        )}
        <CopyButton text={body} className="drawer-btn" size={15} />
        <button type="button" className="drawer-btn" aria-label={t("preview.open")} onClick={() => void window.harness.workspace.open(file.path, workspace)}>
          <Icon path="M13.5 5.5H18.5V10.5M18.5 5.5L11 13M10 5.5H6.5V18.5H18.5V14" size={15} />
        </button>
        <button type="button" className="drawer-btn" aria-label={wide ? t("preview.restore") : t("preview.expand")} onClick={() => setWide((current) => !current)}>
          <Icon
            path={
              wide
                ? "M5 13.5h5.5V19M19 10.5h-5.5V5M13.5 19v-5.5H19M10.5 5v5.5H5"
                : "M14.5 5H19V9.5M9.5 19H5V14.5M19 14.5V19H14.5M5 9.5V5H9.5"
            }
            size={15}
          />
        </button>
        <button type="button" className="drawer-btn drawer-close" aria-label={t("common.close")} onClick={onClose}>
          <Icon path="M7 7l10 10M17 7L7 17" size={15} />
        </button>
      </header>
      {diff && (
        <div className="file-diff">
          {splitView(file.patch!).map((row, index) => (
            <div key={index} className={`diff-line ${row.kind}`}>
              <i>{row.left ?? ""}</i>
              <i>{row.right ?? ""}</i>
              <b>{row.kind === "add" ? "+" : row.kind === "del" ? "-" : " "}</b>
              <pre>{(row.kind === "del" ? row.old : row.next) || " "}</pre>
            </div>
          ))}
        </div>
      )}
      {diff ? null : preview && html ? (
        <iframe
          className="file-frame"
          title={t("preview.title", { path: file.path })}
          src={previewUrl(file.path)}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      ) : preview ? (
        <div className="file-preview markdown">
          <Markdown>{body}</Markdown>
        </div>
      ) : (
        <pre className="file-code" key={file.path}>
          <HighlightedFileCode code={body} language={file.path} />
        </pre>
      )}
    </aside>
  );
}

function splitView(patch: string) {
  let oldNo = 0;
  let nextNo = 0;
  return splitPatch(patch).filter((row) => row.kind !== "meta").map((row) => ({
    ...row,
    left: row.kind === "add" ? undefined : ++oldNo,
    right: row.kind === "del" ? undefined : ++nextNo,
  }));
}

/** Served by the main process from the workspace, so relative assets and page storage both work. */
const previewUrl = workspacePreviewUrl;

function mentionAt(text: string, cursor: number): { start: number; query: string } | undefined {
  const before = text.slice(0, cursor);
  const start = before.lastIndexOf("@");
  if (start < 0) return;
  if (start > 0 && !/\s/.test(before[start - 1]!)) return;
  const query = before.slice(start + 1);
  if (/[\s@]/.test(query)) return;
  return { start, query };
}

function promptTokenLength(el: HTMLElement): number {
  if (el.dataset.url) return el.dataset.url.length;
  if (el.dataset.file) return `@${el.dataset.file}`.length;
  return 0;
}

function serializePrompt(root: HTMLElement): string {
  let out = "";
  const push = (chunk: string) => {
    if (!chunk) return;
    if (out && !/\s$/.test(out) && !/^\s/.test(chunk)) out += " ";
    out += chunk;
  };
  const walk = (parent: Node) => {
    for (const node of parent.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += (node.textContent ?? "").replace(/\u00a0/g, " ");
        continue;
      }
      if (!(node instanceof HTMLElement)) continue;
      if (node.dataset.url) push(node.dataset.url);
      else if (node.dataset.file) push(`@${node.dataset.file}`);
      else if (node.tagName === "BR") out += "\n";
      else if (!node.dataset.image) walk(node);
    }
  };
  walk(root);
  return out;
}

function caretOffset(root: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !root.contains(sel.anchorNode)) return serializePrompt(root).length;
  const endNode = sel.anchorNode;
  const endOff = sel.anchorOffset;
  let offset = 0;
  const visit = (node: Node): boolean => {
    if (node === endNode && node.nodeType === Node.TEXT_NODE) {
      offset += endOff;
      return true;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0;
      return false;
    }
    if (node instanceof HTMLElement && (node.dataset.url || node.dataset.file || node.dataset.image)) {
      offset += promptTokenLength(node);
      return node === endNode || node.contains(endNode);
    }
    for (const child of node.childNodes) {
      if (visit(child)) return true;
    }
    return false;
  };
  for (const child of root.childNodes) {
    if (visit(child)) break;
  }
  return offset;
}

function placeCaret(root: HTMLElement, offset: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  let left = offset;
  const range = document.createRange();
  const visit = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const size = node.textContent?.length ?? 0;
      if (left <= size) {
        range.setStart(node, Math.max(0, left));
        range.collapse(true);
        return true;
      }
      left -= size;
      return false;
    }
    if (node instanceof HTMLElement && (node.dataset.url || node.dataset.file || node.dataset.image)) {
      const size = promptTokenLength(node);
      if (left <= size) {
        range.setStartAfter(node);
        range.collapse(true);
        return true;
      }
      left -= size;
      return false;
    }
    for (const child of node.childNodes) {
      if (visit(child)) return true;
    }
    return false;
  };
  for (const child of root.childNodes) {
    if (visit(child)) {
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
  }
  range.selectNodeContents(root);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function droppedAbsPath(file: File): string {
  const path = (file as File & { path?: string }).path;
  return typeof path === "string" ? path : "";
}

function hydratePrompt(root: HTMLElement, text: string): void {
  const images = [...root.querySelectorAll<HTMLElement>("[data-image]")];
  root.replaceChildren();
  if (text) root.append(document.createTextNode(text));
  for (const image of images) root.append(image);
}

function flattenPromptBlocks(root: HTMLElement): void {
  for (const el of [...root.querySelectorAll(".inspect-file")]) el.remove();
  for (const block of [...root.querySelectorAll<HTMLElement>("div, p")]) {
    if (block.dataset.url || block.dataset.file || block.dataset.image) continue;
    block.replaceWith(...block.childNodes);
  }
}

function isPromptEmpty(root: HTMLElement): boolean {
  return !serializePrompt(root).trim();
}

function stripHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.textContent ?? "";
}

export function PromptBar({
  fillText,
  fillToken = 0,
  onSubmit,
  onStop,
  steering,
  rootRef,
  running,
  stopping = false,
  disabled,
  workspace,
  onPickWorkspace,
  model,
  modelKey,
  models,
  onModel,
  effort,
  effortLevels,
  onEffort,
  permission,
  onPermission,
  onCommand,
  builtinCommands = [],
  stats,
  onCompact,
  skillCommands = [],
  placement = "dock",
}: {
  /** Parent bumps fillToken when it wants to inject/clear the composer (edit queue, restore, reset). */
  fillText?: string;
  fillToken?: number;
  onSubmit(text?: string, images?: string[]): void;
  onStop(): void;
  steering?: string[];
  rootRef?: Ref<HTMLDivElement>;
  running: boolean;
  /** 已发出中止请求、在等 worker 收尾：按钮进入「停止中」态，避免重复点击与「点了没反应」的观感。 */
  stopping?: boolean;
  disabled?: boolean;
  workspace?: string;
  onPickWorkspace(): void;
  model: string;
  modelKey: string;
  models: ModelOption[];
  onModel(value: string): void;
  effort: string;
  effortLevels: string[];
  onEffort(value: string): void;
  permission: string;
  onPermission(value: string): void;
  onCommand(command: string): void;
  /** 输入即执行的内建斜杠命令（如 /side）：选中后清空输入并回调 onCommand，而不是插入文本。 */
  builtinCommands?: Array<{ id: string; description?: string }>;
  stats?: AgentSessionStats;
  onCompact?(): void;
  skillCommands?: AgentSkillCommand[];
  placement?: "dock" | "hero";
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const [listing, setListing] = useState(false);
  const [picked, setPicked] = useState(0);
  const [dropOver, setDropOver] = useState(false);
  const [blank, setBlank] = useState(true);
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string; dataUri: string }>>([]);
  const [attachmentView, setAttachmentView] = useState<string>();
  const skipHydrate = useRef(false);
  const area = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const mention = workspace ? mentionAt(value, cursor) : undefined;
  const matches = mention ? filterMentionPaths(files, mention.query) : [];

  useEffect(() => {
    setValue(fillText ?? "");
  }, [fillToken]);

  useEffect(() => {
    const root = area.current;
    if (!root) return;
    const lock = (event: Event) => {
      const drag = event as globalThis.DragEvent;
      if (!drag.dataTransfer || !isPromptFileDrag(drag.dataTransfer)) return;
      event.preventDefault();
      drag.dataTransfer.dropEffect = "copy";
      root.contentEditable = "false";
    };
    const hosts: EventTarget[] = [root];
    if (root.parentElement) hosts.push(root.parentElement);
    for (const host of hosts) host.addEventListener("dragover", lock, true);
    return () => {
      for (const host of hosts) host.removeEventListener("dragover", lock, true);
    };
  }, []);

  const emit = () => {
    const root = area.current;
    if (!root) return "";
    flattenPromptBlocks(root);
    if (isPromptEmpty(root) && !root.querySelector("[data-url], [data-file], [data-image]")) root.replaceChildren();
    const next = serializePrompt(root);
    setBlank(isPromptEmpty(root) && attachments.length === 0);
    setCursor(caretOffset(root));
    skipHydrate.current = true;
    if (next !== value) setValue(next);
    return next;
  };

  const [tick, setTick] = useState(0);
  useEffect(() => window.harness.workspace.onChanged(() => {
    if (workspace) setTick((value) => value + 1);
  }), [workspace]);
  useEffect(() => {
    if (!workspace) {
      setFiles([]);
      return;
    }
    let gone = false;
    setListing(true);
    void window.harness.workspace.list(workspace).then((next) => {
      if (!gone) setFiles(next);
    }).catch(() => {
      if (!gone) setFiles([]);
    }).finally(() => {
      if (!gone) setListing(false);
    });
    return () => {
      gone = true;
    };
  }, [workspace, tick]);

  useEffect(() => {
    setPicked(0);
  }, [mention?.query, value]);

  useEffect(() => {
    menu.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [picked]);

  useEffect(() => {
    const root = area.current;
    if (!root) return;
    if (skipHydrate.current) {
      skipHydrate.current = false;
      return;
    }
    if (serializePrompt(root) === value) return;
    hydratePrompt(root, value);
    setBlank(isPromptEmpty(root) && attachments.length === 0);
  }, [value]);

  const addUploads = async (list: FileList | File[]) => {
    const next: Array<{ id: string; name: string; dataUri: string }> = [];
    for (const file of [...list]) {
      if (!file.type.startsWith("image/")) continue;
      next.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random()}`,
        name: file.name,
        dataUri: await readDataUri(file, t),
      });
    }
    if (next.length === 0) return;
    const room = MAX_UPLOAD_IMAGES - attachments.length;
    setAttachments((prev) => [...prev, ...next].slice(0, MAX_UPLOAD_IMAGES));
    if (room > 0) area.current?.focus();
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  };

  const insertFile = (file: string, confirm = false) => {
    const root = area.current;
    if (!mention || !root) return;
    const folder = file.endsWith("/");
    const seal = confirm || !folder || mention.query === file;
    if (seal) {
      const next = `${value.slice(0, mention.start)}@${file} ${value.slice(cursor)}`;
      const caret = mention.start + file.length + 2;
      setValue(next);
      setCursor(caret);
      requestAnimationFrame(() => {
        root.focus();
        placeCaret(root, caret);
      });
      return;
    }
    const next = `${value.slice(0, mention.start)}@${file}${value.slice(cursor)}`;
    setValue(next);
    const caret = mention.start + file.length + 1;
    setCursor(caret);
    requestAnimationFrame(() => {
      root.focus();
      placeCaret(root, caret);
    });
  };

  const slash = (skillCommands.length > 0 || builtinCommands.length > 0) && (value === "/" || /^\/[^\s]*$/.test(value));
  const commands = [
    ...builtinCommands.map((command) => ({ id: command.id, description: command.description, builtin: true })),
    ...skillCommands.map((skill) => ({ id: skillSlashCommand(skill.name), description: skill.description, builtin: false })),
  ].filter((item) => item.id.startsWith(value || "/"));

  const insertSkillCommand = (command: string) => {
    const next = `${command} `;
    setValue(next);
    const caret = next.length;
    setCursor(caret);
    setPicked(0);
    requestAnimationFrame(() => {
      area.current?.focus();
      if (area.current) placeCaret(area.current, caret);
    });
  };

  // 内建命令（/side 等）即选即执行：清空输入并回调，不像 skill 那样插入文本。
  const runBuiltinCommand = (command: string) => {
    area.current?.replaceChildren();
    setBlank(true);
    setValue("");
    setPicked(0);
    onCommand(command);
  };

  const pickSlashCommand = () => {
    const command = commands[picked] ?? commands[0];
    if (!command) return;
    if (command.builtin) runBuiltinCommand(command.id);
    else insertSkillCommand(command.id);
  };

  const sendNow = () => {
    const root = area.current;
    if (!root || disabled) return;
    const text = serializePrompt(root).trim();
    const refs = attachments.map((item) => item.dataUri);
    if (!text && refs.length === 0) return;
    root.replaceChildren();
    setBlank(true);
    setValue("");
    setAttachments([]);
    onSubmit(text, refs.length ? refs : undefined);
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = area.current;
    if (!root) return;
    setCursor(caretOffset(root));
    if (slash && commands.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setPicked((current) => (current + 1) % commands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setPicked((current) => (current - 1 + commands.length) % commands.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        pickSlashCommand();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setValue("");
        return;
      }
    }
    if (matches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setPicked((current) => (current + 1) % matches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setPicked((current) => (current - 1 + matches.length) % matches.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        insertFile(matches[picked] ?? matches[0]!, event.key === "Enter");
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (mention?.query) {
          setValue(`${value.slice(0, cursor)} ${value.slice(cursor)}`);
          setCursor(cursor + 1);
        } else {
          setValue(`${value.slice(0, mention?.start ?? cursor)}${value.slice(cursor)}`);
        }
        return;
      }
    }
    if (slash && event.key === "Enter" && commands[0] && !event.shiftKey) {
      event.preventDefault();
      pickSlashCommand();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendNow();
      return;
    }
  };

  const dropIntoPrompt = (event: DragEvent<HTMLElement>) => {
    if (!isPromptFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    const root = area.current;
    if (root) root.contentEditable = "false";
    setDropOver(false);
    if (!root) return;
    const paths: string[] = [];
    const treePath = treeDragPath || event.dataTransfer.getData(PATH_MIME);
    const dropped = [...event.dataTransfer.files];
    const images = dropped.filter((file) => file.type.startsWith("image/"));
    if (images.length) void addUploads(images);
    if (treePath) {
      paths.push(treePath);
    } else if (workspace) {
      for (const file of dropped) {
        if (file.type.startsWith("image/")) continue;
        const rel = workspaceRelative(droppedAbsPath(file), workspace);
        if (!rel) continue;
        paths.push(files.includes(`${rel}/`) ? `${rel}/` : rel);
      }
    }
    if (paths.length === 0) {
      root.contentEditable = "true";
      return;
    }
    let next = serializePrompt(root);
    let caret = Math.min(cursor, next.length);
    for (const path of paths) {
      const inserted = spliceFileMention(next, path, caret);
      next = inserted.next;
      caret = inserted.caret;
    }
    setValue(next);
    setCursor(caret);
    requestAnimationFrame(() => {
      const node = area.current;
      if (!node) return;
      node.contentEditable = "true";
      node.focus();
      placeCaret(node, caret);
    });
  };
  const hero = placement === "hero";
  const folder = workspace ? baseName(workspace) : undefined;
  return (
    <div ref={rootRef} className={hero ? "prompt-wrap hero" : "prompt-wrap"}>
      <div className="prompt-shell">
        {(hero || (steering && steering.length > 0)) && (
          <div className="prompt-topbar">
            {hero && (
              <div className="prompt-topbar-row">
                <button
                  type="button"
                  className={folder ? "prompt-folder on" : "prompt-folder"}
                  onClick={onPickWorkspace}
                  title={workspace ?? t("composer.selectOrOpen")}
                >
                  <Icon path="M3 7h6l2 2h10v10H3z" size={13} />
                  <span>{folder ?? t("composer.selectProject")}</span>
                </button>
                {steering && steering.length > 0 && (
                  <div className="prompt-queue-meta">
                    <span className="prompt-steer-count">{t("composer.steering", { n: steering.length })}</span>
                  </div>
                )}
              </div>
            )}
          {steering && steering.length > 0 && (
            <div className="prompt-steer">
              {steering.map((item, index) => (
                <div key={`${index}-${item}`} className="prompt-steer-row">
                  <Icon path="M12 19V5M5 12l7-7 7 7" size={12} />
                  <p className="prompt-steer-text">{item}</p>
                </div>
              ))}
            </div>
          )}
          </div>
        )}
        <form
          className={dropOver ? "prompt drop" : "prompt"}
          onDragOverCapture={(event) => {
            if (!isPromptFileDrag(event.dataTransfer)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            if (area.current) area.current.contentEditable = "false";
            setDropOver(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node)) return;
            setDropOver(false);
            if (area.current) area.current.contentEditable = "true";
          }}
          onDropCapture={dropIntoPrompt}
          onSubmit={(event) => {
            event.preventDefault();
            if (slash && commands[0]) {
              pickSlashCommand();
              return;
            }
            sendNow();
          }}
        >
        {attachments.length > 0 && (
          <div className="prompt-attachments">
            {attachments.map((item) => (
              <div key={item.id} className="prompt-attachment">
                <button
                  type="button"
                  className="prompt-attachment-img"
                  aria-label={item.name}
                  onClick={() => setAttachmentView(item.dataUri)}
                >
                  <img src={item.dataUri} alt={item.name} />
                </button>
                <button
                  type="button"
                  className="prompt-attachment-remove"
                  aria-label={t("common.remove")}
                  onClick={() => removeAttachment(item.id)}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          ref={area}
          className={blank ? "prompt-input empty" : "prompt-input"}
          contentEditable={!dropOver}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          data-placeholder={running ? t("composer.placeholderFollowup") : workspace ? t("composer.placeholderWorkspace") : t("composer.placeholderEmpty")}
          onDragOverCapture={(event) => {
            if (!isPromptFileDrag(event.dataTransfer)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            event.currentTarget.contentEditable = "false";
          }}
          onMouseDown={(event) => {
            if ((event.target as HTMLElement).closest(".prompt-upload")) event.preventDefault();
          }}
          onInput={emit}
          onKeyUp={() => area.current && setCursor(caretOffset(area.current))}
          onKeyDown={onKey}
          onPaste={(event) => {
            const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
            if (images.length > 0) {
              event.preventDefault();
              void addUploads(images);
              return;
            }
            // 只收纯文本：富文本剪贴板（如复制的会话气泡）默认会把带样式的 DOM 整块插进输入框。
            const text = event.clipboardData.getData("text/plain");
            const html = event.clipboardData.getData("text/html");
            if (!text && !html) return;
            event.preventDefault();
            document.execCommand("insertText", false, (text || stripHtml(html)).replace(/\r\n?/g, "\n"));
          }}
        />
        {slash && (
          <div className="slash-menu">
            {commands.length === 0 && <p className="slash-empty">{t("composer.noCommands")}</p>}
            {commands.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={index === picked ? "on" : ""}
                title={item.description}
                onClick={pickSlashCommand}
              >
                <code>{item.id}</code>
                {item.description && <span className="slash-command-description">{item.description}</span>}
              </button>
            ))}
          </div>
        )}
        {mention && !slash && (
          <div
            className="slash-menu files"
            ref={menu}
            onMouseDown={(event) => event.preventDefault()}
            onWheel={(event) => event.stopPropagation()}
          >
            {matches.length === 0 && <p className="slash-empty">{listing ? t("composer.listingFiles") : t("composer.noFiles")}</p>}
            {matches.map((file, index) => (
              <button
                key={file}
                type="button"
                className={index === picked ? "on" : ""}
                onClick={() => insertFile(file)}
              >
                <span>{file}</span>
                {file.endsWith("/") && mention.query === file && <small>{t("composer.selectDir")}</small>}
              </button>
            ))}
          </div>
        )}
        <PromptToolbar down={hero} action={running ? (
            <button
              type="button"
              className={stopping ? "send stop waiting" : "send stop"}
              onClick={onStop}
              disabled={stopping}
              aria-busy={stopping}
              aria-label={stopping ? t("composer.stopping") : t("composer.abort")}
            >
              <i />
            </button>
          ) : (
            <button type="submit" className="send" disabled={disabled || blank} aria-label={t("composer.send")}>
              <Icon path="M12 19V5M5 12l7-7 7 7" size={15} />
            </button>
          )}>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) void addUploads(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="prompt-attach"
            aria-label={t("composer.uploadImage")}
            title={t("composer.uploadImage")}
            disabled={attachments.length >= MAX_UPLOAD_IMAGES}
            onClick={() => picker.current?.click()}
          >
            <Icon path="M12 5v14M5 12h14" size={16} />
            <span className="toolbar-menu-label">{t("composer.uploadImage")}</span>
          </button>
          <ModelPicker value={modelKey} fallback={model} options={models} down={hero} disabled={disabled} onChange={onModel} />
          {reasoningLevelsAvailable(effortLevels) && (
            <EffortPicker value={effort} levels={effortLevels} down={hero} onChange={onEffort} />
          )}
          <PermissionPicker value={permission} down={hero} onChange={onPermission} />
          {!hero && (
            <ContextStats
              stats={stats}
              model={model}
              effort={effort}
              effortLevels={effortLevels}
              up
              running={running}
              busy={disabled}
              onCompact={onCompact}
            />
          )}
        </PromptToolbar>
      </form>
      {attachmentView && createPortal(
        <div className="modal" onClick={() => setAttachmentView(undefined)} onKeyDown={(event) => { if (event.key === "Escape") setAttachmentView(undefined); }}>
          <img className="lightbox" src={attachmentView} alt="" />
        </div>,
        document.body,
      )}
      </div>
    </div>
  );
}

function readDataUri(file: File, t: ReturnType<typeof useI18n>["t"]): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(t("readError", { name: file.name })));
    reader.readAsDataURL(file);
  });
}

export interface PermissionOptionConfig {
  value: PermissionMode;
  label: string;
  desc: string;
  icon: string;
  danger?: boolean;
}

function permissionOptions(t: ReturnType<typeof useI18n>["t"]): PermissionOptionConfig[] {
  return [
  {
    value: "plan",
    label: t("perm.plan"),
    desc: t("perm.planDesc"),
    icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  },
  {
    value: "ask",
    label: t("perm.ask"),
    desc: t("perm.askDesc"),
    icon: "M12 22a10 10 0 1 0-10-10 10 10 0 0 0 10 10zm0-14v5m0 3h.01",
  },
  {
    value: "auto",
    label: t("perm.auto"),
    desc: t("perm.autoDesc"),
    icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  },
  {
    value: "full",
    label: t("perm.full"),
    desc: t("perm.fullDesc"),
    icon: "M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 0c2.5 0 4.5 4.5 4.5 10s-2 10-4.5 10-4.5-4.5-4.5-10 2-10 4.5-10z M2 12h20",
    danger: true,
  },
  ];
}

export function PermissionPicker({
  value,
  onChange,
  down,
}: {
  value: PermissionMode | string;
  onChange(value: string): void;
  down?: boolean;
}) {
  const { t } = useI18n();
  const popover = usePickerPopover(down, 300, 316);
  const { open, setOpen } = popover;
  const options = permissionOptions(t);
  const selected = options.find((item) => item.value === value) ?? options[2]!;

  return (
    <div className={`combo permission-combo${open ? " open" : ""}${down ? " down" : ""}`}>
      <button
        type="button"
        ref={popover.trigger}
        aria-controls={open ? popover.id : undefined}
        className={`combo-trigger permission-trigger${selected.danger ? " danger" : ""}`}
        onClick={() => setOpen((was) => !was)}
        title={`${selected.label}：${selected.desc}`}
        aria-label={`${t("composer.permission")}：${selected.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Icon path={selected.icon} size={16} className="permission-trigger-icon" />
        <span className="toolbar-label">{selected.label}</span>
        <Icon path="M6 9l6 6 6-6" size={12} className="toolbar-chevron" />
      </button>

      {open && popover.placement && createPortal(
        <div ref={popover.panel} id={popover.id} data-picker-popover={popover.id} data-toolbar-owner={popover.toolbarOwner} className="permission-menu picker-panel" role="listbox" aria-label={t("composer.permission")} style={popover.placement}>
          {options.map((item) => {
            const isSelected = item.value === value;
            return (
              <button
                key={item.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`permission-item${isSelected ? " selected" : ""}${item.danger ? " danger" : ""}`}
                onClick={() => {
                  onChange(item.value);
                  setOpen(false);
                }}
              >
                <div className="permission-icon">
                  <Icon path={item.icon} size={17} />
                </div>
                <div className="permission-content">
                  <div className="permission-title">{item.label}</div>
                  <div className="permission-desc">{item.desc}</div>
                </div>
                {isSelected && (
                  <div className="permission-check">
                    <Icon path="M20 6L9 17l-5-5" size={16} />
                  </div>
                )}
              </button>
            );
          })}
        </div>, document.body,
      )}
    </div>
  );
}

export function Combo({
  value,
  options,
  onChange,
  searchable,
  placeholder,
  down,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange(value: string): void;
  searchable?: boolean;
  placeholder?: string;
  down?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState<DOMRect>();
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selected = options.find((item) => item.value === value);
  const filtered = searchable && query
    ? options.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  useEffect(() => {
    if (!open) {
      setAnchor(undefined);
      return;
    }
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (box.current?.contains(target) || menu.current?.contains(target)) return;
      setOpen(false);
      setQuery("");
    };
    // The menu lives in a body portal so panels can scroll without clipping it, which means its
    // position has to follow the trigger instead of being laid out next to it.
    const place = () => setAnchor(box.current?.getBoundingClientRect());
    place();
    document.addEventListener("mousedown", close);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const dropDown = (() => {
    if (!anchor) return Boolean(down);
    const below = window.innerHeight - anchor.bottom - 14;
    const above = anchor.top - 14;
    if (down) return below >= 140 || below >= above;
    return below >= above && below >= 140;
  })();
  const maxHeight = anchor
    ? Math.min(320, Math.max(120, dropDown ? window.innerHeight - anchor.bottom - 14 : anchor.top - 14))
    : 320;
  const placement = anchor
    ? {
      left: Math.min(anchor.left, Math.max(8, window.innerWidth - Math.max(anchor.width, 220) - 8)),
      minWidth: Math.max(anchor.width, 220),
      maxHeight,
      ...(dropDown
        ? { top: anchor.bottom + 6 }
        : { bottom: window.innerHeight - anchor.top + 6 }),
    }
    : undefined;

  return (
    <div ref={box} className={`combo${open ? " open" : ""}${down ? " down" : ""}`}>
      {open && searchable ? (
        <input
          className="combo-input"
          value={query}
          autoFocus
          placeholder={placeholder ?? t("combo.filter")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              setQuery("");
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const typed = query.trim();
              const next = filtered[0]?.value ?? typed;
              if (next) onChange(next);
              setOpen(false);
              setQuery("");
            }
          }}
        />
      ) : (
        <button type="button" className="combo-trigger" onClick={() => { setOpen((was) => !was); setQuery(""); }}>
          <span>{selected?.label ?? value}</span>
          <Icon path="M6 9l6 6 6-6" size={12} />
        </button>
      )}
      {open && placement && createPortal(
        <div ref={menu} className="combo-menu floating" role="listbox" style={placement}>
          {filtered.length === 0 && (query.trim() ? (
            <button
              type="button"
              className="combo-item selected"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChange(query.trim());
                setOpen(false);
                setQuery("");
              }}
            >
              {query.trim()}
            </button>
          ) : (
            <div className="combo-empty">{t("combo.empty")}</div>
          ))}
          {filtered.map((item) => (
            <button
              key={item.value}
              type="button"
              className={item.value === value ? "combo-item selected" : "combo-item"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChange(item.value);
                setOpen(false);
                setQuery("");
              }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function splitApprovalCopy(title: string, message?: string) {
  const lines = title.split("\n").map((line) => line.trim()).filter(Boolean);
  const heading = lines[0] ?? "";
  const detail = lines.slice(1).join("\n");
  const rest = [detail, message?.trim()].filter(Boolean).join("\n\n");
  const destructive = /run destructive command/i.test(heading);
  if (!destructive) return { heading, detail, message: message?.trim() ?? "", command: "", destructive: false };
  return {
    heading,
    detail: "",
    message: "",
    command: rest.replace(/this may delete data or alter system\/process state\.?/gi, "").trim(),
    destructive: true,
  };
}

export function ApprovalCard({
  request,
  lastTurn,
  onDone,
  onError,
  onRespond,
}: {
  request: ExtensionUiRequest;
  lastTurn?: string;
  onDone(): void;
  onError(message: string): void;
  onRespond?(response: Record<string, unknown>): void | Promise<void>;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.prefill ?? "");
  const respond = async (response: Record<string, unknown>) => {
    try {
      if (onRespond) await onRespond(response);
      else await window.harness.agent.respondToUi(request.id, response);
      onDone();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };
  const copy = splitApprovalCopy(
    request.title ?? (request.method === "confirm" ? t("approval.needConfirm") : t("approval.needSelect")),
    request.message,
  );
  const title = copy.destructive ? t("approval.destructiveTitle") : approvalTitle(copy.heading, lastTurn);
  const folded = copy.command || copy.detail;
  return (
    <div className="approval">
      <strong>{title}</strong>
      {copy.destructive && <p>{t("approval.destructiveBody")}</p>}
      {!copy.destructive && copy.message && <p>{copy.message}</p>}
      {folded && (
        <details className="approval-cmd">
          <summary>{t("approval.showCommand")}</summary>
          <pre className="approval-detail">{folded}</pre>
        </details>
      )}
      {request.method === "select" && (
        <div className="choices">
          {request.options?.map((option) => (
            <button key={option} type="button" onClick={() => void respond({ value: option })}>
              {accessChoiceLabel(option, t)}
            </button>
          ))}
        </div>
      )}
      {(request.method === "input" || request.method === "editor") && (
        <textarea value={value} onChange={(event) => setValue(event.target.value)} rows={3} />
      )}
      <div className="row-actions">
        <button type="button" className="ghost" onClick={() => void respond({ cancelled: true })}>{t("common.cancel")}</button>
        {request.method === "confirm" && (
          <>
            <button type="button" className="ghost" onClick={() => void respond({ confirmed: false })}>{t("common.reject")}</button>
            <button type="button" className="primary" onClick={() => void respond({ confirmed: true })}>{t("common.allow")}</button>
          </>
        )}
        {(request.method === "input" || request.method === "editor") && (
          <button type="button" className="primary" onClick={() => void respond({ value })}>{t("common.continue")}</button>
        )}
      </div>
    </div>
  );
}

function accessChoiceLabel(option: string, t: (key: MessageKey) => string): string {
  if (option === "Execute the plan") return t("plan.approve");
  if (option === "Stay in plan mode") return t("perm.plan");
  if (option === "Refine the plan") return t("plan.refine");
  if (option === "Allow once") return t("approval.allowOnce");
  if (option === "Allow for this conversation" || option === "Allow this command for this session") {
    return t("approval.allowConversation");
  }
  if (option === "Deny") return t("common.reject");
  if (/^allow\b/i.test(option)) return t("common.allow");
  return option;
}

function ModelField({
  value,
  onChange,
  models,
  listing,
  canList,
  onList,
  placeholder,
}: {
  value: string;
  onChange(value: string): void;
  models: string[];
  listing: boolean;
  canList: boolean;
  onList(): void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const options = [...new Set([value, ...models].filter(Boolean))].map((id) => ({ value: id, label: id }));
  return (
    <label>
      {t("common.model")}
      <span className="settings-model">
        <Combo
          value={value}
          options={options}
          searchable
          placeholder={placeholder ?? t("composer.filterModels")}
          onChange={onChange}
        />
        <button type="button" className="ghost" disabled={!canList || listing} onClick={onList}>
          {listing ? t("combo.fetching") : t("combo.fetchModels")}
        </button>
      </span>
    </label>
  );
}

function SecretField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
}) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  return (
    <label>
      API key
      <span className="secret">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
        />
        <button type="button" className="secret-toggle" aria-label={show ? t("secret.hide") : t("secret.show")} onClick={() => setShow((open) => !open)}>
          <Icon
            path={show
              ? "M3 3l18 18M10.7 10.7a3 3 0 0 0 4.2 4.2M9.9 5.1A11 11 0 0 1 12 5c6 0 10 7 10 7a18 18 0 0 1-3.3 3.9M6.1 6.1A16 16 0 0 0 2 12s4 8 10 8a10 10 0 0 0 4.3-.9"
              : "M2 12s4-8 10-8 10 8 10 8-4 8-10 8-10-8-10-8M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6"}
            size={15}
          />
        </button>
      </span>
    </label>
  );
}

function ApiProfilesEditor({
  profiles,
  activeId,
  onProfiles,
  onActiveId,
  models,
  listing,
  onList,
  urlPlaceholder,
  showMaxTokens,
  testStatus,
}: {
  profiles: CustomApiProfile[];
  activeId: string;
  onProfiles(next: CustomApiProfile[]): void;
  onActiveId(id: string): void;
  models: string[];
  listing: boolean;
  onList(): void;
  urlPlaceholder: string;
  showMaxTokens?: boolean;
  testStatus?: { ok: boolean; message: string } | null;
}) {
  const { t } = useI18n();
  const active = profiles.find((item) => item.id === activeId) ?? profiles[0];
  const update = (fields: Partial<CustomApiProfile>) => {
    if (!active) return;
    onProfiles(profiles.map((item) => (item.id === active.id ? { ...item, ...fields } : item)));
  };
  return (
    <div className="custom-api-layout">
      <div className="custom-api-sidebar">
        <div className="custom-api-sidebar-head">
          <span className="custom-api-sidebar-title">{t("settings.profilesList")}</span>
          <button
            type="button"
            className="custom-api-add-btn"
            onClick={() => {
              const profile = defaultCustomProfile({
                name: `${t("settings.customProfile")} ${profiles.length + 1}`,
              });
              onProfiles([...profiles, profile]);
              onActiveId(profile.id);
            }}
          >
            <Icon path="M12 5v14M5 12h14" size={12} />
            <span>{t("settings.addCustomProfile")}</span>
          </button>
        </div>
        <div className="custom-api-card-list">
          {profiles.map((profile) => {
            const isActive = profile.id === activeId;
            return (
              <div
                key={profile.id}
                className={`custom-api-card ${isActive ? "active" : ""}`}
                onClick={() => {
                  if (profile.id === activeId) return;
                  onActiveId(profile.id);
                }}
              >
                <div className="custom-api-card-head">
                  <span className="custom-api-card-radio">
                    {isActive && <span className="custom-api-card-dot" />}
                  </span>
                  <span className="custom-api-card-title">
                    {profile.name || t("settings.profileUntitled")}
                  </span>
                  {isActive && <small className="custom-api-card-use">{t("settings.profileInUse")}</small>}
                  <button
                    type="button"
                    className="custom-api-card-del"
                    title={t("settings.removeCustomProfile")}
                    onClick={(event) => {
                      event.stopPropagation();
                      const remaining = profiles.filter((item) => item.id !== profile.id);
                      onProfiles(remaining);
                      if (activeId === profile.id) onActiveId(remaining[0]?.id ?? "");
                    }}
                  >
                    <Icon path="M6 6l12 12M18 6L6 18" size={13} />
                  </button>
                </div>
                <div className="custom-api-card-meta">
                  {profile.url || t("settings.customApi")}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="custom-api-form">
        {active ? (
          <>
            <label>
              {t("settings.profileName")}
              <input
                value={active.name}
                onChange={(event) => update({ name: event.target.value })}
                placeholder={t("settings.profileUntitled")}
              />
            </label>
            <label>
              {t("settings.baseUrl")}
              <input
                value={active.url}
                onChange={(event) => update({ url: event.target.value, model: "" })}
                placeholder={urlPlaceholder}
              />
            </label>
            <SecretField value={active.apiKey} onChange={(apiKey) => update({ apiKey })} />
            <ModelField
              value={active.model}
              onChange={(model) => update({ model })}
              models={models}
              listing={listing}
              canList={Boolean(active.url.trim() && active.apiKey.trim())}
              onList={onList}
            />
            {showMaxTokens && (
              <details className="settings-advanced">
                <summary>{t("settings.advanced")}</summary>
                <label>
                  {t("settings.maxTokens")}
                  <input
                    inputMode="numeric"
                    value={active.maxTokens ? String(active.maxTokens) : ""}
                    onChange={(event) => {
                      const digits = event.target.value.replace(/[^\d]/g, "");
                      update({ maxTokens: digits ? Number(digits) : undefined });
                    }}
                    placeholder={t("settings.maxTokensPlaceholder")}
                  />
                </label>
              </details>
            )}
            {testStatus && (
              <div className={`settings-feedback ${testStatus.ok ? "ok" : "err"}`}>
                <Icon path={testStatus.ok ? "M5 12.5l4 4 10-10" : "M12 8v4m0 4h.01M22 12A10 10 0 1 1 2 12a10 10 0 0 1 22 0z"} size={14} />
                <span>{testStatus.message}</span>
              </div>
            )}
          </>
        ) : (
          <p className="settings-hint">{t("settings.customEmpty")}</p>
        )}
      </div>
    </div>
  );
}

type SettingsPane = "providers" | "vision" | "subagents" | "appearance" | "shortcuts" | "skills" | "about";

function settingsNav(t: ReturnType<typeof useI18n>["t"]): Array<{ label: string; items: Array<{ id: SettingsPane; label: string; icon: string }> }> {
  return [
  {
    label: t("settings.groupModels"),
    items: [
      { id: "providers", label: t("settings.providers"), icon: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
      { id: "vision", label: t("settings.vision"), icon: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z\nM11 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0\nm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" },
      { id: "subagents", label: t("settings.subagents"), icon: "M12 8V4H8\nM4 8h16v12H4z\nM2 14h2M20 14h2M15 13v2M9 13v2" },
    ],
  },
  {
    label: t("settings.groupAppearance"),
    items: [
      { id: "appearance", label: t("settings.appearance"), icon: "M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" },
    ],
  },
  {
    label: t("settings.groupHelp"),
    items: [
      {
        id: "skills",
        label: t("settings.skills"),
        icon: "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z",
      },
      {
        id: "shortcuts",
        label: t("settings.shortcuts"),
        icon: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z\nM6 8h.01\nM10 8h.01\nM14 8h.01\nM18 8h.01\nM8 12h.01\nM12 12h.01\nM16 12h.01\nM7 16h10",
      },
      {
        id: "about",
        label: t("settings.about"),
        icon: "M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z\nM12 16v-4\nM12 8h.01",
      },
    ],
  },
  ];
}

export function Login({
  agentSkills = [],
  onRefreshSkills,
  onClose,
  onSaved,
}: {
  agentSkills?: AgentSkillCommand[];
  onRefreshSkills?: () => void;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const { t } = useI18n();
  const [pane, setPane] = useState<SettingsPane>("providers");
  const [visionProfiles, setVisionProfiles] = useState<CustomApiProfile[]>([]);
  const [activeVisionId, setActiveVisionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [visionModels, setVisionModels] = useState<string[]>([]);
  const [listing, setListing] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const [skillRevealError, setSkillRevealError] = useState<string>();
  const [testStatus, setTestStatus] = useState<{ ok: boolean; message: string } | null>(null);
  // Provider management state
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [providerDefaults, setProviderDefaults] = useState<{ defaultProviderId: string | null; defaultModelId: string | null }>({ defaultProviderId: null, defaultModelId: null });
  const [setupForProvider, setSetupForProvider] = useState<ProviderRecord | null | undefined>(undefined); // undefined=closed, null=add, ProviderRecord=edit
  const [providerLoadError, setProviderLoadError] = useState("");

  const activeVision = visionProfiles.find((item) => item.id === activeVisionId) ?? visionProfiles[0];
  const visionUrl = activeVision?.url ?? "";
  const visionKey = activeVision?.apiKey ?? "";
  const modKey = window.harness.platform === "darwin" ? "⌘" : "Ctrl";

  const listVisionModels = async () => {
    const base = visionUrl;
    const secret = visionKey;
    if (!base.trim() || !secret.trim()) {
      setTestStatus({ ok: false, message: t("settings.fillUrlKey") });
      return;
    }
    setListing(true);
    setTestStatus(null);
    const start = Date.now();
    try {
      const ids = await window.harness.auth.listModels(base.trim(), secret.trim());
      const elapsed = Date.now() - start;
      setVisionModels(ids);
      if (ids.length === 0) {
        setTestStatus({ ok: true, message: t("settings.okNoModels", { ms: elapsed }) });
      } else {
        setTestStatus({ ok: true, message: t("settings.okModels", { ms: elapsed, n: ids.length }) });
      }
    } catch (error) {
      setTestStatus({
        ok: false,
        message: error instanceof Error ? error.message : t("settings.connectFailed"),
      });
    } finally {
      setListing(false);
    }
  };

  useEffect(() => {
    void Promise.all([
      window.harness.vision.config(),
      window.harness.app.version().catch(() => "0.1.0"),
    ]).then(async ([config, ver]) => {
      setVisionProfiles(config.profiles);
      setActiveVisionId(config.activeProfileId);
      if (ver) setAppVersion(ver);
      const vision = config.profiles.find((item) => item.id === config.activeProfileId) ?? config.profiles[0];
      if (vision?.url.trim() && vision.apiKey.trim()) {
        void window.harness.auth.listModels(vision.url, vision.apiKey).then(setVisionModels).catch(() => undefined);
      }
    }).catch(() => undefined);
  }, []);

  const refreshProviders = useCallback(async () => {
    const [list, defaults] = await Promise.all([
      window.harness.providers.list(),
      window.harness.providers.defaults(),
    ]);
    setProviders(list);
    setProviderDefaults(defaults);
    setProviderLoadError("");
  }, []);

  useEffect(() => {
    void refreshProviders().catch((error) => setProviderLoadError(error instanceof Error ? error.message : String(error)));
  }, [refreshProviders]);

  useEffect(() => {
    if (pane !== "skills") return;
    onRefreshSkills?.();
  }, [pane, onRefreshSkills]);

  const backdropClose = useBackdropClose(onClose);

  return (
    <div
      className="modal"
      {...backdropClose}
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <form
        className="settings"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await window.harness.vision.saveConfig({
              profiles: visionProfiles,
              activeProfileId: activeVision?.id ?? activeVisionId,
            });
            await onSaved();
          } catch (error) {
            window.alert(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <nav className="settings-nav">
          {settingsNav(t).map((group) => (
            <div key={group.label} className="settings-group">
              <div className="settings-group-label">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={pane === item.id ? "settings-nav-item active" : "settings-nav-item"}
                  onClick={() => setPane(item.id)}
                >
                  <Icon path={item.icon} size={15} />
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="settings-main">
          <header className="settings-head">
            <h2>
              {pane === "providers"
                  ? t("settings.providers")
                  : pane === "vision"
                    ? t("settings.vision")
                    : pane === "subagents"
                      ? t("settings.subagents")
                    : pane === "appearance"
                      ? t("settings.appearance")
                      : pane === "skills"
                        ? t("settings.skills")
                        : pane === "shortcuts"
                          ? t("settings.shortcuts")
                          : t("settings.about")}
            </h2>
            <button type="button" className="settings-close" aria-label={t("common.close")} onClick={onClose}>
              <Icon path="M6 6l12 12M18 6L6 18" />
            </button>
          </header>
          <div className="settings-body">
            {pane === "subagents" && <SubagentsSettings providers={providers} />}
            {pane === "vision" && (
              <>
                <p className="settings-hint">{t("settings.visionHint")}</p>
                <ApiProfilesEditor
                  profiles={visionProfiles}
                  activeId={activeVisionId}
                  onProfiles={setVisionProfiles}
                  onActiveId={(id) => {
                    setActiveVisionId(id);
                    setVisionModels([]);
                    setTestStatus(null);
                    const profile = visionProfiles.find((item) => item.id === id);
                    if (profile?.url.trim() && profile.apiKey.trim()) {
                      void window.harness.auth.listModels(profile.url, profile.apiKey).then(setVisionModels).catch(() => undefined);
                    }
                  }}
                  models={visionModels}
                  listing={listing}
                  onList={() => void listVisionModels()}
                  urlPlaceholder="https://api.example.com/v1/chat/completions"
                  testStatus={testStatus}
                />
                <p className="settings-hint">{t("settings.mineruHint")}</p>
              </>
            )}

            {pane === "providers" && (
              <>
                {providerLoadError && <p role="alert" className="provider-error">{providerLoadError}</p>}
                <ProviderListPage
                  providers={providers}
                  defaultProviderId={providerDefaults.defaultProviderId}
                  defaultModelId={providerDefaults.defaultModelId}
                  onAdd={() => setSetupForProvider(null)}
                  onEdit={(provider) => setSetupForProvider(provider)}
                  onDelete={async (id) => {
                    await window.harness.providers.delete(id);
                    await refreshProviders();
                  }}
                  onSetDefault={async (id, modelId) => {
                    await window.harness.providers.setDefault(id, modelId);
                    await refreshProviders();
                  }}
                  onToggle={async (id, enabled) => {
                    await window.harness.providers.update({ id, isEnabled: enabled });
                    await refreshProviders();
                  }}
                  onTest={async (id) => {
                    return window.harness.providers.test(id);
                  }}
                />
                {setupForProvider !== undefined && (
                  <ProviderSetupDialog
                    provider={setupForProvider}
                    onClose={() => setSetupForProvider(undefined)}
                    onSaved={async () => {
                      // Saving already succeeded. A refresh failure must not
                      // leave an add dialog open where retry creates a duplicate.
                      try { await refreshProviders(); }
                      catch (error) { setProviderLoadError(error instanceof Error ? error.message : String(error)); }
                      setSetupForProvider(undefined);
                    }}
                  />
                )}
              </>
            )}
            {pane === "appearance" && <AppearanceSettings />}

            {pane === "skills" && (
              <>
                <p className="settings-hint">{t("settings.skillsUse")}</p>

                <div className="skills-section">
                  <h3 className="skills-section-title">{t("settings.skillsPaths")}</h3>
                  <div className="skills-paths">
                    <div className="skills-path-block">
                      <div className="skills-path-label">{t("settings.skillsPathProject")}</div>
                      <ul className="skills-path-list">
                        {PROJECT_SKILL_ROOTS.map((root) => (
                          <li key={root}><code>{root}/&lt;name&gt;/SKILL.md</code></li>
                        ))}
                      </ul>
                    </div>
                    <div className="skills-path-block">
                      <div className="skills-path-label">{t("settings.skillsPathUser")}</div>
                      <ul className="skills-path-list">
                        {USER_SKILL_ROOTS.map((root) => (
                          <li key={root}><code>{root}/&lt;name&gt;/SKILL.md</code></li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>

                <div className="skills-section">
                  <div className="skills-section-head">
                    <h3 className="skills-section-title">{t("settings.skillsTitle")}</h3>
                    <button type="button" className="ghost" onClick={() => onRefreshSkills?.()}>
                      {t("settings.skillsRefresh")}
                    </button>
                  </div>
                  {skillRevealError ? (
                    <p className="settings-hint settings-error">{skillRevealError}</p>
                  ) : null}
                  {agentSkills.length === 0 ? (
                    <p className="settings-hint">{t("settings.skillsEmpty")}</p>
                  ) : (
                    <div className="skills-list">
                      {agentSkills.map((skill) => {
                        const command = skillSlashCommand(skill.name);
                        return (
                          <button
                            key={skill.name}
                            type="button"
                            className="skills-row"
                            title={skill.path ?? command}
                            onClick={() => {
                              void window.harness.app.revealPath(skill.name, skill.path).catch((error) => {
                                const message = error instanceof Error ? error.message : t("settings.skillsRevealFailed");
                                setSkillRevealError(message);
                                window.setTimeout(() => setSkillRevealError((current) => (current === message ? undefined : current)), 2200);
                              });
                            }}
                          >
                            <code className="skills-row-name">{command}</code>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}

            {pane === "shortcuts" && (
              <div className="shortcut-list">
                <div className="shortcut-item">
                  <span className="shortcut-label">{t("shortcut.send")}</span>
                  <kbd>Enter</kbd>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-label">{t("shortcut.newline")}</span>
                  <span className="kbd-group"><kbd>Shift</kbd> + <kbd>Enter</kbd></span>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-label">{t("shortcut.mention")}</span>
                  <kbd>{t("shortcut.mentionKey")}</kbd>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-label">{t("shortcut.skills")}</span>
                  <kbd>/</kbd>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-label">{t("shortcut.skillInvoke")}</span>
                  <kbd>{t("shortcut.skillKey")}</kbd>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-label">{t("shortcut.new")}</span>
                  <span className="kbd-group"><kbd>{modKey}</kbd> + <kbd>N</kbd></span>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-label">{t("shortcut.open")}</span>
                  <span className="kbd-group"><kbd>{modKey}</kbd> + <kbd>O</kbd></span>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-label">{t("shortcut.undo")}</span>
                  <kbd>/undo</kbd>
                </div>
                <div className="shortcut-item">
                  <span className="shortcut-label">{t("shortcut.escape")}</span>
                  <kbd>Esc</kbd>
                </div>
              </div>
            )}

            {pane === "about" && (
              <div className="about-body">
                <div className="about-hero">
                  <img src={logo} alt="" className="about-logo" width={40} height={25} />
                  <h3>
                    {t("about.title")}
                    <span className="about-version">v{appVersion || "0.1.3"}</span>
                  </h3>
                  <p className="about-tagline">{t("about.subtitle")}</p>
                  <button
                    type="button"
                    className="about-site"
                    onClick={() => void window.harness.app.openExternal("https://github.com/tingyuxuan123/TAcode")}
                  >
                    github.com/tingyuxuan123/TAcode
                  </button>
                </div>
                <p className="about-intro">{t("about.intro")}</p>
                <p className="about-origin-name">{t("about.originName")}</p>
                <p className="about-origin">{t("about.origin")}</p>
              </div>
            )}
          </div>
          <footer className="settings-foot">
            {pane === "about" && (
              <>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void window.harness.app.checkUpdate()}
                >
                  <Icon path="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" size={14} />
                  <span>{t("about.checkUpdate")}</span>
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void window.harness.app.openExternal("https://github.com/tingyuxuan123/TAcode/issues")}
                >
                  <Icon path="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" size={14} />
                  <span>{t("about.feedback")}</span>
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void window.harness.app.openExternal("https://github.com/tingyuxuan123/TAcode")}
                >
                  <Icon path="M10 13a5 5 0 0 0 7.54.54l1.42-1.42a5 5 0 0 0-7.07-7.07L10.5 6.5M14 11a5 5 0 0 0-7.54-.54L5.04 11.88a5 5 0 0 0 7.07 7.07L13.5 17.5" size={14} />
                  <span>{t("about.site")}</span>
                </button>
              </>
            )}
            {pane !== "vision" ? (
              <button type="button" className="primary" onClick={onClose}>
                {t("settings.close")}
              </button>
            ) : (
              <button
                type="submit"
                className="primary"
                disabled={
                  busy ||
                  (activeVision
                    ? !activeVision.url.trim() || !activeVision.model.trim() || !activeVision.apiKey.trim()
                    : false)
                }
              >
                {t("settings.save")}
              </button>
            )}
          </footer>
        </div>
      </form>
    </div>
  );
}
