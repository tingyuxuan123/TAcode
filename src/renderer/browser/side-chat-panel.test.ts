import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 侧边聊天同样是流式直播（回合不断追加），视图必须自己跟着最新走。
 * 这里钉住没人测得到的接线，以及一个前提：`.side-chat-body` 必须仍然是那个
 * `overflow: auto` 的滚动容器——视口与内容层是两个元素，容器固定高度、内容层负责报告高度变化。
 */
const rendererDir = fileURLToPath(new URL("../", import.meta.url));

describe("side chat panel follow scroll", () => {
  const panel = readFileSync(path.join(rendererDir, "browser", "side-chat-panel.tsx"), "utf8");
  const css = readFileSync(path.join(rendererDir, "styles.css"), "utf8");

  it("把跟随滚动的视口/内容 ref 接到面板上", () => {
    expect(panel).toMatch(/useFollowScroll\(`side-chat:\$\{sourceSession \?\? "session"\}:\$\{ordinal\}`\)/);
    expect(panel).toContain('className="side-chat-body" ref={follow.viewportRef}');
    expect(panel).toContain('className="side-chat-flow" ref={follow.contentRef}');
  });

  it("滚动容器仍然是 .side-chat-body", () => {
    expect(css).toMatch(/\.side-chat-body \{[\s\S]*?overflow: auto;[\s\S]*?\n\}/);
  });
});
