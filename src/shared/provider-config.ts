import type { ProviderModelBinding, ProviderRecord } from "./types";
import type { CatalogApiStyle } from "./provider-presets";

export const SUPPORTED_SERVICE_STYLES: CatalogApiStyle[] = [
  "chat_completions", "responses", "anthropic_messages", "google_generative_ai", "opencode_go",
];
export const SERVICE_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const THINKING_DISPATCHES = ["adaptive", "budget"] as const;
export type ThinkingDispatch = (typeof THINKING_DISPATCHES)[number];

/** 预算路径的档位到 token 数的名义映射，与 pi-ai 的 simple-options 预算表保持一致。 */
export const THINKING_BUDGET_TOKENS: Record<string, number> = {
  minimal: 1024, low: 2048, medium: 8192, high: 16384,
};

/** 预算路径实际发出的 token 数：xhigh/max 会被 pi 收敛到 high。 */
export function serviceThinkingBudget(level: string): number {
  const clamped = level === "xhigh" || level === "max" ? "high" : level;
  return THINKING_BUDGET_TOKENS[clamped] ?? THINKING_BUDGET_TOKENS.medium;
}

/** 该模型实际的推理下发方式；显式选择优先于按推理等级的推断。 */
export function serviceThinkingDispatch(model: ProviderModelBinding, style: CatalogApiStyle): ThinkingDispatch {
  if (style !== "anthropic_messages" || !model.reasoning) return "budget";
  if (model.thinkingDispatch) return model.thinkingDispatch;
  // 只有声明了极高/最大等级的模型按自适应推断，与升级前行为一致。
  return model.thinkingLevels?.some((level) => level === "max" || level === "xhigh") ? "adaptive" : "budget";
}

export function serviceThinkingLevels(model: ProviderModelBinding, style: CatalogApiStyle): string[] {
  return model.thinkingLevels ?? (style === "anthropic_messages"
    ? ["minimal", "low", "medium", "high"]
    : SERVICE_THINKING_LEVELS);
}

export function serviceBaseUrl(value: string, style: CatalogApiStyle): string {
  const raw = value.trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("API URL 无效"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("API URL 必须是无凭据、查询参数和片段的 http(s) 地址");
  }
  let root = raw.replace(/\/(chat\/completions|responses|models)$/, "");
  if (style === "anthropic_messages") root = root.replace(/\/messages$/, "").replace(/\/v1$/, "");
  return root;
}

export function validateService(record: ProviderRecord): ProviderRecord {
  if (!record.name?.trim()) throw new Error("请填写服务名称");
  if (!SUPPORTED_SERVICE_STYLES.includes(record.apiStyle)) throw new Error("当前运行时不支持该接口格式，请选择受支持的格式");
  if (!Array.isArray(record.models) || !record.models.length) throw new Error("请至少添加一个模型");
  const ids = new Set<string>();
  const models = record.models.map((model): ProviderModelBinding => {
    const id = model.id?.trim();
    if (!id || ids.has(id)) throw new Error("模型 ID 不能为空或重复");
    ids.add(id);
    for (const n of [model.contextWindow, model.maxTokens]) {
      if (n !== undefined && (!Number.isSafeInteger(n) || n <= 0)) throw new Error("模型上下文和输出上限必须为正整数");
    }
    if (model.contextWindow && model.maxTokens && model.maxTokens > model.contextWindow) {
      throw new Error("最大输出不能超过上下文窗口");
    }
    if (model.thinkingLevels !== undefined && (!Array.isArray(model.thinkingLevels) || model.thinkingLevels.some((level) => !SERVICE_THINKING_LEVELS.includes(level)))) {
      throw new Error("推理等级无效");
    }
    if (model.thinkingDispatch !== undefined && !THINKING_DISPATCHES.includes(model.thinkingDispatch)) {
      throw new Error("推理下发方式无效");
    }
    return {
      id,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      ...(model.reasoning !== undefined ? { reasoning: Boolean(model.reasoning) } : {}),
      ...(model.supportsImages !== undefined ? { supportsImages: Boolean(model.supportsImages) } : {}),
      ...(model.thinkingLevels !== undefined ? { thinkingLevels: [...new Set(model.thinkingLevels)] } : {}),
      ...(model.thinkingDispatch !== undefined ? { thinkingDispatch: model.thinkingDispatch } : {}),
    };
  });
  return { ...record, name: record.name.trim(), baseUrl: serviceBaseUrl(record.baseUrl, record.apiStyle), models,
    defaultModelId: ids.has(record.defaultModelId ?? "") ? record.defaultModelId : models[0].id };
}

/** TACode's CLI only accepts its built-in provider IDs. Override the OpenAI slot
 * in this worker alone; never mutate the user's global models or credentials. */
export function serviceRuntimeConfig(provider: ProviderRecord) {
  const apis: Partial<Record<CatalogApiStyle, string>> = {
    chat_completions: "openai-completions",
    responses: "openai-responses",
    anthropic_messages: "anthropic-messages",
    google_generative_ai: "google-generative-ai",
    opencode_go: "openai-completions",
  };
  const api = apis[provider.apiStyle];
  if (!api) throw new Error("不支持的模型接口格式");
  return {
    name: provider.name, api, baseUrl: serviceBaseUrl(provider.baseUrl, provider.apiStyle),
    models: provider.models.map((model) => ({
      id: model.id, name: model.id, api,
      reasoning: model.reasoning ?? false,
      input: model.supportsImages ? ["text", "image"] : ["text"],
      contextWindow: model.contextWindow ?? 128_000,
      maxTokens: model.maxTokens ?? Math.min(8192, model.contextWindow ?? 128_000),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(model.reasoning ? { thinkingLevelMap: Object.fromEntries(SERVICE_THINKING_LEVELS.map((level) => [level,
        serviceThinkingLevels(model, provider.apiStyle).includes(level)
          ? (api === "anthropic-messages" && level === "minimal" ? "low" : level)
          : null,
      ])) } : {}),
      // 自适应 effort 与 token 预算二选一，由模型级开关决定（缺省按已勾选等级推断）。
      ...(api === "anthropic-messages" && model.reasoning && serviceThinkingDispatch(model, provider.apiStyle) === "adaptive"
        ? { compat: { forceAdaptiveThinking: true } } : {}),
      ...(api === "openai-completions" ? { compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false } } : {}),
    })),
  };
}
