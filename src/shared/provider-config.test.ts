import { describe, expect, it } from "vitest";
import { serviceBaseUrl, serviceRuntimeConfig, validateService } from "./provider-config";
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
