import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { CodeView, WorkerPoolContextProvider, useWorkerPool, type CodeViewHandle, type CodeViewItem, type WorkerInitializationRenderOptions, type WorkerPoolOptions } from "@pierre/diffs/react";
import { registerCustomTheme, type CodeViewLineSelection, type DiffLineAnnotation, type SelectedLineRange } from "@pierre/diffs";
import type { WorkerStats } from "@pierre/diffs/worker";
import BundledDiffWorker from "@pierre/diffs/worker/worker.js?worker";
import { ArrowDownToLine, ArrowUpFromLine, ChevronRight, ExternalLink, RotateCcw } from "lucide-react";
import type { GitMutationAction, GitMutationTarget } from "../../shared/git";
import { useI18n } from "../i18n";
import { WorkbenchButton, WorkbenchStats } from "./controls";
import { WorkbenchFileSymbol } from "./file-symbol";
import { createWorkbenchDiff, workbenchDiffCacheKey } from "./diff-model";
import { hasWorkbenchDiffSummary } from "./git-review-model";
import { commentLineRange, commentOutdated, type ReviewComment, type ReviewCommentContext } from "./review-comments";
import { createImeGuard } from "../ime";
import { DiffSummary } from "./diff-summary";
import { loadWorkbenchLightTheme, workbenchDiffCSS } from "./diff-theme";
import type { WorkbenchColorScheme, WorkbenchDiffFile } from "./types";

// Explicit local imports: no CDN, runtime downloads or Electron Node access.
registerCustomTheme("tacode-workbench-light", loadWorkbenchLightTheme);
registerCustomTheme("one-dark-pro", () => import("shiki/themes/one-dark-pro.mjs").then((module) => module.default));
const poolOptions: WorkerPoolOptions = { workerFactory: () => new BundledDiffWorker(), poolSize: 2, totalASTLRUCacheSize: 80 };
const highlighterOptions: WorkerInitializationRenderOptions = {
  theme: { light: "tacode-workbench-light", dark: "one-dark-pro" }, preferredHighlighter: "shiki-js", langs: ["typescript", "tsx", "javascript", "css", "json", "markdown"],
};

export interface DiffViewerHandle {
  revealFile(path: string): void;
  revealLine(path: string, line: number, side?: "additions" | "deletions"): void;
}

export interface DiffViewerProps {
  files: readonly WorkbenchDiffFile[];
  layout: "unified" | "split";
  wrap: boolean;
  colorScheme?: WorkbenchColorScheme;
  collapsed?: boolean;
  onOpenFile?(path: string): void;
  onActiveFileChange?(path: string): void;
  onSelectionChange?(selection: CodeViewLineSelection | null): void;
  onWorkerStateChange?(state: WorkerStats): void;
  initialScrollPosition?: number;
  onScrollPositionChange?(position: number): void;
  mutationScope?: "unstaged" | "staged";
  onMutation?(action: GitMutationAction, target: GitMutationTarget): void;
  busy?: boolean;
  /** Line comments anchored to this immutable comparison, plus creation callbacks. */
  comments?: readonly ReviewComment[];
  commentContext?: ReviewCommentContext;
  commentInputs?: boolean;
  selectedComments?: ReadonlySet<string>;
  onCreateComment?(input: { file: WorkbenchDiffFile; side: "additions" | "deletions"; startLine: number; endLine: number; text: string }): void;
  onResolveComment?(id: string): void;
  onDeleteComment?(id: string): void;
  onToggleComment?(id: string): void;
  ref?: Ref<DiffViewerHandle>;
}
type ReviewAnnotation = { kind: "summary" } | { kind: "hunk"; id: string; number: number } | { kind: "comment"; id: string } | { kind: "composer"; side: "additions" | "deletions"; startLine: number; endLine: number };

function WorkerObserver({ onChange }: { onChange?: (state: WorkerStats) => void }) {
  const pool = useWorkerPool();
  useEffect(() => {
    if (!pool || !onChange) return;
    onChange(pool.getStats());
    return pool.subscribeToStatChanges(onChange);
  }, [pool, onChange]);
  return null;
}

