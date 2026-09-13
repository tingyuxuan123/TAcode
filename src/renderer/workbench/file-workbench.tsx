import { lazy, Suspense, useState, type Ref } from "react";
import { ChevronDown, Copy, ExternalLink, Folders, Save, WrapText } from "lucide-react";
import { useI18n } from "../i18n";
import { WorkbenchSurface } from "./surface";
import { WorkbenchFileTree } from "./file-tree";
import { WorkbenchBreadcrumb, WorkbenchButton } from "./controls";
import type { CodeEditorHandle } from "./code-editor";
import type { SourceLocation, WorkbenchColorScheme, WorkbenchTreeEntry } from "./types";

const CodeEditor = lazy(() => import("./code-editor").then((module) => ({ default: module.CodeEditor })));

export interface FileWorkbenchDocument {
  id: string;
  path: string;
  content: string;
  dirty?: boolean;
  readOnly?: boolean;
}

/** Presentation shared by the production document controller and isolated Electron fixture. */
export function FileWorkbench({ projectName, document, entries, query, onQueryChange, onOpen, onExpand, onChange, onSave, onCopyPath, onExternalOpen, location, active = true, colorScheme = "light", editorRef, initialExpanded, initialTreeWidth }: {
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
  active?: boolean;
  colorScheme?: WorkbenchColorScheme;
  editorRef?: Ref<CodeEditorHandle>;
  initialExpanded?: readonly string[];
  initialTreeWidth?: number;
}) {
  const { t } = useI18n();
  const [treeOpen, setTreeOpen] = useState(true);
  const [wrap, setWrap] = useState(true);
  return <WorkbenchSurface treeOpen={treeOpen} colorScheme={colorScheme} initialTreeWidth={initialTreeWidth}
    toolbar={<>
      <WorkbenchBreadcrumb projectName={projectName} path={document?.path ?? ""} />
      {document?.dirty && <span className="workbench-dirty" title={t("workbench.unsaved")} aria-label={t("workbench.unsaved")} />}
      {document?.readOnly && <span className="workbench-readonly">{t("workbench.readOnly")}</span>}
      <span className="workbench-toolbar-spacer" />
      <WorkbenchButton label={t("workbench.wrap")} aria-pressed={wrap} onClick={() => setWrap(!wrap)}><WrapText size={16} /></WorkbenchButton>
      {onCopyPath && <WorkbenchButton label={t("workbench.copyPath")} disabled={!document} onClick={onCopyPath}><Copy size={16} /></WorkbenchButton>}
      {onSave && !document?.readOnly && <WorkbenchButton label={t("workbench.save")} disabled={!document?.dirty} onClick={onSave}><Save size={16} /></WorkbenchButton>}
      <WorkbenchButton label={t(treeOpen ? "workbench.hideTree" : "workbench.showTree")} aria-pressed={treeOpen} onClick={() => setTreeOpen(!treeOpen)}><Folders size={18} /></WorkbenchButton>
      {onExternalOpen && <WorkbenchButton label={t("workbench.open")} className="has-label is-outlined" disabled={!document} onClick={onExternalOpen}>
        <ExternalLink size={15} /><span>{t("workbench.open")}</span><ChevronDown size={12} />
      </WorkbenchButton>}
    </>}
    navigation={<WorkbenchFileTree entries={entries} selectedPath={document?.path} query={query} onQueryChange={onQueryChange}
      onOpen={onOpen} onExpand={onExpand} initialExpanded={initialExpanded} />}>
    {document ? <Suspense fallback={<p className="workbench-empty" role="status">{t("workbench.editorLoading")}</p>}>
      <CodeEditor ref={editorRef} documentId={document.id} path={document.path} value={document.content} readOnly={document.readOnly}
        wrap={wrap} colorScheme={colorScheme} active={active} location={location} onChange={onChange} onSave={onSave} />
    </Suspense> : <p className="workbench-empty">{t("workbench.selectFile")}</p>}
  </WorkbenchSurface>;
}
