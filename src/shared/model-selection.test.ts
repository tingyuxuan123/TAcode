import { describe, expect, it } from "vitest";
import { composerModelOptions, desktopProviderStatuses, filterModelOptions, modelOptionKey } from "./model-selection";
import type { ProviderRecord, ProviderStatus } from "./types";

const provider = (id: string, name: string, modelId = "shared-model"): ProviderRecord => ({
  id, name, vendorKey: "custom", baseUrl: "https://example.test/v1", apiStyle: "chat_completions",
  models: [{ id: modelId, reasoning: true, thinkingLevels: ["low", "high", "max"] }],
  isEnabled: true, createdAt: "", updatedAt: "version-1",
});

describe("composer provider/model selection", () => {
  it("projects every enabled service, retaining only one preferred service and its capabilities", () => {
    const statuses = desktopProviderStatuses([
      provider("a", "Aether"), provider("b", "Hub"), { ...provider("c", "Hidden"), isEnabled: false },
      { ...provider("d", "Empty"), models: [] },
    ], "b", "shared-model");
    expect(statuses.map((status) => status.serviceId)).toEqual(["a", "b"]);
    expect(statuses.map((status) => status.preferred)).toEqual([false, true]);
    expect(statuses[1]).toMatchObject({ serviceVersion: "version-1", configured: true, defaultModel: "shared-model" });
    expect(statuses[1].modelCapabilities?.[0].thinkingLevelMap?.max).toBe("max");
    expect(statuses[0]).not.toHaveProperty("apiKey");
  });

  it("keeps same-named models on different services separately selectable", () => {
    const statuses = desktopProviderStatuses([provider("a", "Aether"), provider("b", "Hub")], "a", "shared-model");
    const options = composerModelOptions(statuses, "shared-model", ["stale-model"]);
    expect(options).toHaveLength(2);
    expect(new Set(options.map((option) => option.value)).size).toBe(2);
    expect(options[1]).toMatchObject({ value: modelOptionKey("b", "shared-model"), serviceId: "b", modelId: "shared-model" });
    expect(options.some((option) => option.modelId === "stale-model")).toBe(false);
  });

  it("searches names and providers together without producing arbitrary model IDs", () => {
    const statuses = desktopProviderStatuses([provider("a", "Aether", "gpt-6-astra"), provider("b", "Hub", "deepseek-v4-flash")], "a", "gpt-6-astra");
    const options = composerModelOptions(statuses, "gpt-6-astra", []);
    expect(filterModelOptions(options, "  HUB flash  ").map((option) => option.serviceId)).toEqual(["b"]);
    expect(filterModelOptions(options, "unknown")).toEqual([]);
    expect(filterModelOptions(options, " ")).toEqual(options);
  });

  it("retains the legacy single-provider list without duplicate current models", () => {
    const accounts: ProviderStatus[] = [{ id: "deepseek", name: "DeepSeek", configured: true, defaultModel: "legacy" }];
    const options = composerModelOptions(accounts, "legacy", ["legacy", "other"]);
    expect(options.map((option) => option.modelId)).toEqual(["legacy", "other"]);
    expect(options[0].serviceId).toBeUndefined();
    expect(options[0].value).toBe(modelOptionKey(undefined, "legacy"));
  });

  it("does not collide when IDs contain punctuation", () => {
    expect(modelOptionKey("a:b", "c")).not.toBe(modelOptionKey("a", "b:c"));
  });
});
