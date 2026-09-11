import { describe, expect, it } from "vitest";
import { SERVICE_THINKING_LEVELS, serviceBaseUrl, serviceRuntimeConfig, serviceThinkingDispatch, serviceThinkingLevels, validateService } from "./provider-config";
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
  it("defaults Anthropic reasoning models to adaptive effort with verbatim levels", () => {
    const [configured] = serviceRuntimeConfig({ ...provider, apiStyle: "anthropic_messages", models: [{ id: "gateway", reasoning: true, thinkingLevels: ["low", "high", "max"] }] }).models;
    expect(configured).toMatchObject({ compat: { forceAdaptiveThinking: true },
      thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } });
    const [defaults] = serviceRuntimeConfig({ ...provider, apiStyle: "anthropic_messages", models: [{ id: "fresh", reasoning: true }] }).models;
    expect(defaults).toMatchObject({ compat: { forceAdaptiveThinking: true },
      thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } });
  });
  it("honors an explicit token-budget dispatch instead of adaptive effort", () => {
    const [budget] = serviceRuntimeConfig({ ...provider, apiStyle: "anthropic_messages", models: [{ id: "legacy-reasoner", reasoning: true, thinkingDispatch: "budget" }] }).models;
    expect(budget).not.toHaveProperty("compat");
    expect(budget.thinkingLevelMap).toMatchObject({ minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
    const [chat] = serviceRuntimeConfig({ ...provider, models: [{ id: "chat", reasoning: true, thinkingDispatch: "adaptive" }] }).models;
    expect((chat as { compat?: { forceAdaptiveThinking?: boolean } }).compat?.forceAdaptiveThinking).toBeUndefined();
  });
  it("only treats Anthropic reasoning models as candidates for adaptive effort", () => {
    const reasoning = { id: "m", reasoning: true };
    expect(serviceThinkingDispatch(reasoning, "anthropic_messages")).toBe("adaptive");
    expect(serviceThinkingDispatch({ ...reasoning, thinkingDispatch: "budget" }, "anthropic_messages")).toBe("budget");
    expect(serviceThinkingDispatch(reasoning, "chat_completions")).toBe("budget");
    expect(serviceThinkingDispatch({ id: "m", reasoning: false }, "anthropic_messages")).toBe("budget");
  });
  it("uses the same default level selection in settings and runtime", () => {
    for (const style of ["chat_completions", "responses", "anthropic_messages", "google_generative_ai"] as const) {
      const model = { id: "custom", reasoning: true };
      const runtime = serviceRuntimeConfig({ ...provider, apiStyle: style, models: [model] }).models[0];
      const levels = SERVICE_THINKING_LEVELS.filter((level) => runtime.thinkingLevelMap?.[level] != null);
      expect(levels).toEqual(serviceThinkingLevels(model));
      // 已退场的「最低」档必须显式置 null，否则 pi 会把它当成可用档位。
      expect(runtime.thinkingLevelMap).toMatchObject({ minimal: null });
    }
  });
  it("does not enable reasoning or adaptive mode from stale disabled-model levels", () => {
    const [model] = serviceRuntimeConfig({ ...provider, apiStyle: "anthropic_messages", models: [{ id: "plain", reasoning: false, thinkingLevels: ["max"] }] }).models;
    expect(model).not.toHaveProperty("compat");
    expect(model).not.toHaveProperty("thinkingLevelMap");
    const [empty] = serviceRuntimeConfig({ ...provider, models: [{ id: "empty", reasoning: true, thinkingLevels: [] }] }).models;
    expect(empty.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null, high: null, xhigh: null, max: null });
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
  it("migrates the retired minimal tier and rejects unknown levels", () => {
    expect(validateService({ ...provider, models: [{ id: "m", reasoning: true, thinkingLevels: ["minimal", "high"] }] }).models[0].thinkingLevels)
      .toEqual(["low", "high"]);
    expect(() => validateService({ ...provider, models: [{ id: "m", thinkingLevels: ["turbo"] }] })).toThrow("推理等级无效");
    expect(() => validateService({ ...provider, models: [{ id: "m", thinkingLevels: "low" as never }] })).toThrow("推理等级无效");
  });
  it("rejects an invalid thinking dispatch and keeps a valid one", () => {
    const models = [{ id: "m", reasoning: true, thinkingDispatch: "nope" as never }];
    expect(() => validateService({ ...provider, apiStyle: "anthropic_messages", models })).toThrow("思考下发方式无效");
    expect(validateService({ ...provider, apiStyle: "anthropic_messages", models: [{ id: "m", reasoning: true, thinkingDispatch: "budget" }] }).models[0].thinkingDispatch)
      .toBe("budget");
  });
});
