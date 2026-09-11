/**
 * 子代理编辑表单的草稿模型：表单字段 ↔ 磁盘文档的映射与校验。
 *
 * 纯逻辑单独放 `.ts`，组件只负责渲染；`parseSubagentDocument` / `renderSubagentDocument`
 * 是同一份定义的另一个入口，改这里的字段语义时两边必须一起改。
 */

import {
  DEFAULT_SUBAGENT_TOOLS,
  MAX_SUBAGENT_DOCUMENT_BYTES,
  MAX_SUBAGENT_MAX_TURNS,
  SUBAGENT_THINKING_LEVELS,
  normalizeSubagentName,
  renderSubagentDocument,
  type SubagentExecPolicy,
  type SubagentInfo,
  type SubagentPermission,
  type SubagentThinkingLevel,
  type SubagentToolName,
} from "../shared/subagents";
import { serviceRuntimeConfig } from "../shared/provider-config";
import { levelsForModel, type ModelReasoningCapabilities } from "../shared/thinking";
import type { ProviderRecord } from "../shared/types";
import type { MessageKey } from "../shared/i18n";

/** 声明了这些工具才会出现「命令策略」字段（其余只读工具与命令无关）。 */
export const SUBAGENT_COMMAND_TOOLS: readonly SubagentToolName[] = ["exec_command", "write_stdin"];

/**
 * 表单草稿：字段与磁盘上的 frontmatter 一一对应。
 * `permission` / `execPolicy` 是 TACode 特有的字段，表单里显式编辑，避免保存时被丢掉。
 */
export interface SubagentDraft {
  name: string;
  description: string;
  tools: SubagentToolName[];
  /** `<provider>/<model>`，空串表示沿用会话模型。 */
  model: string;
  thinkingLevel: SubagentThinkingLevel | "";
  permission: SubagentPermission | "";
  /** 0 表示不限制（frontmatter 里省略 maxTurns）。 */
  maxTurns: number;
  execPolicy: SubagentExecPolicy | "";
  body: string;
}

export interface SubagentEditorState {
  draft: SubagentDraft;
  /** 编辑既有定义时的原名称与来源，用于改名后清理旧文件。 */
  original?: { name: string; source: SubagentInfo["source"] };
}

/**
 * 正文模板：body 就是子代理的全部 system prompt，所以写成「对它下达的指令」，
 * 并沿用内置角色（explorer / code-reviewer…）约定的报告骨架。
 */
export function subagentBodyTemplate(name: string): string {
  const title = normalizeSubagentName(name) || "this delegate";
  return `You are the ${title} subagent. Finish exactly the delegated task.

## What to do
Describe the job in the imperative: what to look at, in what order, when to stop.

## What to report back
The parent agent only sees your final message, not your steps.
Report with fixed sections: \`## 结论\` (answer first), \`## 证据\` (each item = path:line + 1-3 lines of verbatim text + label 已核实/推断/未确认), \`## 未确认\` (what you could not check).

## Limits
Anything you must not do.
`;
}

export function emptySubagentDraft(): SubagentDraft {
  return {
    name: "",
    description: "",
    tools: [...DEFAULT_SUBAGENT_TOOLS],
    model: "",
    thinkingLevel: "",
    permission: "",
    maxTurns: 0,
    execPolicy: "",
    body: "",
  };
}

export function subagentDraftFromInfo(info: SubagentInfo): SubagentDraft {
  return {
    name: info.name,
    description: info.description,
    tools: info.tools.length ? [...info.tools] : [...DEFAULT_SUBAGENT_TOOLS],
    model: info.model ? `${info.model.providerId}/${info.model.modelId}` : "",
    thinkingLevel: info.thinkingLevel ?? "",
    permission: info.permission ?? "",
    maxTurns: info.maxTurns ?? 0,
    execPolicy: info.execPolicy ?? "",
    body: info.prompt,
  };
}

/** 草稿 → 文档。description 收敛成单行，否则会写坏 frontmatter。 */
export function subagentDraftToDocument(draft: SubagentDraft): string {
  const model = draft.model.trim();
  const slash = model.indexOf("/");
  return renderSubagentDocument({
    name: normalizeSubagentName(draft.name),
    description: draft.description.replace(/\s+/g, " ").trim(),
    tools: [...draft.tools],
    ...(slash > 0
      ? { model: { providerId: model.slice(0, slash).trim(), modelId: model.slice(slash + 1).trim() } }
      : {}),
    ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
    ...(draft.permission ? { permission: draft.permission } : {}),
    ...(draft.maxTurns ? { maxTurns: draft.maxTurns } : {}),
    ...(draft.execPolicy ? { execPolicy: draft.execPolicy } : {}),
    prompt: draft.body.trim(),
    source: "user",
  });
}

