import type { MessageKey } from "./i18n";

export const DEFAULT_EFFORT = "medium";
export const EFFORT_STORAGE_KEY = "tether.effort";

export type ThinkingLevelMap = Partial<
  Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>
>;

export interface ModelReasoningCapabilities {
  id: string;
  reasoning?: boolean;
  thinkingLevels?: string[];
  thinkingLevelMap?: ThinkingLevelMap;
}

const EXTENDED_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const EFFORT_LABEL_KEYS: Record<string, MessageKey> = {
  off: "effort.off",
  minimal: "effort.minimal",
  low: "effort.low",
  medium: "effort.medium",
  high: "effort.high",
  xhigh: "effort.xhigh",
  max: "effort.max",
};

export function reasoningLevelsAvailable(levels: string[]): boolean {
  return pickEffortOptions(levels).length > 0;
}

/** Mirror pi-ai getSupportedThinkingLevels for UI previews before the agent syncs. */
export function levelsFromThinkingMap(map?: ThinkingLevelMap): string[] {
  if (!map) return ["low", "medium", "high", "max"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function inferModelReasoning(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (!/deepseek|reasoner|\br1\b|v4-flash|v4-pro/.test(id)) return false;
  if (/deepseek-chat|deepseek-coder/.test(id)) return false;
  if (/(?:^|[-_])(chat|coder|lite|distill|embed|vision|ocr|instruct)(?:$|[-_])/.test(id)) {
    return false;
  }
  return true;
}

export function thinkingMapForModelId(modelId: string): ThinkingLevelMap | undefined {
  if (!inferModelReasoning(modelId)) return undefined;
  const id = modelId.toLowerCase();
  const base: ThinkingLevelMap = {
    off: null,
    minimal: null,
    low: "low",
    medium: "high",
    high: "high",
  };
  if (/flash/.test(id) && !/pro/.test(id)) {
    return { ...base, xhigh: null, max: null };
  }
  return { ...base, xhigh: "high", max: "max" };
}

export function levelsForModel(
  modelId: string,
  catalog?: ModelReasoningCapabilities[],
): string[] {
  const entry = catalog?.find((item) => item.id === modelId);
  if (entry?.reasoning === false) return ["off"];
  if (entry?.thinkingLevels !== undefined) {
    const levels = pickThinkingOptions(entry.thinkingLevels);
    return levels.length ? levels : ["off"];
  }
  if (entry?.thinkingLevelMap) return levelsFromThinkingMap(entry.thinkingLevelMap);
  if (entry?.reasoning === true || inferModelReasoning(modelId)) {
    return levelsFromThinkingMap(thinkingMapForModelId(modelId));
  }
  return ["off"];
}

/** Keep configured tiers distinct and ordered; off is not a reasoning effort. */
export function pickEffortOptions(levels: string[]): string[] {
  const set = new Set(levels);
  return EXTENDED_THINKING_LEVELS.filter((level) => level !== "off" && set.has(level));
}

export function pickThinkingOptions(levels: string[]): string[] {
  const set = new Set(levels);
  return EXTENDED_THINKING_LEVELS.filter((level) => set.has(level));
}

export function effortLabelKey(level: string): MessageKey {
  return EFFORT_LABEL_KEYS[level] ?? "effort.medium";
}

export function normalizeEffort(value: string, levels: string[]): string {
  const options = pickThinkingOptions(levels);
  if (options.includes(value)) return value;
  if (options.includes(DEFAULT_EFFORT)) return DEFAULT_EFFORT;
  if (options.includes("high")) return "high";
  return options.find((level) => level !== "off") ?? "off";
}

export function readStoredEffort(): string {
  try {
    return localStorage.getItem(EFFORT_STORAGE_KEY) ?? DEFAULT_EFFORT;
  } catch {
    return DEFAULT_EFFORT;
  }
}

export function writeStoredEffort(level: string): void {
  try {
    localStorage.setItem(EFFORT_STORAGE_KEY, level);
  } catch {
    // Ignore private mode / quota failures.
  }
}
