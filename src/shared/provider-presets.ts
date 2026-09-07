/**
 * 提供商预设 —— 从 PI-Desktop 移植的命名端点预设列表。
 *
 * 每个预设包含 ID、名称、默认 Base URL、API 风格，供设置对话框快速选择。
 */

export const API_STYLES = [
  "chat_completions",
  "responses",
  "anthropic_messages",
  "google_generative_ai",
  "openai_codex_responses",
  "pi_messages",
  "opencode_go",
] as const;

export type CatalogApiStyle = (typeof API_STYLES)[number];

export type ProviderPreset = {
  id: string;
  vendorKey: string;
  name: string;
  baseUrl: string;
  apiStyle: CatalogApiStyle;
  labelKey: string;
  aliases?: readonly string[];
  zhipuCompat?: boolean;
};

export const NAMED_ENDPOINT_PRESETS: readonly ProviderPreset[] = [
  {
    id: "openai",
    vendorKey: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiStyle: "responses",
    labelKey: "settings.presetOpenai",
  },
  {
    id: "anthropic",
    vendorKey: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    apiStyle: "anthropic_messages",
    labelKey: "settings.presetAnthropic",
  },
  {
    id: "google",
    vendorKey: "google",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiStyle: "google_generative_ai",
    labelKey: "settings.presetGoogle",
    aliases: ["gemini"],
  },
  {
    id: "openrouter",
    vendorKey: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiStyle: "chat_completions",
    labelKey: "settings.presetOpenrouter",
  },
  {
    id: "groq",
    vendorKey: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiStyle: "chat_completions",
    labelKey: "settings.presetGroq",
  },
  {
    id: "xai",
    vendorKey: "xai",
    name: "xAI",
    baseUrl: "https://api.x.ai/v1",
    apiStyle: "chat_completions",
    labelKey: "settings.presetXai",
  },
  {
    id: "mistral",
    vendorKey: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiStyle: "chat_completions",
    labelKey: "settings.presetMistral",
  },
  {
    id: "togetherai",
    vendorKey: "togetherai",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    apiStyle: "chat_completions",
    labelKey: "settings.presetTogether",
    aliases: ["together"],
  },
  {
    id: "fireworks-ai",
    vendorKey: "fireworks-ai",
    name: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiStyle: "chat_completions",
    labelKey: "settings.presetFireworks",
    aliases: ["fireworks"],
  },
  {
    id: "opencode_go",
    vendorKey: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiStyle: "opencode_go",
    labelKey: "settings.presetOpenCodeGo",
  },
  {
    id: "zai",
    vendorKey: "zai",
    name: "Z.AI",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiStyle: "chat_completions",
    labelKey: "settings.presetZaiApi",
    zhipuCompat: true,
  },
  {
    id: "zai-coding-plan",
    vendorKey: "zai-coding-plan",
    name: "Z.AI Coding Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiStyle: "chat_completions",
    labelKey: "settings.presetZaiCodingPlan",
    zhipuCompat: true,
  },
  {
    id: "deepseek",
    vendorKey: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiStyle: "chat_completions",
    labelKey: "settings.presetDeepseek",
  },
  {
    id: "alibaba-cn",
    vendorKey: "alibaba-cn",
    name: "Alibaba (China)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiStyle: "chat_completions",
    labelKey: "settings.presetAlibabaCn",
    aliases: ["dashscope", "qwen"],
  },
  {
    id: "moonshotai-cn",
    vendorKey: "moonshotai-cn",
    name: "Moonshot AI (China)",
    baseUrl: "https://api.moonshot.cn/v1",
    apiStyle: "chat_completions",
    labelKey: "settings.presetMoonshotCn",
    aliases: ["moonshot"],
  },
  {
    id: "zhipuai",
    vendorKey: "zhipuai",
    name: "Zhipu AI",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiStyle: "chat_completions",
    labelKey: "settings.presetZhipuApi",
    aliases: ["zhipu", "bigmodel"],
    zhipuCompat: true,
  },
  {
    id: "zhipuai-coding-plan",
    vendorKey: "zhipuai-coding-plan",
    name: "Zhipu AI Coding Plan",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiStyle: "chat_completions",
    labelKey: "settings.presetZhipuCodingPlan",
    aliases: ["zai-coding-cn"],
    zhipuCompat: true,
  },
  {
    id: "siliconflow-cn",
    vendorKey: "siliconflow-cn",
    name: "SiliconFlow (China)",
    baseUrl: "https://api.siliconflow.cn/v1",
    apiStyle: "chat_completions",
    labelKey: "settings.presetSiliconflowCn",
  },
  {
    id: "volcengine",
    vendorKey: "volcengine",
    name: "Volcengine Ark",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiStyle: "chat_completions",
    labelKey: "settings.presetVolcengine",
    aliases: ["doubao", "ark"],
  },
  {
    id: "minimax-cn",
    vendorKey: "minimax-cn",
    name: "MiniMax",
    baseUrl: "https://api.minimaxi.com/anthropic/v1",
    apiStyle: "anthropic_messages",
    labelKey: "settings.presetMinimaxCn",
    aliases: ["minimax"],
  },
  {
    id: "xiaomi",
    vendorKey: "xiaomi",
    name: "Xiaomi",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiStyle: "chat_completions",
    labelKey: "settings.presetXiaomi",
    aliases: ["mimo", "xiaomimimo"],
  },
  {
    id: "kimi-for-coding",
    vendorKey: "kimi-for-coding",
    name: "Kimi For Coding",
    baseUrl: "https://api.kimi.com/coding/v1",
    apiStyle: "anthropic_messages",
    labelKey: "settings.presetKimiCoding",
    aliases: ["kimi-coding", "kimi"],
  },
];

/** 根据 baseUrl 匹配合适的预设。 */
export function matchPresetByUrl(url: string): ProviderPreset | undefined {
  const normalized = url.trim().replace(/\/+$/, "").toLowerCase();
  return NAMED_ENDPOINT_PRESETS.find((p) => {
    const presetUrl = p.baseUrl.toLowerCase().replace(/\/+$/, "");
    if (normalized === presetUrl) return true;
    // 允许额外路径（如 /v1 后缀）
    if (normalized.startsWith(presetUrl + "/")) return true;
    return false;
  });
}

/** 根据 vendorKey 或 id 匹配预设。 */
export function matchPreset(input: {
  vendorKey?: string;
  baseUrl?: string;
  apiStyle?: string;
}): ProviderPreset | undefined {
  if (input.baseUrl) {
    const byUrl = matchPresetByUrl(input.baseUrl);
    if (byUrl) return byUrl;
  }
  const key = (input.vendorKey ?? "").trim().toLowerCase();
  if (!key) return undefined;
  return NAMED_ENDPOINT_PRESETS.find(
    (p) => p.vendorKey === key || p.id === key || p.aliases?.includes(key),
  );
}

export const CUSTOM_SERVICE_ID = "custom";