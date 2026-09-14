import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronsLeft, ChevronsRight, Code2, Eye } from "lucide-react";
import { useI18n } from "../i18n";
import { FileWorkbench } from "./file-workbench";
import { editableDocument, useFileDocument } from "./file-document-store";
import { FileEditDialog } from "./file-editing";
import { ProjectFileTree } from "./project-file-tree";
import { readFileView, writeFileView, type EditorPosition, type FileViewState } from "./file-view-state";
import { useWorkbenchVisible } from "./use-workbench-visible";
import type { SourceLocation, WorkbenchTreeEntry } from "./types";
import { useFileActions } from "./file-actions";
import type { CodeEditorHandle } from "./code-editor";
import { WorkbenchButton } from "./controls";
import { BinarySummary, HtmlPreview, ImagePreview, MarkdownPreview } from "./file-preview-content";
import { filePreviewKind } from "../../shared/file-format";
import { DOCUMENT_PAGE_BYTES } from "../../shared/files";
import { useFilePage } from "./use-file-page";
const CodeEditor = lazy(() => import("./code-editor").then((module) => ({ default: module.CodeEditor })));
type FileViewChange = Partial<FileViewState> | ((view: FileViewState) => Partial<FileViewState>);

export interface ProjectFilePanelProps {
  root: string; scope: string; path?: string; active: boolean; location?: SourceLocation; reveal?: number;
  changes?: readonly WorkbenchTreeEntry[];
  onOpen(path: string, options?: { preview?: boolean; literal?: boolean }): void;
}
export function ProjectFilePanel(props: ProjectFilePanelProps) {
  return <FileView key={JSON.stringify([props.scope, props.path ?? ""])} {...props} />;
}
function FileView(props: ProjectFilePanelProps) {
  const { root, scope, path, active, onOpen, changes } = props;
  const { ref, visible } = useWorkbenchVisible(active);
  const view = useRef(readFileView(scope, path ?? ""));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [reveal, setReveal] = useState(0);
  const update = useCallback((change: FileViewChange) => {
    view.current = { ...view.current, ...(typeof change === "function" ? change(view.current) : change) }; clearTimeout(timer.current);
    timer.current = setTimeout(() => writeFileView(scope, path ?? "", view.current), 150);
  }, [scope, path]);
  useEffect(() => () => { clearTimeout(timer.current); writeFileView(scope, path ?? "", view.current); }, [scope, path]);
  const [treeVisible, setTreeVisible] = useState(view.current.treeOpen ?? true);
  const editor = useRef<CodeEditorHandle | null>(null);
  const actions = useFileActions(root, path, onOpen, () => editor.current?.getLocation());
  const navigateFromTree = (value: string, options?: { preview?: boolean; literal?: boolean }) => {
    // A newly opened tab inherits navigation so a second click still reaches the same row.
    if (value !== path && !Object.keys(readFileView(scope, value)).length) writeFileView(scope, value, { ...view.current, position: undefined,
      viewMode: undefined, previewPosition: undefined, imageZoom: undefined, pageOffset: undefined, pagePositions: undefined });
    onOpen(value, options);
  };
  const navigation = <ProjectFileTree root={root} path={path} active={visible && treeVisible} view={view.current} onViewChange={update} onOpen={navigateFromTree} changes={changes} reveal={reveal + (props.reveal ?? 0)}
    onMenu={actions.openMenu} onCreate={actions.create} />;
  return <div ref={ref} className="project-file-panel" data-file-project={root} data-file-path={path ?? ""} data-file-active={visible}>
    {path ? <DocumentView {...props} active={visible} navigation={navigation} view={view} update={update} actions={actions} editor={editor} onLocate={() => { setTreeVisible(true); setReveal((value) => value + 1); }}
      onTreeOpen={(open) => { setTreeVisible(open); update({ treeOpen: open }); }} />
      : <FileWorkbench projectName={root.split(/[\\/]/).pop() ?? root} document={null} entries={[]} query="" onQueryChange={() => {}} onOpen={onOpen}
        actions={actions.toolbar} initialTreeWidth={view.current.treeWidth} initialTreeOpen={view.current.treeOpen} onTreeWidthChange={(treeWidth) => update({ treeWidth })}
        onTreeOpenChange={(open) => { setTreeVisible(open); update({ treeOpen: open }); }} navigation={navigation} />}
    {actions.overlays}
  </div>;
}
function DocumentView({ root, path = "", active, location, reveal, onOpen, navigation, view, update, onLocate, onTreeOpen, actions, editor }: ProjectFilePanelProps & {
  navigation: React.ReactNode; view: React.RefObject<FileViewState>; update(change: FileViewChange): void; onLocate(): void; onTreeOpen(open: boolean): void;
  actions: ReturnType<typeof useFileActions>; editor: React.Ref<CodeEditorHandle>;
}) {
  const { t } = useI18n(); const state = useFileDocument(root, path, active);
  const displayed = useRef(active ? { document: state.document, draft: state.draft } : undefined);
  // Hidden editors have no scroll box; apply shared disk updates when visible.
  if (active) displayed.current = { document: state.document, draft: state.draft };
  const { document, draft } = displayed.current ?? {};
  const kind = filePreviewKind(path, document?.metadata.mediaType);
  const [mode, setMode] = useState(view.current.viewMode);
  const canRender = document && document.status !== "missing" && (kind === "image" || kind && (draft || document.status !== "binary" && document.status !== "truncated"));
  const rendered = Boolean(canRender && (mode ?? (kind === "markdown" || kind === "image" ? "preview" : "source")) === "preview");
  const page = useFilePage(document, active && !rendered && !draft, view.current.pageOffset, (pageOffset) => update({ pageOffset }));
  const shown = !draft && document?.status === "truncated" && !rendered ? page.document : document;
  const imageDocument = useMemo(() => document && draft ? { ...document, content: draft.content } : document, [document, draft]);
  const [actionError, setActionError] = useState<string>();
  const [comparison, setComparison] = useState<{ version?: string; content: string | null; writable: boolean }>();
  const compare = () => setComparison({ version: document?.version, content: document?.content ?? null, writable: editableDocument(document) });
  const source = draft || shown?.content !== null && shown?.content !== undefined ? { id: document?.status === "truncated" && !draft ? `${state.key}:${page.offset}` : state.key, path,
    content: draft?.content ?? shown!.content!, readOnly: Boolean(state.mutating) || !draft && (!editableDocument(document) || Boolean(state.recoveryError || state.recoveryLoading)), dirty: state.dirty, saving: state.saving } : null;
  const save = () => { if (state.conflict) compare(); else void state.save(); };
  const pagePositions = useRef(new Map(Object.entries(view.current.pagePositions ?? {})));
  const rememberPosition = (position: EditorPosition) => {
    if (document?.status !== "truncated" || draft) { update({ position }); return; }
    const key = String(page.offset); pagePositions.current.delete(key); pagePositions.current.set(key, position);
    while (pagePositions.current.size > 24) pagePositions.current.delete(pagePositions.current.keys().next().value!);
    update({ pagePositions: Object.fromEntries(pagePositions.current) });
  };
  useEffect(() => {
    if (!active || !rendered) return;
    const keyboard = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && !event.isComposing) { event.preventDefault(); save(); } };
    window.addEventListener("keydown", keyboard); return () => window.removeEventListener("keydown", keyboard);
  }, [active, rendered, save]);
  const changeMode = (next: "source" | "preview") => { setMode(next); update({ viewMode: next }); };
  const modes = canRender && (draft || document!.content !== null) ? <div className="file-view-modes" role="group" aria-label={t("filePreview.mode")}>
    <WorkbenchButton label={t("filePreview.source")} aria-pressed={!rendered} onClick={() => changeMode("source")}><Code2 size={15} /></WorkbenchButton>
    <WorkbenchButton label={t("filePreview.preview")} aria-pressed={rendered} onClick={() => changeMode("preview")}><Eye size={15} /></WorkbenchButton>
  </div> : undefined;
  const body = draft?.content ?? document?.content ?? "";
  const content = rendered && active && document?.previewUrl ? kind === "markdown" ? <MarkdownPreview body={body} url={document.previewUrl}
    position={view.current.previewPosition} onPosition={(previewPosition) => update({ previewPosition })} onOpen={onOpen} />
    : kind === "html" ? <HtmlPreview request={{ projectRoot: root, path }} body={body} url={document.previewUrl} active={active} revision={document}
      position={view.current.previewPosition} onPosition={(previewPosition) => update({ previewPosition })} />
      : imageDocument ? <ImagePreview document={imageDocument} zoom={view.current.imageZoom} onZoom={(imageZoom) => update({ imageZoom })}
        position={view.current.previewPosition} onPosition={(previewPosition) => update({ previewPosition })} /> : undefined
    : rendered ? <div className="file-preview-suspended" /> : draft ? undefined : !document || document.status === "truncated" && !shown ? <p className="workbench-empty" role="status">{state.loading || page.loading ? t("preview.reading") : t("preview.failed")}</p>
      : document.status === "missing" ? <p className="workbench-empty">{t("preview.missing")}</p>
        : shown?.status === "binary" ? <BinarySummary document={shown} /> : undefined;
  const notice = <>
    {actionError && <div className="file-document-notice" role="alert">{actionError}</div>}
    {state.recoveryError && <div className="file-document-notice" role="alert"><span>{t("fileEdit.recoveryLoadFailed")} {state.recoveryError.message}</span><button type="button" onClick={state.refresh}>{t("common.retry")}</button></div>}
    {state.draftError && <div className="file-document-notice" role="alert"><span>{t("fileEdit.recoveryFailed")} {state.draftError.message}</span><button type="button" onClick={() => {
      void state.save();
    }}>{t("workbench.save")}</button></div>}
    {state.restored && <div className="file-document-notice" role="status">{t("fileEdit.restored")}</div>}
    {state.conflict && <div className="file-document-notice" role="alert"><span>{t("fileEdit.conflict")}</span><button type="button" onClick={compare}>{t("fileEdit.compare")}</button></div>}
    {state.saveError && <div className="file-document-notice" role="alert"><span>{t("fileEdit.saveFailed")} {state.saveError.message}</span>
      <button type="button" disabled={state.saving} onClick={save}>{t(state.conflict ? "fileEdit.compare" : "common.retry")}</button></div>}
    {state.error && <div className="file-document-notice" role="alert"><span>{t("preview.failed")} {state.error.message}</span><button type="button" onClick={state.refresh}>{t("common.retry")}</button></div>}
    {state.mode === "polling" && <div className="file-document-notice" role="status">{t("workbench.polling")}</div>}
    {document?.status === "missing" && draft && <div className="file-document-notice" role="alert">{t("fileEdit.deletedDraft")}</div>}
    {document?.status === "empty" && !draft && <div className="file-document-notice" role="status">{t("preview.empty")}</div>}
    {document?.status === "truncated" && <div className="file-document-notice" role="status">{t("fileView.truncated")}</div>}
    {document?.status === "truncated" && !rendered && !draft && <div className="file-page-tools" data-file-page-version={shown?.version} data-file-offset={page.offset}>
      <span role="status">{shown ? t("filePreview.range", { from: shown.metadata.offset, to: shown.metadata.offset + shown.metadata.readBytes, size: document.metadata.size }) : t("preview.reading")}</span>
      <WorkbenchButton label={t("filePreview.first")} disabled={page.loading || page.offset === 0} onClick={() => page.go(0)}><ChevronsLeft size={15} /></WorkbenchButton>
      <WorkbenchButton label={t("filePreview.previous")} disabled={page.loading || page.offset === 0} onClick={page.previous}><ArrowLeft size={15} /></WorkbenchButton>
      <form onSubmit={(event) => { event.preventDefault(); page.go(Number(new FormData(event.currentTarget).get("offset"))); }}>
        <input key={page.offset} type="number" name="offset" aria-label={t("filePreview.offset")} min={0} max={document.metadata.size - 1} step={1} defaultValue={page.offset} disabled={page.loading} />
      </form>
      <WorkbenchButton label={t("filePreview.next")} disabled={page.loading || !shown?.metadata.nextOffset} onClick={() => page.go(shown!.metadata.nextOffset!)}><ArrowRight size={15} /></WorkbenchButton>
      <WorkbenchButton label={t("filePreview.last")} disabled={page.loading || !shown?.metadata.nextOffset} onClick={() => page.go(Math.max(0, document.metadata.size - DOCUMENT_PAGE_BYTES))}><ChevronsRight size={15} /></WorkbenchButton>
    </div>}
    {page.error && document?.status === "truncated" && !rendered && <div className="file-document-notice" role="alert"><span>{t("preview.failed")} {page.error.message}</span>
      <button type="button" onClick={() => { page.retry(); state.refresh(); }}>{t("common.retry")}</button></div>}
    {state.loading && document && <div className="file-document-notice" role="status">{t("preview.reading")}</div>}
  </>;
  return <><FileWorkbench projectName={root.split(/[\\/]/).pop() ?? root} document={source ?? (document ? { id: state.key, path, content: "", readOnly: true } : null)}
    entries={[]} query="" onQueryChange={() => {}} onOpen={onOpen} location={location} locationToken={reveal} active={active} navigation={navigation} content={content} notice={notice}
    initialTreeWidth={view.current.treeWidth} initialTreeOpen={view.current.treeOpen} onTreeWidthChange={(treeWidth) => update({ treeWidth })} onTreeOpenChange={onTreeOpen}
    initialPosition={document?.status === "truncated" && !draft ? view.current.pagePositions?.[String(page.offset)] : view.current.position}
    onPositionChange={rememberPosition}
    onLocate={onLocate} onRefresh={() => { page.retry(); state.refresh(); }} editorTools={!rendered && Boolean(source)}
    onChange={state.edit} onSave={save}
    actions={<>{modes}{actions.toolbar}</>} externalOpen={actions.openButton} editorRef={editor}
    onCopyPath={actions.copyRelative}
    />
    {comparison && <FileEditDialog title={t("fileEdit.conflictTitle")} className="file-conflict-dialog" onCancel={() => { if (!state.saving) setComparison(undefined); }}>
      <p><code>{path}</code></p>
      <div className="file-conflict-columns"><section><h3>{t("fileEdit.diskVersion")}</h3><Suspense fallback={<p>{t("workbench.loading")}</p>}>
        {comparison.content === null ? <p>{t("fileEdit.diskUnavailable")}</p> : <CodeEditor documentId={`${state.key}:disk:${comparison.version}`} path={path} value={comparison.content} readOnly />}
      </Suspense></section><section><h3>{t("fileEdit.localVersion")}</h3><Suspense fallback={<p>{t("workbench.loading")}</p>}>
        <CodeEditor documentId={`${state.key}:local`} path={path} value={state.draft?.content ?? ""} readOnly />
      </Suspense></section></div>
      {comparison.version !== state.document?.version && <p role="alert">{t("fileEdit.changedAgain")}</p>}
      {state.saveError && <p role="alert">{state.saveError.message}</p>}
      <div className="workbench-dialog-actions"><button autoFocus type="button" disabled={state.saving} onClick={() => setComparison(undefined)}>{t("common.cancel")}</button>
        <button type="button" disabled={state.saving} onClick={compare}>{t("fileEdit.refreshComparison")}</button>
        <button type="button" disabled={state.saving} onClick={() => { void navigator.clipboard.writeText(state.draft?.content ?? "").catch((error) => setActionError(String(error))); }}>{t("fileEdit.copyText")}</button>
        <button type="button" disabled={state.saving} onClick={() => { void state.discard().then(() => setComparison(undefined)).catch((error) => setActionError(String(error))); }}>{t("fileEdit.useDisk")}</button>
        <button type="button" className="is-destructive" disabled={state.saving || !comparison.writable || !comparison.version || comparison.version !== state.document?.version}
          onClick={() => { void state.save(comparison.version).then((saved) => { if (saved) setComparison(undefined); }); }}>{t(state.saving ? "fileEdit.saving" : "fileEdit.overwrite")}</button></div>
    </FileEditDialog>}</>;
}