export function subagentBodyBytes(body: string): number {
  return new TextEncoder().encode(body).length;
}

/* ------------------------------------------------------------------ *
 * 模型选择：可选模型来自用户在「AI 服务」里加的供应商，而不是手填字符串。
 * 值就是写进文档的 `model: <serviceId>/<modelId>`；主进程按服务 id 解析
 * 该服务的 baseUrl 与凭据，所以子代理可以跑在与当前会话不同的服务上。
 * ------------------------------------------------------------------ */

export interface SubagentModelOption {
  /** 写入文档的值：`<serviceId>/<modelId>`。 */
  value: string;
  serviceId: string;
  serviceName: string;
  modelId: string;
  /** 该模型支持的推理档位（按 AI 服务里的能力配置算出来）。 */
  thinkingLevels: string[];
}

/** 可用模型：按 AI 服务顺序展开，服务名用于分组显示。 */
export function subagentModelOptions(providers: readonly ProviderRecord[]): SubagentModelOption[] {
  return providers
    .filter((provider) => provider.isEnabled && provider.models.length > 0)
    .flatMap((provider) => {
      const catalog = serviceRuntimeConfig(provider).models;
      return provider.models.map((model) => ({
        value: `${provider.id}/${model.id}`,
        serviceId: provider.id,
        serviceName: provider.name,
        modelId: model.id,
        thinkingLevels: levelsForPinnedModel(model.id, catalog),
      }));
    });
}

/** 服务 id → 名称；把钉选还原成人能读的标签（列表徽标用）。 */
export function subagentServiceNames(providers: readonly ProviderRecord[]): Map<string, string> {
  return new Map(providers.map((provider) => [provider.id, provider.name]));
}

/** 按能力目录过滤出子代理能用的档位（保持规范顺序）。 */
function levelsForPinnedModel(modelId: string, catalog: ModelReasoningCapabilities[]): string[] {
  const levels = levelsForModel(modelId, catalog);
  return SUBAGENT_THINKING_LEVELS.filter((level) => levels.includes(level));
}

/**
 * 钉选模型支持哪些「推理强度」档位。
 *
 * 没钉模型（跟会话）或模型不在列表里（手写的旧定义）时不限制：那种情况由运行时按
 * 会话模型收敛，表单不替它猜。
 */
export function subagentThinkingLevelsFor(
  model: string,
  options: readonly SubagentModelOption[],
): string[] {
  if (!model.trim()) return [...SUBAGENT_THINKING_LEVELS];
  const option = options.find((item) => item.value === model);
  return option && option.thinkingLevels.length ? option.thinkingLevels : [...SUBAGENT_THINKING_LEVELS];
}

/**
 * 换模型时把不支持的档位收敛到有效值：“与会话一致”保持不变，其余削到不超过原值的最高档；
 * 都比原值高时取最低可用档。
 */
export function clampThinkingLevel(
  level: SubagentThinkingLevel | "",
  levels: readonly string[],
): SubagentThinkingLevel | "" {
  if (!level || levels.includes(level)) return level;
  const ordered = SUBAGENT_THINKING_LEVELS.filter((candidate) => levels.includes(candidate));
  if (!ordered.length) return "";
  const rank = SUBAGENT_THINKING_LEVELS.indexOf(level);
  const atOrBelow = ordered.filter((candidate) => SUBAGENT_THINKING_LEVELS.indexOf(candidate) <= rank);
  return atOrBelow[atOrBelow.length - 1] ?? ordered[0];
}

/** 第一个阻塞保存的问题；返回 i18n key，null 表示可以保存。 */
export function subagentDraftError(draft: SubagentDraft): MessageKey | null {
  if (!draft.name.trim()) return "subagents.errorName";
  if (!normalizeSubagentName(draft.name)) return "subagents.errorSlug";
  if (!draft.description.trim()) return "subagents.errorDescription";
  if (draft.tools.length === 0) return "subagents.errorTools";
  // `provider/model` 是主进程唯一能解析的形状；裸模型名没有 provider 可查，会被丢掉。
  if (draft.model.trim() && !/^[^/\s]+\/.+$/.test(draft.model.trim())) return "subagents.errorModel";
  if (!Number.isInteger(draft.maxTurns) || draft.maxTurns < 0 || draft.maxTurns > MAX_SUBAGENT_MAX_TURNS) {
    return "subagents.errorMaxTurns";
  }
  if (!draft.body.trim()) return "subagents.errorBody";
  if (subagentBodyBytes(draft.body) > MAX_SUBAGENT_DOCUMENT_BYTES) return "subagents.errorTooBig";
  return null;
}
