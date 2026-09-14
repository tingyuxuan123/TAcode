import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { LocaleProvider, useI18n } from "../../src/renderer/i18n";
import { WorkbenchPanels } from "../../src/renderer/browser/workbench-panels";
import { FilesPanel } from "../../src/renderer/browser/files-panel";
import { useBrowserPanels } from "../../src/renderer/browser/use-browser-panels";
import { GitReviewPanel } from "../../src/renderer/workbench/git-review-panel";
import { AssistantTurn } from "../../src/renderer/ui";
import { PreviewContext } from "../../src/renderer/file-path-chip";
import type { ChatMessage } from "../../src/renderer/conversation";
import { fileScope, readFileTabs } from "../../src/renderer/workbench/file-view-state";
import { filePanelId } from "../../src/renderer/browser/panel-state";
import "../../src/renderer/styles.css";
import "./file-review.css";

function Fixture() {
  const [nativeEvents] = useState<Array<unknown>>([]);
  useEffect(() => {
    const record = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest('[data-panel-id]')) return; nativeEvents.push({ type: event.type, pointer: event.pointerId, buttons: event.buttons, x: event.clientX, y: event.clientY }); if (nativeEvents.length > 40) nativeEvents.shift(); };
    const keys = (event: KeyboardEvent) => { nativeEvents.push({ type: event.type, key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, composing: event.isComposing, target: (event.target as HTMLElement).closest('[data-panel-id]')?.getAttribute('data-panel-id') }); if (nativeEvents.length > 40) nativeEvents.shift(); };
    document.addEventListener("keydown", keys, true);
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) document.addEventListener(type, record as EventListener, true);
    return () => { document.removeEventListener("keydown", keys, true); for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) document.removeEventListener(type, record as EventListener, true); };
  }, [nativeEvents]);
  const [root, setRoot] = useState(new URLSearchParams(location.search).get("project") ?? "");
  const [session, setSession] = useState("session-1"); const [hidden, setHidden] = useState(false);
  const [error, setError] = useState(""); const panels = useBrowserPanels(root, session); const { setLocale } = useI18n();
  const open = useCallback((path: string, options?: { preview?: boolean; literal?: boolean }) => { try { panels.openFile(path, options); setHidden(false); } catch { setError("outsideProject"); } }, [panels.openFile]);
  useEffect(() => {
    const scope = fileScope(root, session); const saved = readFileTabs(scope);
    panels.openFiles(); if (saved.activePath) panels.selectPanel(filePanelId(saved.activePath, root, scope));
  }, [panels.openFiles]);
  useEffect(() => {
    const editor = () => { const host = document.querySelector('[data-file-active="true"] .cm-editor'); return host ? EditorView.findFromDOM(host as HTMLElement) : null; };
    (window as any).fileWorkbenchFixture = { setRoot, setSession, setHidden, setLocale, nativeEvents, state: () => ({ tabs: panels.tabs, active: panels.active, filesScope: panels.filesScope, root, session, hidden, error }),
      editor: () => { const view = editor(); if (!view) return null; const selection = view.state.selection.main; const line = view.state.doc.lineAt(selection.from); return { content: view.state.doc.toString(), from: selection.from, to: selection.to, top: view.scrollDOM.scrollTop, selectionLine: line.number, column: selection.from - line.from + 1 }; },
      setPosition: (top: number, line: number) => { const view = editor(); if (view) { view.dispatch({ selection: { anchor: view.state.doc.line(line).from } }); view.scrollDOM.scrollTop = top; view.scrollDOM.dispatchEvent(new Event("scroll")); } },
    };
  });
  const message: ChatMessage = { id: "file-entries", role: "assistant", text: "`same.txt:120:3`", images: [], tools: [
    { id: "read-file", name: "read", title: "read", status: "complete", args: { path: `${root}/same.txt` }, output: "Read same.txt" },
    { id: "write-file", name: "write", title: "write", status: "complete", args: { path: "same.txt", content: "fixture" } },
    { id: "read-colon", name: "read", title: "read", status: "complete", args: { path: `${root}/colon.txt:12` }, output: "Read literal colon filename" },
  ], work: [{ type: "tool", id: "read", toolId: "read-file" }, { type: "tool", id: "write", toolId: "write-file" }, { type: "tool", id: "read-colon", toolId: "read-colon" }, { type: "text", id: "text", text: "`same.txt:120:3`" }] };
  return <div style={{ display: "flex", height: "100%", minWidth: 0 }}>
    <aside style={{ width: 260, flexShrink: 0, padding: 16, overflow: "auto" }}>
      <PreviewContext.Provider value={open}><AssistantTurn messages={[message]} workspace={root} canAutoCollapse={false} onOpenPath={(path) => open(path, { literal: true })} onOpenFile={(file) => open(file.path, { literal: true })} /></PreviewContext.Provider>
      {error && <p role="alert">{error}</p>}
    </aside>
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: hidden ? "none" : "flex" }}>
      <WorkbenchPanels panels={panels} workspace={root} onOpenFile={open} onError={setError}
        sideChatProps={{ workspace: root, model: "", modelKey: "", models: [], effort: "", effortLevels: [], permission: "plan" }}
        files={<FilesPanel workspace={root} scope={panels.filesScope} active={panels.active === "files"} files={[]} onOpen={open} />}
        review={<GitReviewPanel projectRoot={root} active={panels.active === "review"} onOpenFile={(path) => open(path, { literal: true })} />} />
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><LocaleProvider><Fixture /></LocaleProvider></StrictMode>);
