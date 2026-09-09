/**
 * 把 DeepSeek 注册成 Pi 的模型供应商。
 *
 * Pi 不认识 TACode 的 deepseek provider 配置，因此由运行时按 `--base-url` /
 * `--transport` / `--max-tokens` 动态注册模型目录与思考等级映射。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEEPSEEK_CONTEXT_WINDOW, isOfficialDeepSeekBaseUrl, resolveMaxTokens } from "../settings.js";
import { defaultModelForProvider } from "../providers.js";
import type { TacodeRuntimeOptions } from "../options.js";

interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface DeepSeekModel {
  id: string;
  name: string;
  cost: ModelCost;
}

export function modelSupportsVision(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  if (!id) return false;
  if (/deepseek/.test(id)) return /vision/.test(id);
  if (/(?:^|[-_/.])(vision|vl|4v)(?:$|[-_/.])/.test(id)) return true;
  if (/gpt-4o|gpt-4\.1|gpt-5|chatgpt-4o|o[1-9].*vision|\bomni\b/.test(id)) return true;
  if (/claude-3|claude-4|claude-sonnet|claude-opus|claude-haiku/.test(id)) return true;
  if (/gemini|qwen-vl|qwen2\.5-vl|glm-4v|llava|pixtral|mistral-small.*vision/.test(id)) return true;
  return false;
}

export function registerDeepSeekProvider(pi: ExtensionAPI, options: TacodeRuntimeOptions): void {
  if (options.providerId !== "deepseek") return;
  const api = options.transport === "responses" ? "openai-responses" : "openai-completions";
  const models: DeepSeekModel[] = [
    {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    },
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      cost: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
    },
    {
      id: "deepseek-v4-flash-vision-exp",
      name: "DeepSeek V4 Flash Vision Exp",
      cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    },
  ];
  if (!models.some((model) => model.id === options.modelId)) {
    const defaultCost = models.find((model) => model.id === defaultModelForProvider("deepseek"))?.cost;
    models.push({
      id: options.modelId,
      name: options.modelId,
      cost: defaultCost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
  for (const id of options.extraModelIds) {
    if (models.some((model) => model.id === id)) continue;
    const defaultCost = models.find((model) => model.id === defaultModelForProvider("deepseek"))?.cost;
    models.push({
      id,
      name: id,
      cost: defaultCost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
  pi.registerProvider("deepseek", {
    name: "DeepSeek",
    baseUrl: options.baseUrl,
    apiKey: "$DEEPSEEK_API_KEY",
    api,
    authHeader: true,
    models: models.map((model) => {
      const reasoning = inferDeepSeekReasoning(model.id);
      const thinkingLevelMap = deepSeekThinkingLevelMap(model.id);
      const native = isDeepSeekNativeModel(model.id);
      return {
        id: model.id,
        name: model.name,
        api,
        reasoning,
        input: modelSupportsVision(model.id) ? (["text", "image"] as const) : (["text"] as const),
        cost: model.cost,
        contextWindow: DEEPSEEK_CONTEXT_WINDOW,
        maxTokens: resolveMaxTokens(options.baseUrl, options.maxTokens),
        ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        compat:
          options.transport === "responses"
            ? {
                supportsDeveloperRole: true,
                supportsLongCacheRetention: false,
                supportsStrictMode: false,
                supportsOpenAIGrammarTools: true,
                sessionAffinityFormat: "openai-nosession",
              }
            : {
                supportsStore: false,
                supportsDeveloperRole: false,
                ...(reasoning && native
                  ? {
                      requiresReasoningContentOnAssistantMessages: true,
                      // 必须显式指定 openai：provider id "deepseek" 会自动推断 thinkingFormat。
                      thinkingFormat: isOfficialDeepSeekBaseUrl(options.baseUrl) ? "deepseek" : "openai",
                    }
                  : {}),
              },
      };
    }),
  });
}

function inferDeepSeekReasoning(modelId: string): boolean {
  const id = modelId.toLowerCase();
  if (!/deepseek|reasoner|\br1\b|v4-flash|v4-pro/.test(id)) return false;
  if (/deepseek-chat|deepseek-coder/.test(id)) return false;
  if (/(?:^|[-_])(chat|coder|lite|distill|embed|vision|ocr|instruct)(?:$|[-_])/.test(id)) {
    return false;
  }
  return true;
}

function isDeepSeekNativeModel(modelId: string): boolean {
  return /deepseek|reasoner|\br1\b|v4-flash|v4-pro/.test(modelId.toLowerCase());
}

function deepSeekThinkingLevelMap(modelId: string): Record<string, string | null> | undefined {
  if (!inferDeepSeekReasoning(modelId)) return undefined;
  const id = modelId.toLowerCase();
  const base: Record<string, string | null> = {
    off: null,
    minimal: null,
    low: "low",
    medium: "high",
    high: "high",
  };
  if (/flash/.test(id) && !/pro/.test(id)) return { ...base, xhigh: null, max: null };
  return { ...base, xhigh: "high", max: "max" };
}
