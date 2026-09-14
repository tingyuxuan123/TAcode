import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { FileWorkbench } from "./file-workbench";
import { editableDocument, useFileDocument } from "./file-document-store";
import { FileEditDialog } from "./file-editing";
import { ProjectFileTree } from "./project-file-tree";
import { readFileView, writeFileView, type FileViewState } from "./file-view-state";
import { useWorkbenchVisible } from "./use-workbench-visible";
import type { SourceLocation, WorkbenchTreeEntry } from "./types";
const CodeEditor = lazy(() => import("./code-editor").then((module) => ({ default: module.CodeEditor })));

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
  const update = useCallback((change: Partial<FileViewState>) => {
    view.current = { ...view.current, ...change }; clearTimeout(timer.current);
    timer.current = setTimeout(() => writeFileView(scope, path ?? "", view.current), 150);
  }, [scope, path]);
  useEffect(() => () => { clearTimeout(timer.current); writeFileView(scope, path ?? "", view.current); }, [scope, path]);
  const [treeVisible, setTreeVisible] = useState(view.current.treeOpen ?? true);
  const navigateFromTree = (value: string, options?: { preview?: boolean; literal?: boolean }) => {
    // A newly opened tab inherits navigation so a second click still reaches the same row.
    if (value !== path && !Object.keys(readFileView(scope, value)).length) writeFileView(scope, value, { ...view.current, position: undefined });
    onOpen(value, options);
  };
  const navigation = <ProjectFileTree root={root} path={path} active={visible && treeVisible} view={view.current} onViewChange={update} onOpen={navigateFromTree} changes={changes} reveal={reveal + (props.reveal ?? 0)} />;
  return <div ref={ref} className="project-file-panel" data-file-project={root} data-file-path={path ?? ""} data-file-active={visible}>
    {path ? <DocumentView {...props} active={visible} navigation={navigation} view={view.current} update={update} onLocate={() => { setTreeVisible(true); setReveal((value) => value + 1); }}
      onTreeOpen={(open) => { setTreeVisible(open); update({ treeOpen: open }); }} />
      : <FileWorkbench projectName={root.split(/[\\/]/).pop() ?? root} document={null} entries={[]} query="" onQueryChange={() => {}} onOpen={onOpen}
        initialTreeWidth={view.current.treeWidth} initialTreeOpen={view.current.treeOpen} onTreeWidthChange={(treeWidth) => update({ treeWidth })}
        onTreeOpenChange={(open) => { setTreeVisible(open); update({ treeOpen: open }); }} navigation={navigation} />}
  </div>;
}
function DocumentView({ root, path = "", active, location, reveal, onOpen, navigation, view, update, onLocate, onTreeOpen }: ProjectFilePanelProps & {
  navigation: React.ReactNode; view: FileViewState; update(change: Partial<FileViewState>): void; onLocate(): void; onTreeOpen(open: boolean): void;
}) {
  const { t } = useI18n(); const state = useFileDocument(root, path, active);
  const displayed = useRef(active ? { document: state.document, draft: state.draft } : undefined);
  // Hidden editors have no scroll box; apply shared disk updates when visible.
  if (active) displayed.current = { document: state.document, draft: state.draft };
  const { document, draft } = displayed.current ?? {};
  const [actionError, setActionError] = useState<string>();
  const [comparison, setComparison] = useState<{ version?: string; content: string | null; writable: boolean }>();
  const compare = () => setComparison({ version: document?.version, content: document?.content ?? null, writable: editableDocument(document) });
  const source = draft || document?.content !== null && document?.content !== undefined ? { id: state.key, path,
    content: draft?.content ?? document!.content!, readOnly: !draft && (!editableDocument(document) || Boolean(state.recoveryError || state.recoveryLoading)), dirty: state.dirty, saving: state.saving } : null;
  const save = () => { if (state.conflict) compare(); else void state.save(); };
  const content = draft ? undefined : !document ? <p className="workbench-empty" role="status">{state.loading ? t("preview.reading") : t("preview.failed")}</p>
    : document.status === "missing" ? <p className="workbench-empty">{t("preview.missing")}</p>
      : document.status === "binary" ? <p className="workbench-empty">{t(document.metadata.encoding === "invalid" ? "fileView.invalidEncoding" : "preview.binary")}</p> : undefined;
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
  </>;
  return <><FileWorkbench projectName={root.split(/[\\/]/).pop() ?? root} document={source ?? (document ? { id: state.key, path, content: "", readOnly: true } : null)}
    entries={[]} query="" onQueryChange={() => {}} onOpen={onOpen} location={location} locationToken={reveal} active={active} navigation={navigation} content={content} notice={notice}
    initialTreeWidth={view.treeWidth} initialTreeOpen={view.treeOpen} onTreeWidthChange={(treeWidth) => update({ treeWidth })} onTreeOpenChange={onTreeOpen}
    initialPosition={view.position} onPositionChange={(position) => update({ position })} onLocate={onLocate} onRefresh={state.refresh}
    onChange={state.edit} onSave={save}
    onCopyPath={() => { setActionError(undefined); void navigator.clipboard.writeText(path).catch((error) => setActionError(String(error))); }}
    onExternalOpen={() => { setActionError(undefined); void window.harness.workspace.open(path, root).catch((error) => setActionError(String(error))); }} />
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
