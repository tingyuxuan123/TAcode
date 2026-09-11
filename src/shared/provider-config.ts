import type { ProviderModelBinding, ProviderRecord } from "./types";
import type { CatalogApiStyle } from "./provider-presets";

export const SUPPORTED_SERVICE_STYLES: CatalogApiStyle[] = [
  "chat_completions", "responses", "anthropic_messages", "google_generative_ai", "opencode_go",
];
/** 思考深度档位：与参考实现一致的五档。minimal 上游 API 不接受，已从界面退场。 */
export const SERVICE_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** pi 认识的完整档位集合；未勾选（含已退场的 minimal）要在 thinkingLevelMap 里显式置 null 才会消失。 */
const PI_THINKING_LEVELS = ["minimal", ...SERVICE_THINKING_LEVELS];

/** Anthropic 的两种思考下发方式：自适应 effort 或 token 预算。 */
export type ThinkingDispatch = "adaptive" | "budget";
export const SERVICE_THINKING_DISPATCHES: ThinkingDispatch[] = ["adaptive", "budget"];

/** 历史配置里残留的档位，读入时静默折算，不再出现在界面上。 */
const LEGACY_THINKING_LEVELS: Record<string, string> = { minimal: "low" };

export function serviceThinkingLevels(model: ProviderModelBinding): string[] {
  return model.thinkingLevels ?? SERVICE_THINKING_LEVELS;
}

/**
 * anthropic_messages 专属：reasoning 档位是走自适应 effort 还是 token 预算。
 * 缺省（含历史配置）一律自适应；只有模型显式选了 budget 才回落到预算下发。
 * 其它协议没有预算概念，返回值恒为 budget，调用方只在 anthropic 分支使用。
 */
export function serviceThinkingDispatch(model: ProviderModelBinding, style: CatalogApiStyle): ThinkingDispatch {
  if (style !== "anthropic_messages" || !model.reasoning) return "budget";
  return model.thinkingDispatch === "budget" ? "budget" : "adaptive";
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
    if (model.thinkingLevels !== undefined && !Array.isArray(model.thinkingLevels)) {
      throw new Error("推理等级无效");
    }
    const thinkingLevels = model.thinkingLevels === undefined
      ? undefined
      : [...new Set(model.thinkingLevels.map((level) => LEGACY_THINKING_LEVELS[level] ?? level))];
    if (thinkingLevels?.some((level) => !SERVICE_THINKING_LEVELS.includes(level))) {
      throw new Error("推理等级无效");
    }
    if (model.thinkingDispatch !== undefined && !SERVICE_THINKING_DISPATCHES.includes(model.thinkingDispatch)) {
      throw new Error("思考下发方式无效");
    }
    return {
      id,
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      ...(model.reasoning !== undefined ? { reasoning: Boolean(model.reasoning) } : {}),
      ...(model.supportsImages !== undefined ? { supportsImages: Boolean(model.supportsImages) } : {}),
      ...(thinkingLevels !== undefined ? { thinkingLevels } : {}),
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
    models: provider.models.map((model) => {
      const levels = serviceThinkingLevels(model);
      const adaptive = serviceThinkingDispatch(model, provider.apiStyle) === "adaptive";
      return {
        id: model.id, name: model.id, api,
        reasoning: model.reasoning ?? false,
        input: model.supportsImages ? ["text", "image"] : ["text"],
        contextWindow: model.contextWindow ?? 128_000,
        maxTokens: model.maxTokens ?? Math.min(8192, model.contextWindow ?? 128_000),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // 档位原样下发（参考实现同样不做改名与 token 换算）；未勾选档位与已退场的 minimal 置 null。
        ...(model.reasoning ? { thinkingLevelMap: Object.fromEntries(PI_THINKING_LEVELS.map((level) => [level,
          level !== "minimal" && levels.includes(level) ? level : null,
        ])) } : {}),
        // 自适应 effort 是缺省下发方式，只有模型显式选择 token 预算时才不发这个标记。
        ...(adaptive ? { compat: { forceAdaptiveThinking: true } } : {}),
        ...(api === "openai-completions" ? { compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false } } : {}),
      };
    }),
  };
}
