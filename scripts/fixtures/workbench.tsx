import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkbenchPanels } from "../../src/renderer/browser/workbench-panels";
import { useBrowserPanels } from "../../src/renderer/browser/use-browser-panels";
import { useDelegationTabs } from "../../src/renderer/browser/use-delegation-tabs";
import { useSidebarLayout } from "../../src/renderer/sidebar-layout";
import { LocaleProvider } from "../../src/renderer/i18n";
import { AssistantTurn, Chat, SidebarNav } from "../../src/renderer/ui";
import type { ChatMessage } from "../../src/renderer/conversation";
import { AccountMenu, SessionRow } from "../../src/renderer/App";
import { PanelActionsProvider, usePanelActions } from "../../src/renderer/panel-actions";
import { ComposerFixture } from "./composer";
import "../../src/renderer/styles.css";

/** 走 context 打开子代理标签（复现主会话里委派卡片的入口链路）。 */
function ContextOpenButton() {
  const { openChildSession } = usePanelActions();
  return (
    <button
      type="button"
      data-fixture-open-child-context
      onClick={() => openChildSession?.("/test/child-2.jsonl", {
        role: "code-reviewer",
        title: "审查委派实现",
        status: "running",
        startedAt: Date.now() - 5_000,
      })}
    >
      卡片入口
    </button>
  );
}

