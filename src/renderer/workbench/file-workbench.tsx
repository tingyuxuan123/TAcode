import { lazy, Suspense, useState, type Ref, type ReactNode } from "react";
import { ChevronDown, Copy, ExternalLink, Folders, LocateFixed, RefreshCw, Save, WrapText } from "lucide-react";
import { useI18n } from "../i18n";
import { WorkbenchSurface } from "./surface";
import { WorkbenchFileTree } from "./file-tree";
import { WorkbenchBreadcrumb, WorkbenchButton } from "./controls";
import type { CodeEditorHandle } from "./code-editor";
import type { SourceLocation, WorkbenchColorScheme, WorkbenchTreeEntry } from "./types";
import type { EditorPosition } from "./file-view-state";

const CodeEditor = lazy(() => import("./code-editor").then((module) => ({ default: module.CodeEditor })));

export interface FileWorkbenchDocument {
  id: string;
  path: string;
  content: string;
  dirty?: boolean;
  saving?: boolean;
  readOnly?: boolean;
}

/** Presentation shared by the production document controller and isolated Electron fixture. */
export function FileWorkbench({ projectName, document, entries, query, onQueryChange, onOpen, onExpand, onChange, onSave, onCopyPath, onExternalOpen, location, locationToken, active = true, colorScheme = "light", editorRef, initialExpanded, initialTreeWidth, initialTreeOpen = true, onTreeWidthChange, onTreeOpenChange, navigation, content, notice, onLocate, onRefresh, initialPosition, onPositionChange, actions, externalOpen }: {
  projectName: string;
  document: FileWorkbenchDocument | null;
  entries: readonly WorkbenchTreeEntry[];
  query: string;
  onQueryChange(query: string): void;
  onOpen(path: string): void;
  onExpand?(path: string): void;
  onChange?(content: string): void;
  onSave?(): void;
  onCopyPath?(): void;
  onExternalOpen?(): void;
  location?: SourceLocation;
  locationToken?: number;
  active?: boolean;
  colorScheme?: WorkbenchColorScheme;
  editorRef?: Ref<CodeEditorHandle>;
  initialExpanded?: readonly string[];
  initialTreeWidth?: number;
  initialTreeOpen?: boolean;
  onTreeWidthChange?(width: number): void;
  onTreeOpenChange?(open: boolean): void;
  navigation?: ReactNode;
  content?: ReactNode;
  notice?: ReactNode;
  onLocate?(): void;
  onRefresh?(): void;
  initialPosition?: EditorPosition;
  onPositionChange?(position: EditorPosition): void;
  actions?: ReactNode;
  externalOpen?: ReactNode;
}) {
  const { t } = useI18n();
  const [treeOpen, setTreeOpen] = useState(initialTreeOpen);
  const [wrap, setWrap] = useState(true);
  return <WorkbenchSurface treeOpen={treeOpen} colorScheme={colorScheme} initialTreeWidth={initialTreeWidth} onTreeWidthChange={onTreeWidthChange} context={notice}
    toolbar={<>
      <WorkbenchBreadcrumb projectName={projectName} path={document?.path ?? ""} />
      {document?.dirty && <span className="workbench-dirty" title={t("workbench.unsaved")} aria-label={t("workbench.unsaved")} />}
      {document?.readOnly && <span className="workbench-readonly">{t("workbench.readOnly")}</span>}
      <span className="workbench-toolbar-spacer" />
      {actions}
      <WorkbenchButton label={t("workbench.wrap")} aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText size={16} /></WorkbenchButton>
      {onCopyPath && <WorkbenchButton label={t("workbench.copyPath")} disabled={!document} onClick={onCopyPath}><Copy size={16} /></WorkbenchButton>}
      {onLocate && <WorkbenchButton label={t("fileView.locate")} disabled={!document} onClick={() => { setTreeOpen(true); onTreeOpenChange?.(true); onLocate(); }}><LocateFixed size={16} /></WorkbenchButton>}
      {onRefresh && <WorkbenchButton label={t("workbench.refresh")} onClick={onRefresh}><RefreshCw size={16} /></WorkbenchButton>}
      {onSave && !document?.readOnly && <WorkbenchButton label={t(document?.saving ? "fileEdit.saving" : "workbench.save")} disabled={!document?.dirty || document.saving} onClick={onSave}><Save size={16} /></WorkbenchButton>}
      <WorkbenchButton label={t(treeOpen ? "workbench.hideTree" : "workbench.showTree")} aria-pressed={treeOpen} onClick={() => { setTreeOpen(!treeOpen); onTreeOpenChange?.(!treeOpen); }}><Folders size={18} /></WorkbenchButton>
      {onExternalOpen && <WorkbenchButton label={t("workbench.open")} className="has-label is-outlined" disabled={!document} onClick={onExternalOpen}>
        <ExternalLink size={15} /><span>{t("workbench.open")}</span><ChevronDown size={12} />
      </WorkbenchButton>}
      {externalOpen}
    </>}
    navigation={navigation ?? <WorkbenchFileTree entries={entries} selectedPath={document?.path} query={query} onQueryChange={onQueryChange}
      onOpen={onOpen} onExpand={onExpand} initialExpanded={initialExpanded} />}>
    {content ?? (document ? <Suspense fallback={<p className="workbench-empty" role="status">{t("workbench.editorLoading")}</p>}>
      <CodeEditor ref={editorRef} documentId={document.id} path={document.path} value={document.content} readOnly={document.readOnly}
        wrap={wrap} colorScheme={colorScheme} active={active} location={location} locationToken={locationToken} onChange={onChange} onSave={onSave} initialPosition={initialPosition} onPositionChange={onPositionChange} />
    </Suspense> : <p className="workbench-empty">{t("workbench.selectFile")}</p>)}
  </WorkbenchSurface>;
}
