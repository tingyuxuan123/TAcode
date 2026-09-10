import { describe, expect, it } from "vitest";
import { applyKnownDefaults, knownModelDefaults, needsDefaultsFill } from "./model-defaults";

describe("knownModelDefaults", () => {
  it("命中常用家族并叠加后缀规则", () => {
    expect(knownModelDefaults("deepseek-v4-flash-vision-exp")).toEqual({
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      supportsImages: true,
    });
    expect(knownModelDefaults("gemini-3.5-flash")).toEqual({
      contextWindow: 1_000_000,
      maxTokens: 65_536,
      reasoning: true,
      supportsImages: true,
    });
    expect(knownModelDefaults("gpt-5.6-terra")).toEqual({
      contextWindow: 400_000,
      maxTokens: 128_000,
      reasoning: true,
      supportsImages: true,
    });
    expect(knownModelDefaults("claude-sonnet-4-5")).toEqual({
      contextWindow: 200_000,
      maxTokens: 64_000,
      reasoning: true,
      supportsImages: true,
    });
  });

  it("未知模型返回 undefined", () => {
    expect(knownModelDefaults("my-model-v2")).toBeUndefined();
  });

  it("后缀规则可以对陌生家族单独生效", () => {
    expect(knownModelDefaults("my-vision-model")).toEqual({ supportsImages: true });
    expect(knownModelDefaults("qwen3-235b-thinking")).toMatchObject({ reasoning: true });
    expect(knownModelDefaults("vendor-x-1m")).toMatchObject({ contextWindow: 1_000_000 });
  });

  it("大小写不敏感", () => {
    expect(knownModelDefaults("DeepSeek-V4-Flash")).toMatchObject({ contextWindow: 1_000_000 });
  });
});

describe("applyKnownDefaults", () => {
  it("只填缺失字段，不覆盖用户设置", () => {
    const filled = applyKnownDefaults({
      id: "deepseek-v4-flash-vision-exp",
      contextWindow: 500_000,
    });
    expect(filled.contextWindow).toBe(500_000);
    expect(filled.maxTokens).toBe(128_000);
    expect(filled.supportsImages).toBe(true);
  });

  it("最大输出不超过上下文窗口", () => {
    const filled = applyKnownDefaults({ id: "gpt-5-test", contextWindow: 64_000 });
    expect(filled.maxTokens).toBe(64_000);
  });

  it("未知模型原样返回", () => {
    const model = { id: "my-model-v2" };
    expect(applyKnownDefaults(model)).toBe(model);
  });
});

describe("needsDefaultsFill", () => {
  it("缺任一限制即视为需要填充", () => {
    expect(needsDefaultsFill({ id: "a" })).toBe(true);
    expect(needsDefaultsFill({ id: "a", contextWindow: 1000 })).toBe(true);
    expect(needsDefaultsFill({ id: "a", contextWindow: 1000, maxTokens: 100 })).toBe(false);
  });
});
