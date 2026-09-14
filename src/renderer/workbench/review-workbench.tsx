import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, ChevronsDownUp, Columns2, Folders, GitCommitHorizontal, History, MessageSquare, RefreshCw, RotateCcw, Rows2, WrapText } from "lucide-react";
import { useI18n } from "../i18n";
import { WorkbenchButton, WorkbenchStats } from "./controls";
import { WorkbenchFileTree } from "./file-tree";
import { WorkbenchSurface } from "./surface";
import { ancestorPaths } from "./tree-model";
import { ReviewComments, useReviewComments } from "./review-comment-list";
import { newReviewComment, type ReviewComment, type ReviewCommentContext, type ReviewCommentScope } from "./review-comments";
import type { DiffViewerHandle, DiffViewerProps } from "./diff-viewer";
import { extractSnippet } from "./diff-viewer";
import type { ReviewScope, WorkbenchColorScheme, WorkbenchDiffFile } from "./types";

const DiffViewer = lazy(() => import("./diff-viewer").then((module) => ({ default: module.DiffViewer })));
const scopes: ReviewScope[] = ["unstaged", "staged", "commit", "branch", "lastTurn"];

export function ReviewWorkbench({ files, scope, onScopeChange, onOpenFile, onRefresh, onStageAll, onUnstageAll, onDiscardAll, onCommit, onMutation, onRecoveries, dialogs, busy = false, error, colorScheme = "light", onWorkerStateChange, onSelectionChange, initialTreeWidth = 374, scopeDetails, emptyState, paused = false, comparisonKey = scope, disabledScopes = [], commentScope, commentContext, onUsePrompt }: {
  files: readonly WorkbenchDiffFile[];
  scope: ReviewScope;
  onScopeChange(scope: ReviewScope): void;
  onOpenFile?(path: string): void;
  onRefresh?(): void;
  onStageAll?(): void;
  onUnstageAll?(): void;
  onDiscardAll?(): void;
  onCommit?(): void;
  onMutation?: DiffViewerProps["onMutation"];
  onRecoveries?(): void;
  dialogs?: ReactNode;
  busy?: boolean;
  error?: string;
  scopeDetails?: ReactNode;
  emptyState?: ReactNode;
  paused?: boolean;
  comparisonKey?: string;
  disabledScopes?: readonly ReviewScope[];
  colorScheme?: WorkbenchColorScheme;
  initialTreeWidth?: number;
  onWorkerStateChange?: DiffViewerProps["onWorkerStateChange"];
  onSelectionChange?: DiffViewerProps["onSelectionChange"];
  /** Line comments are scoped by project + conversation and bound to the displayed comparison. */
  commentScope?: ReviewCommentScope;
  commentContext?: ReviewCommentContext;
  onUsePrompt?(text: string): void;
}) {
  const { t } = useI18n();
  const [treeOpen, setTreeOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [wrap, setWrap] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [selectedPath, setSelectedPath] = useState(files[0]?.path);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [selectedComments, setSelectedComments] = useState<ReadonlySet<string>>(new Set());
  const comments = useReviewComments(commentScope, commentContext);
  useEffect(() => { setSelectedPath((current) => files.some((file) => file.path === current) ? current : files[0]?.path); }, [files]);
  useEffect(() => { setSelectedComments((current) => new Set([...current].filter((id) => comments.comments.some((comment) => comment.id === id)))); },
    [comments.comments]);
  const toggleComment = (id: string) => setSelectedComments((current) => {
    const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
  });
  const viewer = useRef<DiffViewerHandle>(null);
  const pendingReveal = useRef<string | undefined>(undefined);
  const attachViewer = useCallback((handle: DiffViewerHandle | null) => {
    viewer.current = handle;
    if (handle && pendingReveal.current) { handle.revealFile(pendingReveal.current); pendingReveal.current = undefined; }
  }, []);
  const scroll = useRef({ key: comparisonKey, position: 0 });
  if (scroll.current.key !== comparisonKey) scroll.current = { key: comparisonKey, position: 0 };
  const filtered = useMemo(() => { const needle = query.trim().toLocaleLowerCase(); return needle ? files.filter((file) => file.path.toLocaleLowerCase().includes(needle)) : files; }, [files, query]);
  const entries = useMemo(() => files.map((file) => ({ path: file.path, kind: "file" as const, change: file.change })), [files]);
  const expanded = useMemo(() => [...new Set(files.flatMap((file) => ancestorPaths(file.path)))], [files]);
  const stats = useMemo(() => files.reduce((total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }), { additions: 0, deletions: 0 }), [files]);
  const canMutate = scope === "unstaged" || scope === "staged";
  return <WorkbenchSurface kind="review" treeOpen={treeOpen} colorScheme={colorScheme} initialTreeWidth={initialTreeWidth} context={scopeDetails}
    toolbar={<>
      <select className="workbench-scope" aria-label={t("workbench.scope")} value={scope} onChange={(event) => onScopeChange(event.target.value as ReviewScope)}>
        {scopes.map((value) => <option value={value} key={value} disabled={disabledScopes.includes(value)}>{t(`workbench.${value}`)}</option>)}
      </select>
      <WorkbenchStats {...stats} />
      {!canMutate && <span className="workbench-readonly">{t("workbench.readOnly")}</span>}
      <span className="workbench-toolbar-spacer" />
      <WorkbenchButton label={t(collapsed ? "workbench.expandAll" : "workbench.collapseAll")} aria-pressed={collapsed} onClick={() => setCollapsed(!collapsed)}><ChevronsDownUp size={16} /></WorkbenchButton>
      <WorkbenchButton label={t("workbench.wrap")} aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText size={16} /></WorkbenchButton>
      <WorkbenchButton label={t(layout === "unified" ? "workbench.split" : "workbench.unified")} onClick={() => setLayout(layout === "unified" ? "split" : "unified")}>
        {layout === "unified" ? <Columns2 size={16} /> : <Rows2 size={16} />}
      </WorkbenchButton>
      {onRefresh && <WorkbenchButton label={t("workbench.refresh")} disabled={busy} onClick={onRefresh}><RefreshCw size={15} className={busy ? "is-spinning" : ""} /></WorkbenchButton>}
      {canMutate && onRecoveries && <WorkbenchButton label={t("workbench.recoveries")} disabled={busy} onClick={onRecoveries}><History size={15} /></WorkbenchButton>}
      <WorkbenchButton label={t("reviewComments.toggle")} aria-pressed={commentsOpen} data-review-comments-toggle={comments.comments.length} onClick={() => setCommentsOpen(!commentsOpen)}><MessageSquare size={15} /></WorkbenchButton>
      <WorkbenchButton label={t(treeOpen ? "workbench.hideTree" : "workbench.showTree")} aria-pressed={treeOpen} onClick={() => setTreeOpen(!treeOpen)}><Folders size={18} /></WorkbenchButton>
      {onCommit && <WorkbenchButton label={t("workbench.commitOrPush")} className="has-label is-outlined" disabled={busy} onClick={onCommit}><GitCommitHorizontal size={16} /><span>{t("workbench.commitOrPush")}</span></WorkbenchButton>}
    </>}
    navigation={<>
      <WorkbenchFileTree entries={entries} query={query} onQueryChange={setQuery} selectedPath={selectedPath} initialExpanded={expanded} review
        onOpen={(path) => {
          setSelectedPath(path);
          if (viewer.current) viewer.current.revealFile(path); else pendingReveal.current = path;
        }} label={t("workbench.fileChanges")} />
      {commentsOpen && <ReviewComments comments={comments.comments} files={files} context={commentContext} selected={selectedComments}
        onToggle={toggleComment} onResolve={comments.resolve} onDelete={comments.remove} onUsePrompt={onUsePrompt}
        onReveal={(comment) => {
          setSelectedPath(comment.path);
          if (viewer.current) viewer.current.revealLine(comment.path, comment.endLine, comment.side); else pendingReveal.current = comment.path;
        }} />}
    </>}>
    {error && <div role="alert" className="workbench-notice">{error}</div>}
    {!paused && filtered.length ? <Suspense fallback={<p className="workbench-empty" role="status">{t("workbench.diffLoading")}</p>}>
      <DiffViewer key={comparisonKey} ref={attachViewer} files={filtered} layout={layout} wrap={wrap} colorScheme={colorScheme} collapsed={collapsed}
        mutationScope={canMutate ? scope : undefined} onMutation={onMutation} busy={busy}
        comments={comments.comments} commentContext={commentContext} commentInputs={Boolean(commentScope && commentContext && !busy)}
        selectedComments={selectedComments} onToggleComment={toggleComment} onResolveComment={comments.resolve} onDeleteComment={comments.remove}
        onCreateComment={({ file, side, startLine, endLine, text }) => comments.add(newReviewComment({ path: file.path, side, startLine, endLine,
          ...(commentContext ?? { rangeKey: "", snapshotId: "" }), version: comments.versionOf(file),
          snippet: extractSnippet(file, side, startLine, endLine), text }))}
        initialScrollPosition={scroll.current.position} onScrollPositionChange={(position) => { scroll.current.position = position; }}
        onOpenFile={onOpenFile} onActiveFileChange={setSelectedPath} onWorkerStateChange={onWorkerStateChange} onSelectionChange={onSelectionChange} />
    </Suspense> : <div className="workbench-empty" role="status">{emptyState ?? t(busy ? "workbench.loading" : files.length ? "workbench.emptyFiles" : "workbench.emptyDiff")}</div>}
    {canMutate && files.length > 0 && (onStageAll || onUnstageAll || onDiscardAll) && <div className="workbench-review-actions">
      {onDiscardAll && <WorkbenchButton className="has-label" label={t("workbench.discardAll")} disabled={busy} onClick={onDiscardAll}><RotateCcw size={14} /><span>{t("workbench.discardAll")}</span></WorkbenchButton>}
      {scope === "unstaged" && onStageAll && <WorkbenchButton className="has-label" label={t("workbench.stageAll")} disabled={busy} onClick={onStageAll}><ArrowDownToLine size={14} /><span>{t("workbench.stageAll")}</span></WorkbenchButton>}
      {scope === "staged" && onUnstageAll && <WorkbenchButton className="has-label" label={t("workbench.unstageAll")} disabled={busy} onClick={onUnstageAll}><ArrowDownToLine size={14} /><span>{t("workbench.unstageAll")}</span></WorkbenchButton>}
    </div>}
    {dialogs}
  </WorkbenchSurface>;
}