function Viewer({ files, layout, wrap, colorScheme = "light", collapsed = false, onOpenFile, onActiveFileChange, onSelectionChange, initialScrollPosition = 0, onScrollPositionChange, mutationScope, onMutation, busy = false, comments, commentContext, commentInputs = false, selectedComments, onCreateComment, onResolveComment, onDeleteComment, onToggleComment, ref }: DiffViewerProps) {
  const { t } = useI18n();
  const viewer = useRef<CodeViewHandle<ReviewAnnotation, undefined>>(null);
  const container = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<{ fileId: string; side: "additions" | "deletions"; startLine: number; endLine: number } | null>(null);
  const pendingTarget = useRef<{ path: string; line?: number; side?: "additions" | "deletions" } | null>(null);
  const navigationSelection = useRef<string | undefined>(undefined);
  const byId = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);
  const commentsById = useMemo(() => new Map((comments ?? []).map((comment) => [comment.id, comment])), [comments]);
  const commentsByPath = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const comment of comments ?? []) { const list = map.get(comment.path) ?? []; list.push(comment); map.set(comment.path, list); }
    return map;
  }, [comments]);
  const diffCache = useRef(new Map<string, { version: string; fileDiff: ReturnType<typeof createWorkbenchDiff> }>());
  const parsed = useMemo(() => {
    const next = new Map<string, { version: string; fileDiff: ReturnType<typeof createWorkbenchDiff> }>();
    const result = files.map((file) => {
      const previous = diffCache.current.get(file.id);
      const version = workbenchDiffCacheKey(file);
      const record = previous?.version === version ? previous : { version, fileDiff: createWorkbenchDiff(file) };
      next.set(file.id, record);
      return { id: file.id, type: "diff" as const, ...record };
    });
    diffCache.current = next;
    return result;
  }, [files]);
  const itemCache = useRef(new Map<string, { policy: string; item: CodeViewItem<ReviewAnnotation> }>());
  const viewVersion = useRef(0);
  const mutationPolicy = `${onMutation ? mutationScope ?? "" : ""}:${busy}`;
  // Annotations live inside the cached item, so the policy must change whenever
  // comments or the pending composer belong to a different line set.
  const annotationPolicy = `${(comments ?? []).map((comment) => `${comment.id}:${comment.side}:${comment.endLine}:${comment.resolvedAt ? "r" : "o"}`).join(",")}|`
    + (pending ? `${pending.fileId}:${pending.side}:${pending.startLine}-${pending.endLine}` : "");
  const viewPolicy = `${mutationPolicy}|${annotationPolicy}`;
  const items = useMemo<CodeViewItem<ReviewAnnotation>[]>(() => {
    const next = new Map<string, { policy: string; item: CodeViewItem<ReviewAnnotation> }>();
    for (const source of parsed) {
      const cached = itemCache.current.get(source.id);
      const previous = cached?.item;
      const isCollapsed = folded.has(source.id);
      const file = byId.get(source.id)!;
      const annotations: DiffLineAnnotation<ReviewAnnotation>[] = [];
      if (hasWorkbenchDiffSummary(file)) annotations.push({ side: "additions", lineNumber: 0, metadata: { kind: "summary" } });
      if (onMutation && mutationScope) for (const [index, hunk] of (file.hunks ?? []).entries()) annotations.push({
        side: hunk.newLines ? "additions" : "deletions", lineNumber: Math.max(1, hunk.newLines ? hunk.newStart : hunk.oldStart),
        metadata: { kind: "hunk", id: hunk.id, number: index + 1 },
      });
      for (const comment of commentsByPath.get(file.path) ?? []) annotations.push({
        side: comment.side, lineNumber: comment.endLine, metadata: { kind: "comment", id: comment.id },
      });
      if (commentInputs && pending?.fileId === file.id) annotations.push({
        side: pending.side, lineNumber: pending.endLine, metadata: { kind: "composer", side: pending.side, startLine: pending.startLine, endLine: pending.endLine },
      });
      // CodeView treats equal versions as immutable, including presentation
      // state. Keep content cache keys separate from the view's revision.
      const item = previous?.type === "diff" && previous.fileDiff === source.fileDiff && previous.collapsed === isCollapsed && cached?.policy === viewPolicy
        ? previous : { ...source, collapsed: isCollapsed, version: ++viewVersion.current,
          annotations: annotations.length ? annotations : undefined };
      next.set(source.id, { item, policy: viewPolicy });
    }
    itemCache.current = next;
    return [...next.values()].map((entry) => entry.item);
  }, [parsed, folded, byId, viewPolicy, commentsByPath, pending, commentInputs]);
  useEffect(() => { setFolded(collapsed ? new Set(files.map((file) => file.id)) : new Set()); }, [collapsed]);
  const revealTarget = () => {
    const target = pendingTarget.current;
    const file = target && files.find((file) => file.path === target.path);
    if (!target || !file || !viewer.current) return;
    // Near the end of a short list, scrollTo must clamp to the bottom and a
    // preceding file can stay at the top. Keep the explicitly chosen file until
    // the user scrolls the diff themselves.
    navigationSelection.current = file.id;
    if (target.line) viewer.current.scrollTo({ type: "line", id: file.id, lineNumber: target.line, side: target.side ?? "additions", align: "center", behavior: "instant" });
    else viewer.current.scrollTo({ type: "item", id: file.id, align: "start", behavior: "instant" });
    pendingTarget.current = null;
    onActiveFileChange?.(file.path);
  };
  const queueTarget = (path: string, line?: number, side?: "additions" | "deletions") => {
    pendingTarget.current = { path, line, side };
    const file = files.find((file) => file.path === path);
    if (file && folded.has(file.id)) setFolded((current) => { const next = new Set(current); next.delete(file.id); return next; });
    else revealTarget();
  };
  useImperativeHandle(ref, () => ({ revealFile: (path) => queueTarget(path), revealLine: queueTarget }));
  useEffect(revealTarget, [items]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { if (initialScrollPosition) viewer.current?.scrollTo({ type: "position", position: initialScrollPosition, behavior: "instant" }); });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const clear = () => { navigationSelection.current = undefined; };
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const event of events) element.addEventListener(event, clear, { capture: true, passive: true });
    return () => { for (const event of events) element.removeEventListener(event, clear, true); };
  }, []);

  return <CodeView ref={viewer} containerRef={container} className="workbench-diff-viewer" items={items}
    options={{ theme: highlighterOptions.theme, themeType: colorScheme, diffStyle: layout, overflow: wrap ? "wrap" : "scroll",
      diffIndicators: "bars", lineDiffType: "word-alt", stickyHeaders: true, enableLineSelection: true,
      expansionLineCount: 20, collapsedContextThreshold: 6,
      itemMetrics: { lineHeight: 22, diffHeaderHeight: 35, spacing: 0, paddingBottom: 12 },
      // The composer only appears once the pointer is released: inserting it while
      // dragging would shift the rows the user is still selecting over.
      onLineSelectionEnd: (range: SelectedLineRange | null, context?: { item?: { id?: string } }) => {
        if (!commentInputs) return;
        const file = byId.get(context?.item?.id ?? "");
        if (!range || !file) { setPending(null); return; }
        const side = range.side ?? range.endSide ?? "additions";
        setPending({ fileId: file.id, side, startLine: Math.min(range.start, range.end), endLine: Math.max(range.start, range.end) });
      },
      // Only while a composer is open: leave room to scroll its controls clear of the sticky action bar.
      layout: { paddingTop: 0, paddingBottom: pending ? 168 : 96, gap: 0 },
      unsafeCSS: workbenchDiffCSS }}
    onSelectedLinesChange={(selection) => onSelectionChange?.(selection)}
    onScroll={(position, instance) => {
      onScrollPositionChange?.(position);
      if (navigationSelection.current && byId.has(navigationSelection.current)) return;
      navigationSelection.current = undefined;
      const top = container.current?.getBoundingClientRect().top;
      if (top === undefined) return;
      const visible = instance.getRenderedItems().find((item) => item.element.getBoundingClientRect().bottom > top + 38);
      const file = visible && byId.get(visible.id);
      if (file) onActiveFileChange?.(file.path);
    }}
    renderAnnotation={(annotation, item) => {
      const file = byId.get(item.id);
      if (!file) return null;
      const data = annotation.metadata;
      if (data.kind === "summary") return <DiffSummary file={file} />;
      if (data.kind === "comment") {
        const comment = commentsById.get(data.id);
        if (!comment) return null;
        return <ReviewCommentCard comment={comment} outdated={commentOutdated(comment, commentContext, file.version)} selected={selectedComments?.has(comment.id) ?? false}
          onToggle={onToggleComment ? () => onToggleComment(comment.id) : undefined}
          onResolve={onResolveComment ? () => onResolveComment(comment.id) : undefined}
          onDelete={onDeleteComment ? () => onDeleteComment(comment.id) : undefined} />;
      }
      if (data.kind === "composer") return <ReviewCommentComposer side={data.side} startLine={data.startLine} endLine={data.endLine}
        snippet={extractSnippet(file, data.side, data.startLine, data.endLine)}
        onCancel={() => setPending(null)}
        onSubmit={(text) => { onCreateComment?.({ file, side: data.side, startLine: data.startLine, endLine: data.endLine, text }); setPending(null); }} />;
      const hunk = file.hunks?.find((hunk) => hunk.id === data.id);
      if (!hunk || !mutationScope || !onMutation) return null;
      const target: GitMutationTarget = { kind: "hunks", fileId: file.id, hunkIds: [hunk.id] };
      return <div className="workbench-hunk-actions" data-hunk-id={hunk.id} data-hunk-path={file.path}>
        <span title={hunk.heading}>{t("workbench.hunk", { number: data.number })} <code>−{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}</code></span>
        <button type="button" data-git-action={mutationScope === "unstaged" ? "stage-hunk" : "unstage-hunk"} disabled={busy}
          onClick={() => onMutation(mutationScope === "unstaged" ? "stage" : "unstage", target)}>{t(mutationScope === "unstaged" ? "workbench.stageHunk" : "workbench.unstageHunk")}</button>
        <button type="button" data-git-action="discard-hunk" disabled={busy} onClick={() => onMutation("discard", target)}>{t("workbench.discardHunk")}</button>
      </div>;
    }}
    renderCustomHeader={(item) => {
      const file = byId.get(item.id);
      if (!file) return null;
      const slash = file.path.lastIndexOf("/");
      return <div className="workbench-diff-header" data-diff-path={file.path}>
        <WorkbenchButton label={t(folded.has(file.id) ? "workbench.expandFile" : "workbench.collapseFile")} aria-expanded={!folded.has(file.id)}
          className="workbench-fold-button" onClick={() => setFolded((current) => { const next = new Set(current); if (next.has(file.id)) next.delete(file.id); else next.add(file.id); return next; })}>
          <ChevronRight size={14} className={folded.has(file.id) ? "" : "is-expanded"} />
        </WorkbenchButton>
        <WorkbenchFileSymbol path={file.path} />
        <span className="workbench-diff-path" title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}>
          {slash >= 0 && <span>{file.path.slice(0, slash + 1)}</span>}{file.path.slice(slash + 1)}
        </span>
        <WorkbenchStats additions={file.additions} deletions={file.deletions} />
        <span className="workbench-toolbar-spacer" />
        {onMutation && mutationScope && <>
          <WorkbenchButton label={t(mutationScope === "unstaged" ? "workbench.stageFile" : "workbench.unstageFile")}
            data-git-action={mutationScope === "unstaged" ? "stage-file" : "unstage-file"} disabled={busy || file.change === "conflict"}
            onClick={() => onMutation(mutationScope === "unstaged" ? "stage" : "unstage", { kind: "file", fileId: file.id })}>
            {mutationScope === "unstaged" ? <ArrowDownToLine size={14} /> : <ArrowUpFromLine size={14} />}
          </WorkbenchButton>
          <WorkbenchButton label={t("workbench.discardFile")} data-git-action="discard-file"
            disabled={busy || file.change === "conflict" || file.metadata?.old.state === "submodule" || file.metadata?.new.state === "submodule"}
            onClick={() => onMutation("discard", { kind: "file", fileId: file.id })}><RotateCcw size={14} /></WorkbenchButton>
        </>}
        {onOpenFile && <WorkbenchButton label={t("workbench.open")} onClick={() => onOpenFile(file.path)}><ExternalLink size={14} /></WorkbenchButton>}
      </div>;
    }} />;
}