function Fixture() {
  const panels = useBrowserPanels();
  // 动态委派消息：模拟父代理创建子代理（用于验证「创建即自动开标签 + 运行期刷新」）。
  const [liveDelegation, setLiveDelegation] = useState<ChatMessage[]>([]);
  useDelegationTabs(liveDelegation, panels);
  const startDelegation = () => setLiveDelegation([{
    id: "live-delegation",
    role: "assistant",
    text: "",
    images: [],
    work: [],
    tools: [{
      id: "tool-live-delegate",
      name: "delegate",
      title: "委托 1/1",
      status: "running",
      args: { tasks: [{ role: "explorer", task: "动态委派：统计行数" }] },
      details: {
        total: 1,
        done: 0,
        tasks: [{
          delegationId: "delegation-live",
          role: "explorer",
          task: "动态委派：统计行数",
          status: "running",
          childSessionPath: "/test/child-1.jsonl",
          live: "正在读取 src/main/index.ts",
          toolCalls: 2,
        }],
        results: [],
      },
    }],
  }]);
  const advanceDelegation = () => setLiveDelegation((current) => current.map((message) => ({
    ...message,
    tools: message.tools.map((tool) => ({
      ...tool,
      status: "complete",
      details: {
        total: 1,
        done: 1,
        tasks: [{
          delegationId: "delegation-live",
          role: "explorer",
          task: "动态委派：统计行数",
          status: "completed",
          childSessionPath: "/test/child-1.jsonl",
          toolCalls: 7,
        }],
        results: [],
      },
    })),
  })));
  const sidebarLayout = useSidebarLayout();
  const [action, setAction] = useState("");
  const [activeProject, setActiveProject] = useState("xc-app");
  const [activeSession, setActiveSession] = useState("web-1");
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>({});
  const projects = [
    { name: "xc-app", sessions: [{ id: "web-1", title: "打开项目Web端" }, { id: "web-2", title: "高级查询" }] },
    { name: "TAcode", sessions: [{ id: "tacode-1", title: "修复浏览器" }, { id: "tacode-2", title: "文档整理" }] },
  ];
  const withChat = new URLSearchParams(location.search).has("chat");
  if (new URLSearchParams(location.search).has("composer")) {
    return <div className="app"><section className="chat"><div className="chat-main"><ComposerFixture /></div></section></div>;
  }
  const delegateTurn: ChatMessage = {
    id: "delegate-turn",
    role: "assistant",
    text: "",
    images: [],
    work: [],
    tools: [{
      id: "tool-delegate",
      name: "delegate",
      title: "委托 1/1",
      status: "complete",
      args: { tasks: [{ role: "explorer", task: "分析委派链路" }] },
      details: {
        total: 1,
        done: 1,
        tasks: [{
          delegationId: "delegation-1",
          role: "explorer",
          task: "分析委派链路",
          status: "completed",
          childSessionPath: "/test/child-1.jsonl",
          toolCalls: 48,
          turns: 38,
        }],
        results: [],
      },
    }],
  };
  // 真实审计报告样本（含三列表格 + 短标签列 + 行内 code + 文件 chip），用于验证面板里的换行与排版。
  const inlineReport = [
    "## 结论",
    "",
    "右侧面板的标签类型是判别联合 `WorkbenchPanelTab`，共 3 种：`\"inspect\"`、`\"browser\"`、`\"child-session\"`。",
    "",
    "## 证据",
    "",
    "- 联合类型分发点：`src/renderer/browser/panel-state.ts:15`（已核实）",
    "",
    "| 终态 | 判定位置 | 置信 |",
    "| --- | --- | --- |",
    "| completed | ts delegation-coordinator.ts:609 （collectReport 收口，经 settle） | 已核实 |",
    "| cancelled | :339 （stop）、:385 （重启失败 + stopRequested）、:443 （launch catch） | 已核实 |",
  ].join("\n");
  const inlineTurn: ChatMessage = {
    id: "inline-turn",
    role: "assistant",
    text: "",
    images: [],
    work: [],
    tools: [{
      id: "tool-inline",
      name: "delegate",
      title: "委托 1/1",
      status: "complete",
      args: { tasks: [{ role: "test-runner", task: "跑一遍聚焦测试" }] },
      details: {
        total: 1,
        done: 1,
        tasks: [{
          delegationId: "delegation-inline",
          role: "test-runner",
          task: "跑一遍聚焦测试",
          status: "completed",
          toolCalls: 3,
          recent: [{ at: 1_789_000_000_000, kind: "tool", text: "pnpm test" }],
        }],
        results: [{ role: "test-runner", task: "跑一遍聚焦测试", output: inlineReport, success: true }],
      },
    }],
  };
  const content = <WorkbenchPanels panels={panels} inspect={<div>审查测试内容</div>} onError={(message) => { throw new Error(message); }} />;
  const actions = useMemo(() => ({ openChildSession: panels.openChildSession }), [panels.openChildSession]);
  return <PanelActionsProvider actions={actions}><div className={withChat ? `app ${window.harness.platform === "darwin" ? "darwin" : ""}` : undefined} style={{ display: "flex", width: "100%", height: "100vh" }}>
    {withChat ? <>
      <SidebarNav
        collapsed={sidebarLayout.collapsed}
        onToggle={sidebarLayout.toggle}
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
        <div className="section-label">委派子代理</div>
        <div className="session-list nested" data-fixture-child-session>
          <SessionRow
            session={{
              id: "child-1",
              title: "分析子代理链路",
              path: "/test/child-1.jsonl",
              storagePath: "/test/child-1.jsonl",
              cwd: "/test/TAcode",
              createdAt: "2026-09-10T07:55:42.000Z",
              updatedAt: "2026-09-10T07:57:43.000Z",
              messageCount: 4,
              pinned: false,
              archived: false,
              parentSessionPath: "/test/web-1",
              sourceDelegationId: "delegation-1",
              delegationRole: "explorer",
              delegationStatus: "completed",
            }}
            active={false}
            running={false}
            onOpen={() => {
              // 与 App.tsx 的 openDelegatedSession 一致：key 用委派 id，并带上子会话文件路径。
              panels.openChildSession("delegation-1", {
                role: "explorer",
                title: "分析子代理链路",
                sessionPath: "/test/child-1.jsonl",
                status: "completed",
                startedAt: Date.parse("2026-09-10T07:55:42.000Z"),
                completedAt: Date.parse("2026-09-10T07:57:43.000Z"),
                toolCalls: 48,
                totalTokens: 12_345,
              });
              setAction("已打开子代理标签");
            }}
            onOpenInMain={() => setAction("已在主会话中打开子代理")}
            onPin={() => setAction("已切换置顶")}
            onRename={() => setAction("已重命名")}
            onRemove={() => setAction("已请求移除")}
          />
          <ContextOpenButton />
        </div>
      </SidebarNav>
      <Chat inspect={content} title={new URLSearchParams(location.search).get("title") || "浏览器宽度测试"} onSidebarAutoCollapse={sidebarLayout.collapseAutomatically}>
        <div className="conversation" style={{ padding: 24 }}>
          <p>对话区保持可用，拖动分隔线可为网页分配更多空间。</p>
          <p role="status">{action}</p>
          <button type="button" data-fixture-start-delegation onClick={startDelegation}>模拟委派开始</button>
          <button type="button" data-fixture-advance-delegation onClick={advanceDelegation}>模拟委派完成</button>
          <div data-fixture-delegate-turn>
            <AssistantTurn messages={[delegateTurn]} canAutoCollapse={false} />
          </div>
          <div data-fixture-inline-turn>
            <AssistantTurn messages={[inlineTurn]} canAutoCollapse={false} />
          </div>
        </div>
      </Chat>
    </> : content}
  </div></PanelActionsProvider>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><LocaleProvider><Fixture /></LocaleProvider></StrictMode>,
);
