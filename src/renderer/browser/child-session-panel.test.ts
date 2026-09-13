import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 子代理面板是只读直播：转录每 2s 追加一段，视图必须自己跟着最新走。
 * 跟随逻辑本身有单测（use-follow-scroll.test.ts），这里钉住没人测得到的接线——
 * 视口与内容层必须是两个元素：容器高度由 flex 固定，只观察容器本身的话，内容变高时
 * 收不到 resize，面板就会像修复前那样「新内容一直堆在下面，视图停着不动」。
 */
const rendererDir = fileURLToPath(new URL("../", import.meta.url));

describe("child session panel follow scroll", () => {
  const panel = readFileSync(path.join(rendererDir, "browser", "child-session-panel.tsx"), "utf8");
  const css = readFileSync(path.join(rendererDir, "styles.css"), "utf8");

  it("把跟随滚动的视口/内容 ref 接到面板上", () => {
    expect(panel).toMatch(/useFollowScroll\(`child-session:\$\{delegationId \?\? sessionPath\}`\)/);
    expect(panel).toContain('className="child-session-body" ref={follow.viewportRef}');
    expect(panel).toContain('className="child-session-flow" ref={follow.contentRef}');
  });

  it("滚动容器与内容层是两套样式", () => {
    expect(css).toMatch(/\.child-session-body \{[\s\S]*?overflow: auto;[\s\S]*?\n\}/);
    expect(css).toMatch(/\.child-session-flow \{[\s\S]*?flex-direction: column;[\s\S]*?\n\}/);
    // 审批卡的 sticky 跟着内容层走（它已经不是滚动容器的直接子元素了）。
    expect(css).toContain(".child-session-flow > .approval {");
  });
});
