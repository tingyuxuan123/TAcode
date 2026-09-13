import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 子代理面板是实时直播：worker 的事件流（流式文本/工具行）由面板直接消费，
 * JSONL 只用于初始加载与终态对账。跟随逻辑本身有单测（use-follow-scroll.test.ts），
 * 这里钉住没人测得到的接线——视口与内容层必须是两个元素：容器高度由 flex 固定，
 * 只观察容器本身的话，内容变高时收不到 resize，面板就会像修复前那样
 * 「新内容一直堆在下面，视图停着不动」。
 */
const rendererDir = fileURLToPath(new URL("../", import.meta.url));

describe("child session panel follow scroll", () => {
  const panel = readFileSync(path.join(rendererDir, "browser", "child-session-panel.tsx"), "utf8");
  const css = readFileSync(path.join(rendererDir, "styles.css"), "utf8");

  it("把跟随滚动的视口/内容 ref 接到面板上", () => {
    expect(panel).toContain("useFollowScroll(scope, active)");
    expect(panel).toContain('className="child-session-body" ref={setViewport}');
    expect(panel).toContain('className="child-session-flow" ref={follow.contentRef}');
  });

  it("滚动容器与内容层是两套样式", () => {
    expect(css).toMatch(/\.child-session-body \{[\s\S]*?overflow: auto;[\s\S]*?\n\}/);
    expect(css).toMatch(/\.child-session-flow \{[\s\S]*?flex-direction: column;[\s\S]*?\n\}/);
    // 审批卡的 sticky 跟着内容层走（它已经不是滚动容器的直接子元素了）。
    expect(css).toContain(".child-session-flow > .approval {");
  });

  it("订阅委派的实时事件流并按 delegationId 路由", () => {
    expect(panel).toMatch(/window\.harness\.delegations/);
    expect(panel).toMatch(/api\?\.onAgentEvent/);
    expect(panel).toContain("payload.delegationId !== delegationId");
    expect(panel).toContain("push(payload.event)");
  });

  it("初次读盘返回前事件先排队，快照落定后按序补齐", () => {
    // 与主会话 snapshot+replay 的次序语义一致：先快照，后事件。
    expect(panel).toContain("pendingRef");
    expect(panel).toMatch(/buffered\.reduce\(\(current, event\) => applyAgentEvent\(current, event\), base\)/);
    // 运行期没有 2s 轮询：实时性由事件流保证，读盘只剩初始加载与终态对账。
    expect(panel).not.toMatch(/setInterval|POLL_MS/);
  });
});
