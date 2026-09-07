import { describe, expect, it } from "vitest";
import { effortLabelKey, inferModelReasoning, levelsForModel, levelsFromThinkingMap, normalizeEffort, pickEffortOptions, reasoningLevelsAvailable } from "./thinking";
import { t } from "./i18n";

describe("thinking effort helpers", () => {
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

  it("keeps every configured tier distinct, including minimal, xhigh and max", () => {
    expect(pickEffortOptions(["max", "off", "high", "minimal", "medium", "xhigh", "low", "max"]))
      .toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(reasoningLevelsAvailable(["minimal"])).toBe(true);
    expect(normalizeEffort("minimal", ["minimal", "high"])).toBe("minimal");
    expect(normalizeEffort("max", ["low", "high", "xhigh", "max"])).toBe("max");
    expect(normalizeEffort("high", ["off"])).toBe("off");
  });

  it.each(["zh", "en"] as const)("labels all tiers distinctly in %s", (locale) => {
    const labels = ["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => t(locale, effortLabelKey(level)));
    expect(new Set(labels).size).toBe(6);
  });

  it("uses explicit service levels instead of model-name heuristics", () => {
    const id = "deepseek-v4-flash-vision-exp";
    expect(levelsForModel(id, [{ id, reasoning: true, thinkingLevels: ["low", "medium", "high", "max"] }]))
      .toEqual(["low", "medium", "high", "max"]);
    expect(levelsForModel("deepseek-v4-flash", [{ id: "deepseek-v4-flash", reasoning: true, thinkingLevels: ["minimal", "max"] }]))
      .toEqual(["minimal", "max"]);
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
