import { describe, expect, it } from "vitest";
import {
  browserPanelLabel,
  childSessionPanelLabel,
  delegationPanelKey,
  createBrowserPanel,
  createChildSessionPanel,
  initialPanelState,
  panelReducer,
  type ChildSessionPanelInfo,
  type PanelState,
} from "./panel-state";

const page = (name: string) => ({ url: `https://${name}.test/`, title: name });
const open = (state: PanelState, id: string, activate = true) => panelReducer(state, { type: "open-browser", tab: createBrowserPanel(id, page(id)), activate });

describe("顶部网页标签状态", () => {
  it("后台新页保留当前选择及现有网页实例", () => {
    const first = open(initialPanelState, "first");
    const next = open(first, "background", false);
    expect(next.active).toBe("first");
    expect(next.tabs[1]).toBe(first.tabs[1]);
    expect(next.tabs.map((tab) => tab.id)).toEqual(["inspect", "first", "background"]);
  });

  it("页面标题和导航更新不改变初始化参数，防止 guest 被重载", () => {
    const state = open(initialPanelState, "first");
    const before = state.tabs[1];
    const next = panelReducer(state, { type: "page", id: "first", page: page("navigated") });
    const after = next.tabs[1];
    expect(after.type).toBe("browser");
    if (before.type !== "browser" || after.type !== "browser") throw new Error("expected browser");
    expect(after.initialTabs).toBe(before.initialTabs);
    expect(after.revision).toBe(before.revision);
    expect(after.page).toEqual(page("navigated"));
    expect(panelReducer(next, { type: "page", id: "first", page: page("navigated") })).toBe(next);
  });

  it("关闭当前网页选择相邻标签，关闭最后一页不会偷偷新建首页", () => {
    let state = open(open(initialPanelState, "left"), "right");
    state = panelReducer(state, { type: "close", id: "right" });
    expect(state.active).toBe("left");
    state = panelReducer(state, { type: "close", id: "inspect" });
    expect(state.active).toBe("left");
    state = panelReducer(state, { type: "close", id: "left" });
    expect(state).toEqual({ tabs: [], active: "" });
  });

  it("独立窗口多页还原各占一个顶部标签，后续关闭广播不会覆盖还原结果", () => {
    let state = open(open(initialPanelState, "detached"), "unrelated");
    state = panelReducer(state, { type: "detach", id: "detached", page: page("before") });
    const unrelated = state.tabs[2];
    const restored = panelReducer(state, { type: "restore", id: "detached", tabs: [
      createBrowserPanel("detached", page("active")), createBrowserPanel("extra", page("extra")),
    ] });
    expect(restored.tabs.map((tab) => tab.id)).toEqual(["inspect", "detached", "extra", "unrelated"]);
    expect(restored.active).toBe("detached");
    expect(restored.tabs[3]).toBe(unrelated);
    expect(restored.tabs[1]).toMatchObject({ initialTabs: [page("active")], detached: false, revision: 1 });
    expect(restored.tabs[2]).toMatchObject({ initialTabs: [page("extra")] });
    expect(panelReducer(restored, { type: "window-closed", id: "detached" })).toBe(restored);
  });

  it("顶部占位已被关闭时，独立窗口仍能还原所有页面", () => {
    const state = panelReducer(initialPanelState, { type: "restore", id: "missing", tabs: [
      createBrowserPanel("missing", page("active")), createBrowserPanel("extra", page("extra")),
    ] });
    expect(state.tabs.map((tab) => tab.id)).toEqual(["inspect", "missing", "extra"]);
    expect(state.active).toBe("missing");
  });

  it("直接关闭独立窗口恢复弹出前的实际页面，并忽略销毁 guest 的迟到元数据", () => {
    const initial = open(initialPanelState, "first");
    const detached = panelReducer(initial, { type: "detach", id: "first", page: page("navigated") });
    expect(panelReducer(detached, { type: "page", id: "first", page: page("stale") })).toBe(detached);
    const closed = panelReducer(detached, { type: "window-closed", id: "first" });
    expect(closed.tabs[1]).toMatchObject({ detached: false, initialTabs: [page("navigated")] });
  });

  it("忽略不存在的 Agent 目标，避免选中空面板", () => {
    expect(panelReducer(initialPanelState, { type: "select", id: "gone" })).toBe(initialPanelState);
  });

  it("无网页标题时显示域名或新标签文案", () => {
    expect(browserPanelLabel(page("Google"), "新建标签页")).toBe("Google");
    expect(browserPanelLabel({ url: "https://example.test/docs", title: "" }, "新建标签页")).toBe("example.test");
    expect(browserPanelLabel({ url: "about:blank", title: "" }, "新建标签页")).toBe("新建标签页");
  });
});

