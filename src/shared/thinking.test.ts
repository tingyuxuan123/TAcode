import { describe, expect, it } from "vitest";
import { effortLabelKey, inferModelReasoning, levelsForModel, levelsFromThinkingMap, normalizeEffort, pickEffortOptions, pickThinkingOptions, reasoningLevelsAvailable } from "./thinking";
import { t } from "./i18n";

describe("thinking effort helpers", () => {
  it("exposes off on the slider only when supported, preserving every discrete tier", () => {
    expect(pickThinkingOptions(["max", "off", "high", "low", "xhigh", "low"]))
      .toEqual(["off", "low", "high", "xhigh", "max"]);
    expect(pickThinkingOptions(["low", "high", "max"])).toEqual(["low", "high", "max"]);
    expect(normalizeEffort("off", ["off", "low", "high"])).toBe("off");
    expect(normalizeEffort("off", ["low", "high"])).toBe("high");
    expect(normalizeEffort("max", ["off", "low"])).toBe("low");
    expect(levelsForModel("reasoner", [{ id: "reasoner", reasoning: true, thinkingLevels: ["off", "high"] }]))
      .toEqual(["off", "high"]);
    expect(t("zh", effortLabelKey("off"))).toBe("关闭");
  });

  it("keeps the four UI tiers when the model supports them", () => {
    expect(pickEffortOptions(["off", "low", "medium", "high", "xhigh"])).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("maps the top tier to max when xhigh is unavailable", () => {
    expect(pickEffortOptions(["low", "medium", "high", "max"])).toEqual([
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("keeps every configured tier distinct, including xhigh and max", () => {
    expect(pickEffortOptions(["max", "off", "high", "medium", "xhigh", "low", "max"]))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(normalizeEffort("max", ["low", "high", "xhigh", "max"])).toBe("max");
    expect(normalizeEffort("high", ["off"])).toBe("off");
  });

  it("retires the minimal tier while migrating stored selections to low", () => {
    expect(pickEffortOptions(["minimal", "low", "high"])).toEqual(["low", "high"]);
    expect(reasoningLevelsAvailable(["minimal"])).toBe(false);
    expect(normalizeEffort("minimal", ["minimal", "low", "high"])).toBe("low");
    expect(normalizeEffort("minimal", ["minimal", "high"])).toBe("high");
    expect(levelsForModel("x", [{ id: "x", reasoning: true, thinkingLevels: ["minimal", "max"] }])).toEqual(["max"]);
  });

  it.each(["zh", "en"] as const)("labels all tiers distinctly in %s", (locale) => {
    const labels = ["low", "medium", "high", "xhigh", "max"].map((level) => t(locale, effortLabelKey(level)));
    expect(new Set(labels).size).toBe(5);
  });

  it("uses explicit service levels instead of model-name heuristics", () => {
    const id = "deepseek-v4-flash-vision-exp";
    expect(levelsForModel(id, [{ id, reasoning: true, thinkingLevels: ["low", "medium", "high", "max"] }]))
      .toEqual(["low", "medium", "high", "max"]);
    expect(levelsForModel("deepseek-v4-flash", [{ id: "deepseek-v4-flash", reasoning: true, thinkingLevels: ["xhigh", "max"] }]))
      .toEqual(["xhigh", "max"]);
  });

  it("honors runtime maps and explicit disabled reasoning", () => {
    const id = "deepseek-v4-flash";
    const thinkingLevelMap = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: "max" };
    expect(levelsForModel(id, [{ id, reasoning: true, thinkingLevelMap }]))
      .toEqual(["low", "medium", "high", "max"]);
    expect(levelsForModel(id, [{ id, reasoning: false, thinkingLevels: ["max"] }])).toEqual(["off"]);
    expect(levelsForModel(id, [{ id, reasoning: true, thinkingLevels: [] }])).toEqual(["off"]);
  });

  it("hides the picker when only off is available", () => {
    expect(reasoningLevelsAvailable(["off"])).toBe(false);
  });

  it("falls back to medium when the stored level is unsupported", () => {
    expect(normalizeEffort("xhigh", ["low", "medium", "high"])).toBe("medium");
  });

  it("drops the top tier for flash models", () => {
    expect(levelsForModel("deepseek-v4-flash")).toEqual(["low", "medium", "high"]);
    expect(levelsForModel("deepseek-v4-pro")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("hides reasoning for plain chat models", () => {
    expect(levelsForModel("deepseek-chat")).toEqual(["off"]);
    expect(inferModelReasoning("deepseek-chat")).toBe(false);
  });

  it("hides reasoning for relay GPT models", () => {
    expect(levelsForModel("gpt-4o")).toEqual(["off"]);
    expect(levelsForModel("gpt-4o-mini")).toEqual(["off"]);
    expect(inferModelReasoning("gpt-4o")).toBe(false);
  });
});
