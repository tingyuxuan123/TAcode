import type { ProviderModelBinding } from "./types";

/**
 * 内置「常用模型默认配置表」：
 * 勾选/添加模型时按模型 ID 自动补全上下文窗口、最大输出与能力，
 * 只填缺失字段，绝不覆盖用户已手动设置的值。
 *
 * 规则分两层：
 * - FAMILY_RULES：按厂商/型号家族匹配，先命中先生效（从具体到宽泛排列）；
 * - SUFFIX_RULES：按 ID 里的修饰词（vision / thinking / 1m …）叠加补充。
 * 数值是「合理的出厂默认」，用户可随后在模型设置里逐项修改。
 */

interface KnownModelRule {
  match: RegExp;
  defaults: Partial<ProviderModelBinding>;
}

// 注意：不要使用 /g 标志（lastIndex 会影响 String.match.test 的连续调用）。
const FAMILY_RULES: KnownModelRule[] = [
  // OpenAI
  { match: /^gpt-5/, defaults: { contextWindow: 400_000, maxTokens: 128_000, reasoning: true, supportsImages: true } },
  { match: /^o[1345](-|$)/, defaults: { contextWindow: 200_000, maxTokens: 100_000, reasoning: true } },
  { match: /^gpt-4\.1/, defaults: { contextWindow: 1_000_000, maxTokens: 32_768, supportsImages: true } },
  { match: /^gpt-4o/, defaults: { contextWindow: 128_000, maxTokens: 16_384, supportsImages: true } },
  { match: /^gpt-4/, defaults: { contextWindow: 128_000, maxTokens: 8_192 } },
  { match: /^gpt-3\.5/, defaults: { contextWindow: 16_384, maxTokens: 4_096 } },
  // Anthropic
  { match: /^claude-/, defaults: { contextWindow: 200_000, maxTokens: 64_000, reasoning: true, supportsImages: true } },
  // Google
  { match: /^gemini-/, defaults: { contextWindow: 1_000_000, maxTokens: 65_536, reasoning: true, supportsImages: true } },
  // DeepSeek（flash 走长上下文，与常用配置一致）
  { match: /deepseek.*flash/, defaults: { contextWindow: 1_000_000, maxTokens: 128_000 } },
  { match: /deepseek/, defaults: { contextWindow: 128_000, maxTokens: 8_192 } },
  // xAI / Moonshot / Zhipu / Alibaba / Meta / Mistral / 字节 / MiniMax / 百度 / 腾讯
  { match: /^grok-/, defaults: { contextWindow: 256_000, maxTokens: 32_768, reasoning: true, supportsImages: true } },
  { match: /^kimi/, defaults: { contextWindow: 262_144, maxTokens: 65_536 } },
  { match: /^glm/, defaults: { contextWindow: 200_000, maxTokens: 128_000 } },
  { match: /qwen/, defaults: { contextWindow: 131_072, maxTokens: 32_768 } },
  { match: /^llama-4/, defaults: { contextWindow: 131_072, maxTokens: 8_192, supportsImages: true } },
  { match: /^llama/, defaults: { contextWindow: 131_072, maxTokens: 8_192 } },
  { match: /^(mistral|mixtral)/, defaults: { contextWindow: 131_072, maxTokens: 8_192 } },
  { match: /^doubao/, defaults: { contextWindow: 256_000, maxTokens: 32_768 } },
  { match: /^(minimax|abab)/, defaults: { contextWindow: 1_000_000, maxTokens: 32_768 } },
  { match: /^ernie/, defaults: { contextWindow: 128_000, maxTokens: 8_192 } },
  { match: /^hunyuan/, defaults: { contextWindow: 256_000, maxTokens: 32_768 } },
];

const SUFFIX_RULES: KnownModelRule[] = [
  { match: /(vision|-vl(-|$)|omni|4o)/, defaults: { supportsImages: true } },
  { match: /(think|reason|-r1|-r\d)/, defaults: { reasoning: true } },
  { match: /(^|[^0-9])1m($|[^0-9a-z])|long-?context/, defaults: { contextWindow: 1_000_000 } },
];

/** 逐字段合并：base 已有的值优先，extra 只补缺失项。 */
function fillMissing(
  base: Partial<ProviderModelBinding>,
  extra: Partial<ProviderModelBinding>,
): Partial<ProviderModelBinding> {
  return {
    contextWindow: base.contextWindow ?? extra.contextWindow,
    maxTokens: base.maxTokens ?? extra.maxTokens,
    reasoning: base.reasoning ?? extra.reasoning,
    thinkingLevels: base.thinkingLevels ?? extra.thinkingLevels,
    supportsImages: base.supportsImages ?? extra.supportsImages,
  };
}

/** 查常用模型默认配置；不在表内返回 undefined。 */
export function knownModelDefaults(modelId: string): Partial<ProviderModelBinding> | undefined {
  const id = modelId.toLowerCase();
  const family = FAMILY_RULES.find((rule) => rule.match.test(id));
  let merged: Partial<ProviderModelBinding> = family?.defaults ?? {};
  for (const rule of SUFFIX_RULES) {
    if (rule.match.test(id)) merged = fillMissing(merged, rule.defaults);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** 在绑定上补全缺失的默认值；用户已设置的值保持不变。 */
export function applyKnownDefaults(model: ProviderModelBinding): ProviderModelBinding {
  const known = knownModelDefaults(model.id);
  if (!known) return model;
  const merged: ProviderModelBinding = { ...model };
  if (merged.contextWindow === undefined && known.contextWindow !== undefined) merged.contextWindow = known.contextWindow;
  if (merged.maxTokens === undefined && known.maxTokens !== undefined) merged.maxTokens = known.maxTokens;
  if (merged.reasoning === undefined && known.reasoning !== undefined) merged.reasoning = known.reasoning;
  if (merged.supportsImages === undefined && known.supportsImages !== undefined) merged.supportsImages = known.supportsImages;
  if (merged.thinkingLevels === undefined && known.thinkingLevels !== undefined) merged.thinkingLevels = known.thinkingLevels;
  // 保存时 validateService 要求最大输出不超过上下文窗口。
  if (merged.contextWindow !== undefined && merged.maxTokens !== undefined && merged.maxTokens > merged.contextWindow) {
    merged.maxTokens = merged.contextWindow;
  }
  return merged;
}

/** 是否还缺基础限制（上下文窗口 / 最大输出），用于「填入默认配置」按钮的可用态。 */
export function needsDefaultsFill(model: ProviderModelBinding): boolean {
  return model.contextWindow === undefined || model.maxTokens === undefined;
}