export function DiffViewer(props: DiffViewerProps) {
  return <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
    <WorkerObserver onChange={props.onWorkerStateChange} /><Viewer {...props} />
  </WorkerPoolContextProvider>;
}

/** Exact lines the comment is anchored to on its side of the comparison. */
export function extractSnippet(file: WorkbenchDiffFile, side: "additions" | "deletions", startLine: number, endLine: number): string {
  const content = side === "deletions" ? file.oldContent : file.newContent;
  if (content === null) return "";
  const lines = content.split("\n");
  return lines.slice(Math.max(0, startLine - 1), endLine).join("\n");
}

function ReviewCommentCard({ comment, outdated, selected, onToggle, onResolve, onDelete }: {
  comment: ReviewComment; outdated: boolean; selected: boolean;
  onToggle?(): void; onResolve?(): void; onDelete?(): void;
}) {
  const { t } = useI18n();
  return <div className="review-comment" data-review-comment={comment.id} data-comment-outdated={outdated} data-comment-resolved={Boolean(comment.resolvedAt)}>
    <header>
      {onToggle && <label><input type="checkbox" checked={selected} aria-label={t("reviewComments.select")} onChange={onToggle} />{t("workbench.comment")}</label>}
      <span className="review-comment-range">{t(comment.side === "additions" ? "reviewComments.newSide" : "reviewComments.oldSide")} {commentLineRange(comment)}</span>
      {outdated && <span className="review-comment-outdated" role="status">{t("reviewComments.outdated")}</span>}
      {comment.resolvedAt && <span className="review-comment-resolved" role="status">{t("reviewComments.resolved")}</span>}
      <span className="workbench-toolbar-spacer" />
      {onResolve && <button type="button" data-review-action="resolve" onClick={onResolve}>{t(comment.resolvedAt ? "reviewComments.reopen" : "reviewComments.resolve")}</button>}
      {onDelete && <button type="button" data-review-action="delete" onClick={onDelete}>{t("reviewComments.delete")}</button>}
    </header>
    <pre data-comment-snippet>{comment.snippet}</pre>
    <p data-comment-text>{comment.text}</p>
  </div>;
}

