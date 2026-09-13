import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ChevronsDownUp, Columns2, Folders, GitCommitHorizontal, RefreshCw, RotateCcw, Rows2, WrapText } from "lucide-react";
import { useI18n } from "../i18n";
import { WorkbenchButton, WorkbenchStats } from "./controls";
import { WorkbenchFileTree } from "./file-tree";
import { WorkbenchSurface } from "./surface";
import { ancestorPaths } from "./tree-model";
import type { DiffViewerHandle, DiffViewerProps } from "./diff-viewer";
import type { ReviewScope, WorkbenchColorScheme, WorkbenchDiffFile } from "./types";

const DiffViewer = lazy(() => import("./diff-viewer").then((module) => ({ default: module.DiffViewer })));
const scopes: ReviewScope[] = ["unstaged", "staged", "commit", "branch", "lastTurn"];

export function ReviewWorkbench({ files, scope, onScopeChange, onOpenFile, onRefresh, onStageAll, onUnstageAll, onDiscardAll, onCommit, busy = false, error, colorScheme = "light", onWorkerStateChange, onSelectionChange, initialTreeWidth = 374 }: {
  files: readonly WorkbenchDiffFile[];
  scope: ReviewScope;
  onScopeChange(scope: ReviewScope): void;
  onOpenFile?(path: string): void;
  onRefresh?(): void;
  onStageAll?(): void;
  onUnstageAll?(): void;
  onDiscardAll?(): void;
  onCommit?(): void;
  busy?: boolean;
  error?: string;
  colorScheme?: WorkbenchColorScheme;
  initialTreeWidth?: number;
  onWorkerStateChange?: DiffViewerProps["onWorkerStateChange"];
  onSelectionChange?: DiffViewerProps["onSelectionChange"];
}) {
  const { t } = useI18n();
  const [treeOpen, setTreeOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [wrap, setWrap] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [selectedPath, setSelectedPath] = useState(files[0]?.path);
  const viewer = useRef<DiffViewerHandle>(null);
  const filtered = useMemo(() => { const needle = query.trim().toLocaleLowerCase(); return needle ? files.filter((file) => file.path.toLocaleLowerCase().includes(needle)) : files; }, [files, query]);
  const entries = useMemo(() => files.map((file) => ({ path: file.path, kind: "file" as const, change: file.change })), [files]);
  const expanded = useMemo(() => [...new Set(files.flatMap((file) => ancestorPaths(file.path)))], [files]);
  const stats = useMemo(() => files.reduce((total, file) => ({ additions: total.additions + file.additions, deletions: total.deletions + file.deletions }), { additions: 0, deletions: 0 }), [files]);
  const canMutate = scope === "unstaged" || scope === "staged";
  return <WorkbenchSurface kind="review" treeOpen={treeOpen} colorScheme={colorScheme} initialTreeWidth={initialTreeWidth}
    toolbar={<>
      <select className="workbench-scope" aria-label={t("workbench.scope")} value={scope} onChange={(event) => onScopeChange(event.target.value as ReviewScope)} disabled={busy}>
        {scopes.map((value) => <option value={value} key={value}>{t(`workbench.${value}`)}</option>)}
      </select>
      <WorkbenchStats {...stats} />
      <span className="workbench-toolbar-spacer" />
      <WorkbenchButton label={t(collapsed ? "workbench.expandAll" : "workbench.collapseAll")} aria-pressed={collapsed} onClick={() => setCollapsed(!collapsed)}><ChevronsDownUp size={16} /></WorkbenchButton>
      <WorkbenchButton label={t("workbench.wrap")} aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText size={16} /></WorkbenchButton>
      <WorkbenchButton label={t(layout === "unified" ? "workbench.split" : "workbench.unified")} onClick={() => setLayout(layout === "unified" ? "split" : "unified")}>
        {layout === "unified" ? <Columns2 size={16} /> : <Rows2 size={16} />}
      </WorkbenchButton>
      {onRefresh && <WorkbenchButton label={t("workbench.refresh")} disabled={busy} onClick={onRefresh}><RefreshCw size={15} className={busy ? "is-spinning" : ""} /></WorkbenchButton>}
      <WorkbenchButton label={t(treeOpen ? "workbench.hideTree" : "workbench.showTree")} aria-pressed={treeOpen} onClick={() => setTreeOpen(!treeOpen)}><Folders size={18} /></WorkbenchButton>
      {onCommit && <WorkbenchButton label={t("workbench.commitOrPush")} className="has-label is-outlined" disabled={busy} onClick={onCommit}><GitCommitHorizontal size={16} /><span>{t("workbench.commitOrPush")}</span></WorkbenchButton>}
    </>}
    navigation={<WorkbenchFileTree entries={entries} query={query} onQueryChange={setQuery} selectedPath={selectedPath} initialExpanded={expanded} review
      onOpen={(path) => { setSelectedPath(path); viewer.current?.revealFile(path); }} label={t("workbench.fileChanges")} />}>
    {error && <div role="alert" className="workbench-notice">{error}</div>}
    {filtered.length ? <Suspense fallback={<p className="workbench-empty" role="status">{t("workbench.diffLoading")}</p>}>
      <DiffViewer ref={viewer} files={filtered} layout={layout} wrap={wrap} colorScheme={colorScheme} collapsed={collapsed}
        onOpenFile={onOpenFile} onActiveFileChange={setSelectedPath} onWorkerStateChange={onWorkerStateChange} onSelectionChange={onSelectionChange} />
    </Suspense> : <p className="workbench-empty" role="status">{t(busy ? "workbench.loading" : files.length ? "workbench.emptyFiles" : "workbench.emptyDiff")}</p>}
    {canMutate && files.length > 0 && (onStageAll || onUnstageAll || onDiscardAll) && <div className="workbench-review-actions">
      {onDiscardAll && <WorkbenchButton className="has-label" label={t("workbench.discardAll")} disabled={busy} onClick={onDiscardAll}><RotateCcw size={14} /><span>{t("workbench.discardAll")}</span></WorkbenchButton>}
      {scope === "unstaged" && onStageAll && <WorkbenchButton className="has-label" label={t("workbench.stageAll")} disabled={busy} onClick={onStageAll}><ArrowDownToLine size={14} /><span>{t("workbench.stageAll")}</span></WorkbenchButton>}
      {scope === "staged" && onUnstageAll && <WorkbenchButton className="has-label" label={t("workbench.unstageAll")} disabled={busy} onClick={onUnstageAll}><ArrowDownToLine size={14} /><span>{t("workbench.unstageAll")}</span></WorkbenchButton>}
    </div>}
  </WorkbenchSurface>;
}