describe("delegationPanelKey", () => {
  it("委派 id 与子会话文件名归一到同一个 key（两个入口因此命中同一个标签）", () => {
    expect(delegationPanelKey("delegation-1")).toBe("delegation-1");
    expect(delegationPanelKey(undefined, "/home/u/.tether/sessions/delegation-1.jsonl")).toBe("delegation-1");
    expect(delegationPanelKey("delegation-1", "/home/u/.tether/sessions/delegation-1.jsonl")).toBe("delegation-1");
    expect(delegationPanelKey(undefined, "C:\\sessions\\delegation-2.jsonl")).toBe("delegation-2");
  });

  it("两边都拿不到身份时返回空串，调用方回退到详情抽屉", () => {
    expect(delegationPanelKey(undefined, undefined)).toBe("");
    expect(delegationPanelKey("   ", "")).toBe("");
  });
});

describe("子代理子会话标签状态", () => {
  const panel = (key: string, info: Partial<ChildSessionPanelInfo> = {}) =>
    createChildSessionPanel(key, { role: "explorer", ...info });

  it("打开标签并激活；不动 inspect 与网页标签", () => {
    const next = panelReducer(initialPanelState, { type: "open-child-session", panel: panel("delegation-1") });
    expect(next.tabs.map((tab) => tab.id)).toEqual(["inspect", "child-session-delegation-1"]);
    expect(next.active).toBe("child-session-delegation-1");
  });

  it("同一个委派（卡片与侧栏同用 delegation id）只开一个标签，信息合并", () => {
    // 卡片入口：带任务与子会话路径；侧栏入口：只有标题与路径。
    const fromCard = panelReducer(initialPanelState, {
      type: "open-child-session",
      panel: panel("delegation-1", { task: "分析委派链路", sessionPath: "/sessions/delegation-1.jsonl", status: "completed" }),
    });
    const fromSidebar = panelReducer(fromCard, {
      type: "open-child-session",
      panel: panel("delegation-1", { title: "分析委派链路", sessionPath: "/sessions/delegation-1.jsonl" }),
    });
    expect(fromSidebar.tabs).toHaveLength(2);
    expect(fromSidebar.active).toBe("child-session-delegation-1");
    const tab = fromSidebar.tabs.find((item) => item.type === "child-session");
    // 两边信息合并，而不是互相覆盖（任务/状态/标题都保留）。
    expect(tab).toMatchObject({
      key: "delegation-1",
      info: { role: "explorer", task: "分析委派链路", title: "分析委派链路", status: "completed", sessionPath: "/sessions/delegation-1.jsonl" },
    });
  });

  it("不同委派各自一个标签，关闭当前标签回落到左邻", () => {
    let state = panelReducer(initialPanelState, { type: "open-child-session", panel: panel("delegation-1") });
    state = panelReducer(state, { type: "open-child-session", panel: panel("delegation-2") });
    expect(state.tabs).toHaveLength(3);
    state = panelReducer(state, { type: "close", id: "child-session-delegation-2" });
    expect(state.active).toBe("child-session-delegation-1");
  });

  it("标签标题优先任务摘要（两处入口一致），再回落标题/角色名/通用文案", () => {
    expect(childSessionPanelLabel({ role: "explorer", task: "分析委派链路" }, "子代理会话")).toBe("分析委派链路");
    expect(childSessionPanelLabel({ role: "explorer", title: "分析子代理链路" }, "子代理会话")).toBe("分析子代理链路");
    expect(childSessionPanelLabel({ role: "explorer" }, "子代理会话")).toBe("explorer");
    expect(childSessionPanelLabel({ role: "  " }, "子代理会话")).toBe("子代理会话");
    expect(childSessionPanelLabel({ role: "explorer", task: "x".repeat(60) }, "子代理会话").length).toBeLessThanOrEqual(28);
  });
});
