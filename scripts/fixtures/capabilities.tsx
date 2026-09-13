import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Chat, SidebarNav } from "../../src/renderer/ui";
import { WorkbenchPanels } from "../../src/renderer/browser/workbench-panels";
import { useBrowserPanels } from "../../src/renderer/browser/use-browser-panels";
import { LocaleProvider } from "../../src/renderer/i18n";
import "../../src/renderer/styles.css";

function Fixture() {
  const panels = useBrowserPanels();
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState<string>();
  const [focus, setFocus] = useState(0);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { void window.harness.workspace.recent().then((items) => { setWorkspaces(items.map((item) => item.path)); setWorkspace(items[0]?.path); }); }, []);
  const open = () => { panels.openPanel("mcp"); panels.openPanel("skills"); setFocus((value) => value + 1); };
  return <div className={`app${window.harness.platform === "darwin" ? " darwin" : ""}`}>
    <SidebarNav collapsed={false} onToggle={() => {}} onNew={() => {}} onOpen={() => {}} onCapabilities={open} account={<span>TACode · 本地工作台</span>}>
      <div style={{ padding: "20px 14px", color: "var(--ink-2)", fontSize: 12 }}><p>项目</p>{workspaces.map((item, index) => <button type="button" key={item} data-project={index} className="nav-btn" style={{ width: "100%", marginBottom: 5 }} onClick={() => setWorkspace(item)}>{index === 0 ? "TACode" : "另一个项目"}</button>)}</div>
    </SidebarNav>
    <Chat title="配置项目能力" inspectFocusToken={focus} inspectMinWidth={panels.active === "skills" || panels.active === "mcp" ? 440 : 0}
      inspect={workspace ? <WorkbenchPanels panels={panels} workspace={workspace} review={<p>审查项目改动</p>} files={<p>项目文件</p>} onUsePrompt={setDraft} onError={setError}
        sideChatProps={{ workspace, model: "fixture", modelKey: "fixture", models: [], effort: "off", effortLevels: ["off"], permission: "auto" }} /> : undefined}
      composer={<div style={{ margin: "auto 30px 25px", padding: 16, borderRadius: 14, background: "var(--surface)", boxShadow: "var(--shadow-hairline)" }}><textarea aria-label="消息" placeholder="描述任务，或输入 / 调用技能" value={draft} onChange={(event) => setDraft(event.target.value)} style={{ width: "100%", height: 65, resize: "none", border: 0, outline: 0, background: "transparent", color: "var(--ink)", font: "inherit" }} /><div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 10 }}>TACode　·　自动权限</div></div>}>
      <div className="conversation" style={{ padding: "55px 38px" }}><div style={{ maxWidth: 500 }}><h2 style={{ fontSize: 20, fontWeight: 500 }}>把常用能力留在项目里</h2><p style={{ color: "var(--ink-2)", fontSize: 14, lineHeight: 1.9 }}>在右侧管理 Skills 和 MCP。整理技能、连接外部工具，继续在同一个对话中完成工作。</p>{error && <p role="alert">{error}</p>}</div></div>
    </Chat>
  </div>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><LocaleProvider><Fixture /></LocaleProvider></StrictMode>);