function ReviewCommentComposer({ side, startLine, endLine, snippet, onCancel, onSubmit }: {
  side: "additions" | "deletions"; startLine: number; endLine: number; snippet: string;
  onCancel(): void; onSubmit(text: string): void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const ime = useRef(createImeGuard());
  return <form className="review-comment-composer" data-review-composer={`${side}:${startLine}-${endLine}`}
    onSubmit={(event) => { event.preventDefault(); if (text.trim()) onSubmit(text.trim()); }}>
    <span>{t(side === "additions" ? "reviewComments.newSide" : "reviewComments.oldSide")} {startLine === endLine ? startLine : `${startLine}–${endLine}`}</span>
    <pre data-comment-snippet>{snippet}</pre>
    <textarea aria-label={t("reviewComments.placeholder")} placeholder={t("reviewComments.placeholder")} rows={3} value={text} autoFocus
      onChange={(event) => setText(event.target.value)}
      onCompositionStart={() => ime.current.start()} onCompositionEnd={() => ime.current.end()}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || ime.current.handles(event.nativeEvent)) return;
        // Modifier+Enter adds the comment without reaching for the buttons under the action bar.
        if (event.metaKey || event.ctrlKey) { event.preventDefault(); if (text.trim()) onSubmit(text.trim()); }
      }} />
    <div>
      <button type="button" onClick={onCancel}>{t("common.cancel")}</button>
      <button type="submit" disabled={!text.trim()}>{t("reviewComments.add")}</button>
    </div>
  </form>;
}
