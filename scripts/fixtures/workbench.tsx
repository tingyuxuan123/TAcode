import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkbenchPanels } from "../../src/renderer/browser/workbench-panels";
import { useBrowserPanels } from "../../src/renderer/browser/use-browser-panels";
import { LocaleProvider } from "../../src/renderer/i18n";
import { Chat, SidebarNav } from "../../src/renderer/ui";
import { AccountMenu, SessionRow } from "../../src/renderer/App";
import "../../src/renderer/styles.css";

function Fixture() {
  const panels = useBrowserPanels();
  const [action, setAction] = useState("");
  const [activeProject, setActiveProject] = useState("xc-app");
  const [activeSession, setActiveSession] = useState("web-1");
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>({});
  const projects = [
    { name: "xc-app", sessions: [{ id: "web-1", title: "打开项目Web端" }, { id: "web-2", title: "高级查询" }] },
    { name: "TAcode", sessions: [{ id: "tether-1", title: "修复浏览器" }, { id: "tether-2", title: "文档整理" }] },
  ];
  const withChat = new URLSearchParams(location.search).has("chat");
  const content = <WorkbenchPanels panels={panels} inspect={<div>审查测试内容</div>} onError={(message) => { throw new Error(message); }} />;
  return <div className={withChat ? `app ${window.harness.platform === "darwin" ? "darwin" : ""}` : undefined} style={{ display: "flex", width: "100%", height: "100vh" }}>
    {withChat ? <>
      <SidebarNav
        onNew={() => setAction("已新建对话")}
        onOpen={() => setAction("已打开项目")}
        account={<AccountMenu model="本地模型" configured onOpenSettings={() => setAction("已打开设置")} />}
      >
        <div className="section-label">项目</div>
        {projects.map((project) => (
          <div className="project open" key={project.name}>
            <div className={project.name === activeProject ? "project-head active" : "project-head"}>
              <button className="project-row" title={`${project.name}\n/test/${project.name}`} aria-label={project.name} aria-current={project.name === activeProject ? "true" : undefined} onClick={() => { setActiveProject(project.name); setAction(`已切换项目：${project.name}`); }}>
                <strong className="sidebar-full-label">{project.name}</strong>
                <span className="sidebar-short-label" aria-hidden="true">{project.name.slice(0, 2)}</span>
              </button>
            </div>
            <div className="session-list nested" data-fixture-session={project.name}>
              {project.sessions.map((item) => {
                const title = sessionTitles[item.id] ?? item.title;
                return <SessionRow
                  key={item.id}
                  session={{ id: item.id, title, path: `/test/${item.id}`, storagePath: `/test/${item.id}`, cwd: `/test/${project.name}`, createdAt: "2026-09-08", updatedAt: "2026-09-08", messageCount: 2, pinned: item.id === "web-1", archived: false }}
                  active={item.id === activeSession}
                  onOpen={() => { setActiveSession(item.id); setActiveProject(project.name); setAction(`已切换会话：${title}`); }}
                  onPin={() => setAction("已切换置顶")}
                  onRename={(next) => { setSessionTitles((current) => ({ ...current, [item.id]: next })); setAction(`已重命名：${next}`); }}
                  onRemove={() => setAction("已请求移除")}
                />;
              })}
            </div>
          </div>
        ))}
      </SidebarNav>
      <Chat inspect={content} title="浏览器宽度测试">
        <div className="conversation" style={{ padding: 24 }}>对话区保持可用，拖动分隔线可为网页分配更多空间。<p role="status">{action}</p></div>
      </Chat>
    </> : content}
  </div>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><LocaleProvider><Fixture /></LocaleProvider></StrictMode>,
);
