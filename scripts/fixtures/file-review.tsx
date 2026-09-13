import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LocaleProvider, useI18n } from "../../src/renderer/i18n";
import { FileWorkbench } from "../../src/renderer/workbench/file-workbench";
import { ReviewWorkbench } from "../../src/renderer/workbench/review-workbench";
import type { CodeEditorHandle } from "../../src/renderer/workbench/code-editor";
import type { ReviewScope, WorkbenchColorScheme, WorkbenchDiffFile, WorkbenchTreeEntry } from "../../src/renderer/workbench/types";
import browserScript from "../test-browser.mjs?raw";
import composerScript from "../composer-drafts-smoke.ts?raw";
import "@fontsource-variable/inter";
import "./file-review.css";

const directories = [".agents", ".cursor", ".git", ".github", ".local", ".pi", ".pnpm-store", ".worktrees", ".zcode", "build", "dist", "dist-electron", "dist-electron/extensions", "dist-electron/main", "dist-electron/preload", "dist-electron/runtime", "docs", "scripts", "src", "src/renderer", "src/shared"];
const sources: Record<string, string> = {
  "scripts/test-browser.mjs": browserScript,
  "src/renderer/App.tsx": 'import { useState } from "react";\n\nexport function App() {\n  const [count, setCount] = useState(0);\n  return <button onClick={() => setCount(count + 1)}>中文按钮 {count}</button>;\n}\n',
  "src/shared/中文 空格.ts": "export const greeting = '你好';\r\nexport const enabled = true;\r\n",
  ".agents/hidden.md": "# 隐藏目录中的文件\n",
};
const entries: WorkbenchTreeEntry[] = [
  ...directories.map((path) => ({ path, kind: "directory" as const })),
  ...[...Object.keys(sources), "dist-electron/extensions/browser.js", "dist-electron/extensions/provider.js", "dist-electron/extensions/vision.js", "dist-electron/preload/index.cjs", "dist-electron/preload/index.cjs.map", "dist-electron/preload/webview-browser.cjs", "dist-electron/preload/webview-browser.cjs.map", "dist-electron/chunk-BS7KFN42.js", "docs/文件说明.md"].map((path) => ({ path, kind: "file" as const })),
];
const repeatedLines = Array.from({ length: 150 }, (_, index) => `export const value${index + 1} = "line ${index + 1}";`);
const diffFiles: WorkbenchDiffFile[] = [
  { id: "composer-smoke", path: "scripts/composer-drafts-smoke.ts", oldContent: null, newContent: composerScript, change: "untracked", additions: composerScript.split("\n").length - 1, deletions: 0, version: 1 },
  { id: "session-smoke", path: "scripts/session-activity-smoke.ts", oldContent: repeatedLines.join("\n") + "\n", newContent: repeatedLines.map((line, index) => index === 80 ? 'export const value81 = "updated";' : line).join("\n") + "\n", change: "modified", additions: 1, deletions: 1, version: 1 },
  { id: "app", path: "src/renderer/App.tsx", oldContent: sources["src/renderer/App.tsx"], newContent: sources["src/renderer/App.tsx"].replace("useState(0)", "useState(1)"), change: "modified", additions: 1, deletions: 1, version: 1 },
  ...["composer-drafts.test.ts", "composer-drafts.ts", "styles.css", "ui.tsx", "use-composer-drafts.ts"].map((name, index) => ({
    id: name, path: `src/renderer/${name}`, oldContent: index === 2 || index === 3 ? "// Original\n" : null,
    newContent: `// ${name}\nexport const draft = "未保存的中文内容";\n`, change: index === 2 || index === 3 ? "modified" as const : "untracked" as const, additions: 2, deletions: index === 2 || index === 3 ? 1 : 0, version: 1,
  })),
  { id: "i18n", path: "src/shared/i18n.ts", oldContent: 'export const label = "Draft";\n', newContent: 'export const label = "草稿";\n', change: "modified", additions: 1, deletions: 1, version: 1 },
];

function Fixture() {
  const { setLocale } = useI18n();
  const [view, setView] = useState<"files" | "review">("files");
  const [path, setPath] = useState("scripts/test-browser.mjs");
  const [documents, setDocuments] = useState(sources);
  const [dirty, setDirty] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [scope, setScope] = useState<ReviewScope>("unstaged");
  const [query, setQuery] = useState("");
  const [colorScheme, setColorScheme] = useState<WorkbenchColorScheme>("light");
  const editor = useRef<CodeEditorHandle>(null);
  const diagnostics = useRef({ saves: 0, lastAction: "", worker: null as unknown, selection: null as unknown });
  const save = () => { diagnostics.current.saves++; setDirty(false); };
  const open = (target: string) => { setPath(target); setDirty(false); };
  useEffect(() => {
    (window as any).fileReviewFixture = {
      showFiles: () => setView("files"), showReview: () => setView("review"), open,
      setReadOnly, setColorScheme, setLocale,
      focusEditor: (line = 1, column = 1) => { editor.current?.focus(); editor.current?.reveal({ line, column }); },
      state: () => ({ ...diagnostics.current, view, path, scope, content: documents[path] ?? "", dirty, readOnly, colorScheme }),
    };
  });
  return view === "files" ? <FileWorkbench projectName="TAcode" document={{ id: `fixture:${path}`, path, content: documents[path] ?? "", dirty, readOnly }}
    entries={entries} query={query} onQueryChange={setQuery} onOpen={open} onChange={(content) => { setDocuments((current) => ({ ...current, [path]: content })); setDirty(true); }}
    onSave={save} onCopyPath={() => { diagnostics.current.lastAction = "copy"; }} onExternalOpen={() => { diagnostics.current.lastAction = "open"; }}
    initialExpanded={["dist-electron", "dist-electron/extensions", "dist-electron/preload", "docs"]} editorRef={editor} colorScheme={colorScheme} />
    : <ReviewWorkbench files={diffFiles} scope={scope} onScopeChange={setScope} onOpenFile={(path) => { open(path); setView("files"); }}
      onRefresh={() => { diagnostics.current.lastAction = "refresh"; }} onStageAll={() => { diagnostics.current.lastAction = "stageAll"; }}
      onUnstageAll={() => { diagnostics.current.lastAction = "unstageAll"; }} onDiscardAll={() => { diagnostics.current.lastAction = "discardAll"; }}
      onCommit={() => { diagnostics.current.lastAction = "commit"; }} colorScheme={colorScheme}
      onWorkerStateChange={(worker) => { diagnostics.current.worker = worker; }} onSelectionChange={(selection) => { diagnostics.current.selection = selection; }} />;
}

createRoot(document.getElementById("root")!).render(<StrictMode><LocaleProvider><Fixture /></LocaleProvider></StrictMode>);
