import { describe, expect, it } from "vitest";
import { fallbackSessionTitle, MAX_SESSION_TITLE_CHARS, MAX_TITLE_INPUT_CHARS, normalizeGeneratedTitle, sessionTitleInput } from "./session-title";
import { visionAgentPrompt } from "./vision-api";

describe("session titles", () => {
  it("长首条消息的兜底标题保持单行且不切断 Unicode 字符", () => {
    const title = fallbackSessionTitle("  制作场景\n\n" + "🏯".repeat(100));
    expect(Array.from(title)).toHaveLength(MAX_SESSION_TITLE_CHARS);
    expect(title).toMatch(/^制作场景 🏯+…$/u);
    expect(fallbackSessionTitle("  修复登录\n失败 ")).toBe("修复登录 失败");
    expect(fallbackSessionTitle(" \n ")).toBe("");
  });

  it("仅把用户原话交给命名，不带图片工具指令或上传路径", () => {
    const prompt = visionAgentPrompt("总结这张界面图", ["/private/uploads/image.png"]);
    expect(sessionTitleInput(prompt)).toBe("总结这张界面图");
    expect(fallbackSessionTitle(prompt)).toBe("总结这张界面图");
    expect(Array.from(sessionTitleInput("🏯".repeat(8_000)))).toHaveLength(MAX_TITLE_INPUT_CHARS);
  });

  it("清理模型包装且保留有意义的技术名称", () => {
    expect(normalizeGeneratedTitle('标题：“Three.js 博丽神社场景”。')).toBe("Three.js 博丽神社场景");
    expect(normalizeGeneratedTitle("<think>内部推理</think>\n# 优化会话标题\n额外解释")).toBe("优化会话标题");
    expect(normalizeGeneratedTitle("```text\n精简标题\n```")).toBe("精简标题");
    expect(Array.from(normalizeGeneratedTitle("场景".repeat(50)))).toHaveLength(MAX_SESSION_TITLE_CHARS);
    expect(normalizeGeneratedTitle("\n")).toBe("");
  });
});
