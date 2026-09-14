import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { FileWorkbench } from "./file-workbench";
import { useFileDocument } from "./file-document-store";
import { ProjectFileTree } from "./project-file-tree";
import { readFileView, writeFileView, type FileViewState } from "./file-view-state";
import { useWorkbenchVisible } from "./use-workbench-visible";
import type { SourceLocation, WorkbenchTreeEntry } from "./types";

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
  const displayed = useRef(active ? state.document : undefined);
  // Hidden editors have no scroll box; apply shared disk updates when visible.
  if (active) displayed.current = state.document;
  const document = displayed.current;
  const [actionError, setActionError] = useState<string>();
  const source = document && document.content !== null ? { id: state.key, path, content: document.content, readOnly: true } : null;
  const content = !document ? <p className="workbench-empty" role="status">{state.loading ? t("preview.reading") : t("preview.failed")}</p>
    : document.status === "missing" ? <p className="workbench-empty">{t("preview.missing")}</p>
      : document.status === "binary" ? <p className="workbench-empty">{t(document.metadata.encoding === "invalid" ? "fileView.invalidEncoding" : "preview.binary")}</p> : undefined;
  const notice = <>
    {actionError && <div className="file-document-notice" role="alert">{actionError}</div>}
    {state.error && <div className="file-document-notice" role="alert"><span>{t("preview.failed")} {state.error.message}</span><button type="button" onClick={state.refresh}>{t("common.retry")}</button></div>}
    {state.mode === "polling" && <div className="file-document-notice" role="status">{t("workbench.polling")}</div>}
    {document?.status === "empty" && <div className="file-document-notice" role="status">{t("preview.empty")}</div>}
    {document?.status === "truncated" && <div className="file-document-notice" role="status">{t("fileView.truncated")}</div>}
  </>;
  return <FileWorkbench projectName={root.split(/[\\/]/).pop() ?? root} document={source ?? (document ? { id: state.key, path, content: "", readOnly: true } : null)}
    entries={[]} query="" onQueryChange={() => {}} onOpen={onOpen} location={location} locationToken={reveal} active={active} navigation={navigation} content={content} notice={notice}
    initialTreeWidth={view.treeWidth} initialTreeOpen={view.treeOpen} onTreeWidthChange={(treeWidth) => update({ treeWidth })} onTreeOpenChange={onTreeOpen}
    initialPosition={view.position} onPositionChange={(position) => update({ position })} onLocate={onLocate} onRefresh={state.refresh}
    onCopyPath={() => { setActionError(undefined); void navigator.clipboard.writeText(path).catch((error) => setActionError(String(error))); }}
    onExternalOpen={() => { setActionError(undefined); void window.harness.workspace.open(path, root).catch((error) => setActionError(String(error))); }} />;
}
