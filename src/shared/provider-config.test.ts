import { describe, expect, it } from "vitest";
import { SERVICE_THINKING_LEVELS, serviceBaseUrl, serviceRuntimeConfig, serviceThinkingBudget, serviceThinkingDispatch, serviceThinkingLevels, validateService } from "./provider-config";
import type { ProviderRecord } from "./types";

const provider: ProviderRecord = { id: "test", name: "Test", vendorKey: "custom", apiStyle: "chat_completions", baseUrl: "https://example.test/v1", models: [{ id: "custom-model", maxTokens: 4096, contextWindow: 64000, reasoning: true, supportsImages: true, thinkingLevels: ["low", "high"] }], isEnabled: true, createdAt: "", updatedAt: "" };

describe("service runtime configuration", () => {
  it.each([
    ["chat_completions", "openai-completions"], ["responses", "openai-responses"],
    ["anthropic_messages", "anthropic-messages"], ["google_generative_ai", "google-generative-ai"], ["opencode_go", "openai-completions"],
  ] as const)("maps %s to %s without inferring from model names", (style, api) => {
    const config = serviceRuntimeConfig({ ...provider, apiStyle: style });
    expect(config.api).toBe(api);
    expect(config.models[0]).toMatchObject({ id: "custom-model", api, input: ["text", "image"], maxTokens: 4096, contextWindow: 64000,
      thinkingLevelMap: { low: "low", high: "high", medium: null } });
    expect(config).not.toHaveProperty("apiKey");
  });
  it("uses adaptive Anthropic effort only when higher tiers are explicitly configured", () => {
    const [model] = serviceRuntimeConfig({ ...provider, apiStyle: "anthropic_messages", models: [{ id: "deepseek-v4-flash-vision-exp", reasoning: true, thinkingLevels: ["minimal", "high", "max"] }] }).models;
    expect(model).toMatchObject({ compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { minimal: "low", high: "high", max: "max", xhigh: null } });
    const [budget] = serviceRuntimeConfig({ ...provider, apiStyle: "anthropic_messages", models: [{ id: "legacy-reasoner", reasoning: true }] }).models;
    expect(budget).not.toHaveProperty("compat");
    expect(budget.thinkingLevelMap).toMatchObject({ minimal: "low", low: "low", medium: "medium", high: "high", max: null, xhigh: null });
  });
  it("honors an explicit thinking dispatch instead of inferring it from the tiers", () => {
    const fourTiers = { id: "gateway-4", reasoning: true, thinkingLevels: ["minimal", "low", "medium", "high"] };
    const sixTiers = { id: "gateway-6", reasoning: true, thinkingLevels: [...SERVICE_THINKING_LEVELS] };
    expect(serviceThinkingDispatch(fourTiers, "anthropic_messages")).toBe("budget");
    expect(serviceThinkingDispatch(sixTiers, "anthropic_messages")).toBe("adaptive");
    expect(serviceThinkingDispatch({ ...fourTiers, thinkingDispatch: "adaptive" }, "anthropic_messages")).toBe("adaptive");
    expect(serviceThinkingDispatch({ ...sixTiers, thinkingDispatch: "budget" }, "anthropic_messages")).toBe("budget");
    expect(serviceThinkingDispatch({ ...sixTiers, reasoning: false, thinkingDispatch: "adaptive" }, "anthropic_messages")).toBe("budget");
    const [forcedAdaptive] = serviceRuntimeConfig({ ...provider, apiStyle: "anthropic_messages", models: [{ ...fourTiers, thinkingDispatch: "adaptive" }] }).models;
    expect(forcedAdaptive).toMatchObject({ compat: { forceAdaptiveThinking: true } });
    const [forcedBudget] = serviceRuntimeConfig({ ...provider, apiStyle: "anthropic_messages", models: [{ ...sixTiers, thinkingDispatch: "budget" }] }).models;
    expect(forcedBudget).not.toHaveProperty("compat");
    const [chat] = serviceRuntimeConfig({ ...provider, models: [{ ...sixTiers, thinkingDispatch: "adaptive" }] }).models;
    expect((chat as { compat?: { forceAdaptiveThinking?: boolean } }).compat?.forceAdaptiveThinking).toBeUndefined();
  });
  it("mirrors pi's budget table and clamps xhigh/max to high", () => {
    expect(SERVICE_THINKING_LEVELS.map(serviceThinkingBudget)).toEqual([1024, 2048, 8192, 16384, 16384, 16384]);
  });
  it("rejects an invalid thinking dispatch and keeps a valid one", () => {
    const models = [{ id: "m", reasoning: true, thinkingDispatch: "nope" as never }];
    expect(() => validateService({ ...provider, apiStyle: "anthropic_messages", models })).toThrow("推理下发方式无效");
    expect(validateService({ ...provider, apiStyle: "anthropic_messages", models: [{ id: "m", reasoning: true, thinkingDispatch: "adaptive" }] }).models[0].thinkingDispatch).toBe("adaptive");
  });
  it("uses the same default level selection in settings and runtime", () => {
    for (const style of ["chat_completions", "responses", "anthropic_messages", "google_generative_ai"] as const) {
      const model = { id: "custom", reasoning: true };
      const runtime = serviceRuntimeConfig({ ...provider, apiStyle: style, models: [model] }).models[0];
      const levels = SERVICE_THINKING_LEVELS.filter((level) => runtime.thinkingLevelMap?.[level] != null);
      expect(levels).toEqual(serviceThinkingLevels(model, style));
    }
  });
  it("does not enable reasoning or adaptive mode from stale disabled-model levels", () => {
    const [model] = serviceRuntimeConfig({ ...provider, apiStyle: "anthropic_messages", models: [{ id: "plain", reasoning: false, thinkingLevels: ["max"] }] }).models;
    expect(model).not.toHaveProperty("compat");
    expect(model).not.toHaveProperty("thinkingLevelMap");
    const [empty] = serviceRuntimeConfig({ ...provider, models: [{ id: "empty", reasoning: true, thinkingLevels: [] }] }).models;
    expect(Object.values(empty.thinkingLevelMap ?? {})).toEqual(SERVICE_THINKING_LEVELS.map(() => null));
  });
  it("normalizes full endpoint URLs for the selected protocol", () => {
    expect(serviceBaseUrl("https://a.test/v1/responses", "responses")).toBe("https://a.test/v1");
    expect(serviceBaseUrl("https://a.test/anthropic/v1/messages", "anthropic_messages")).toBe("https://a.test/anthropic");
    expect(serviceBaseUrl("https://a.test/v1beta", "google_generative_ai")).toBe("https://a.test/v1beta");
  });
  it("rejects unsupported login-based formats instead of silently using Chat Completions", () => {
    expect(() => validateService({ ...provider, apiStyle: "openai_codex_responses" })).toThrow("不支持");
  });
  it("preserves case-sensitive model IDs", () => {
    expect(validateService({ ...provider, models: [{ id: "A" }, { id: "a" }] }).models).toHaveLength(2);
  });
});
