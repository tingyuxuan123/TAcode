/**
 * 子代理定义的发现与持久化（运行时/主进程共用）。
 *
 * 层次：内置定义（explorer / code-reviewer / test-runner / fixer）+ 用户文档
 * `~/.tacode/subagents/*.md`（按名覆盖内置）。启用状态单独存
 * `~/.tacode/subagents.json`，不写进 Markdown。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import {
  MAX_SUBAGENT_DEFINITIONS,
  MAX_SUBAGENT_DOCUMENT_BYTES,
  mergeSubagentDefinitions,
  normalizeSubagentName,
  parseSubagentDocument,
  renderSubagentDocument,
  type SubagentDefinition,
  type SubagentInfo,
} from "../shared/subagents.js";
import { getTacodeHome } from "./home.js";

export function getSubagentsDir(): string {
  return path.join(getTacodeHome(), "subagents");
}

export function getSubagentsStatePath(): string {
  return path.join(getTacodeHome(), "subagents.json");
}

export function subagentDocumentPath(name: string): string {
  return path.join(getSubagentsDir(), `${normalizeSubagentName(name)}.md`);
}

/**
 * 内置子代理：只读探索为主。
 * explorer / code-reviewer 只读；test-runner 只能跑命令（声明的
 * `exec_command`/`write_stdin` 让它算「可写子代理」，但提示词与职责都禁止改文件）；
 * 只有 fixer 能改文件。
 */
export const BUILTIN_SUBAGENTS: SubagentDefinition[] = [
  {
    name: "explorer",
    description:
      "只读定位、事实抽取与调用链分析；用于范围明确、可独立交付的代码问题。",
    // exec_command 只在只读白名单下开放（wc / git log / rg -c …），避免靠 read 截断反推行数。
    tools: ["read_file", "list_files", "search_files", "exec_command"],
    execPolicy: "readonly",
    thinkingLevel: "medium",
    maxTurns: 40,
    prompt: [
      "只读回答主代理指定的问题。事实抽取先查给定路径、符号或日志片段；只有证据不足时才扩大检索范围，不默认扫描全仓库。",
      "调用链问题从相关入口追踪到足以解释问题的边界，区分已验证的关系、推断和未覆盖分支，不绘制无关架构地图。",
      "遵循项目检索规则；项目已索引且工具可用时优先 CodeGraph，否则用 search_files、list_files、read_file 或允许的只读命令。不得为此绕过命令白名单。",
      "可用 exec_command 执行白名单内的只读命令，例如 wc、rg、git log；只报告实际得到的计数与输出。",
      "证据充分即停止。遇到事实冲突或范围不足，返回 partial 及具体证据缺口，交由主代理决定是否扩大调查。",
      "结论附关键 path:line、必要的短引文和限制；不提出无关重构，也不修改文件或外部数据。",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "code-reviewer",
    description:
      "独立只读审查指定变更的正确性、安全、并发与契约风险；不用于格式或拼写检查。",
    tools: ["read_file", "list_files", "search_files"],
    thinkingLevel: "high",
    maxTurns: 40,
    prompt: [
      "独立审查指定 diff、文件及直接相关行为。基于实际证据判断，不迎合主代理的预设结论，也不自动扩成全项目审查。",
      "优先报告可行动的正确性、安全、并发和跨模块契约问题。每项给出触发条件、影响、精确位置与关键证据，按重要性排序。",
      "阅读过代码不代表问题已复现；明确区分代码事实、推断的失败路径和未执行的验证。缺少 diff 或必要上下文时说明覆盖限制。",
      "不为凑数量制造发现，不给无关重构或风格建议；没有发现时明确说明检查范围与限制。",
      "完成指定范围即返回。发现阻塞或足以改变主代理决策的重大反证时，及时返回现有证据。不得修改文件或外部数据。",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "test-runner",
    description:
      "执行指定范围的本地验证，归纳结果与失败证据；适合主代理能同时处理其他工作的检查。",
    tools: ["read_file", "list_files", "search_files", "exec_command", "write_stdin"],
    thinkingLevel: "low",
    maxTurns: 30,
    prompt: [
      "执行主代理指定的验证目标和命令，先确认工作目录、环境与必要前提。只运行已授权、范围明确的本地检查；不能仅凭测试名称假定它没有生产访问。",
      "不修改业务代码、测试断言或依赖配置来让检查通过。允许授权检查产生常规临时产物，但不得覆盖他人修改或变更外部数据。",
      "必要检查通过后停止。仅在本次出现具体失败或未解决风险时增加相关检查；不自行跑全量套件，不无故重复已通过检查。",
      "报告实际命令、退出结果、通过/失败数量及关键错误输出；失败时区分复现证据与推测，无法判定是否为本次变更引入时如实说明。",
      "遇到前提缺失或关键失败，及时返回结果与未覆盖范围，由主代理决定修复或后续验证。",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "fixer",
    description:
      "按明确文件清单和转换规则执行机械修改；设计、复杂实现及语义重构交回主代理。",
    tools: [
      "read_file",
      "list_files",
      "search_files",
      "write_file",
      "edit_file",
      "apply_patch",
      "exec_command",
      "write_stdin",
    ],
    thinkingLevel: "medium",
    maxTurns: 60,
    prompt: [
      "仅修改主代理明确分配的文件，严格遵循转换规则、排除范围与验收条件；缺少任何关键规则时返回具体缺口，不自行设计。",
      "你不是唯一协作者。修改前了解目标文件已有变更，保留他人成果并适应并行变更，不回滚或覆盖他人的修改。",
      "优先用 apply_patch 做定点修改；只有范围明确且命中项已核对时才批量替换。跨项目语义重命名、公共接口变更和复杂实现交回主代理。",
      "遇到歧义、意外命中或范围扩大，停止相关修改并返回 partial 或 blocked 及已完成内容，等待主代理重新分配。",
      "只做与本次机械修改直接对应的最小验证。报告修改文件、实际转换、验证命令与结果，以及剩余限制。",
    ].join("\n"),
    source: "builtin",
  },
];

interface SubagentState {
  disabled: string[];
}

async function readState(): Promise<SubagentState> {
  try {
    const raw = await fsp.readFile(getSubagentsStatePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { disabled?: unknown }).disabled)) {
      return {
        disabled: (parsed as { disabled: unknown[] }).disabled
          .filter((item): item is string => typeof item === "string")
          .map((item) => normalizeSubagentName(item))
          .filter(Boolean),
      };
    }
  } catch {
    // 缺失或损坏都按“全部启用”处理。
  }
  return { disabled: [] };
}

async function writeState(state: SubagentState): Promise<void> {
  const file = getSubagentsStatePath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fsp.rename(tmp, file);
}

/** 读取全部用户文档；坏文档只产生告警。 */
export async function loadUserSubagents(): Promise<{
  definitions: SubagentDefinition[];
  warnings: string[];
}> {
  const dir = getSubagentsDir();
  const warnings: string[] = [];
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { definitions: [], warnings };
  }
  const definitions: SubagentDefinition[] = [];
  for (const entry of entries.filter((item) => item.endsWith(".md")).sort()) {
    const filePath = path.join(dir, entry);
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_SUBAGENT_DOCUMENT_BYTES) {
        warnings.push(`${entry}: 文档超过 ${MAX_SUBAGENT_DOCUMENT_BYTES} 字节，已跳过。`);
        continue;
      }
      const text = await fsp.readFile(filePath, "utf8");
      const parsed = parseSubagentDocument({
        text,
        fallbackName: entry.replace(/\.md$/i, ""),
        source: "user",
        filePath,
      });
      for (const warning of parsed.warnings) warnings.push(`${entry}: ${warning}`);
      if (parsed.definition) definitions.push(parsed.definition);
    } catch (error) {
      warnings.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { definitions, warnings };
}

/** 合并内置 + 用户定义并应用启用状态。 */
export async function loadSubagents(): Promise<{
  subagents: SubagentInfo[];
  warnings: string[];
}> {
  const { definitions, warnings } = await loadUserSubagents();
  const state = await readState();
  const merged = mergeSubagentDefinitions(BUILTIN_SUBAGENTS, definitions);
  return {
    subagents: merged.map((definition) => ({
      ...definition,
      enabled: !state.disabled.includes(definition.name),
    })),
    warnings: [
      ...warnings,
      ...(merged.length >= MAX_SUBAGENT_DEFINITIONS
        ? [`子代理数量已达上限 ${MAX_SUBAGENT_DEFINITIONS}，更多定义会被忽略。`]
        : []),
    ],
  };
}

/** 只取启用的定义，供 `delegate` 工具构建目录。 */
export async function loadEnabledSubagents(): Promise<SubagentDefinition[]> {
  const { subagents } = await loadSubagents();
  return subagents.filter((item) => item.enabled);
}

export async function readUserSubagent(name: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(subagentDocumentPath(name), "utf8");
  } catch {
    return undefined;
  }
}

/** 保存用户文档；先用解析器校验，失败直接抛错（设置页需要明确反馈）。 */
export async function saveUserSubagent(text: string): Promise<SubagentDefinition> {
  const parsed = parseSubagentDocument({ text, source: "user" });
  if (!parsed.definition) {
    throw new Error(parsed.warnings.join(" ") || "子代理定义无效。");
  }
  if (text.length > MAX_SUBAGENT_DOCUMENT_BYTES) {
    throw new Error(`子代理文档不能超过 ${MAX_SUBAGENT_DOCUMENT_BYTES} 字节。`);
  }
  const definition = parsed.definition;
  await fsp.mkdir(getSubagentsDir(), { recursive: true });
  await fsp.writeFile(subagentDocumentPath(definition.name), renderSubagentDocument(definition), "utf8");
  return definition;
}

export async function deleteUserSubagent(name: string): Promise<boolean> {
  const normalized = normalizeSubagentName(name);
  if (!normalized) return false;
  try {
    await fsp.rm(subagentDocumentPath(normalized));
    return true;
  } catch {
    return false;
  }
}

export async function setSubagentEnabled(name: string, enabled: boolean): Promise<boolean> {
  const normalized = normalizeSubagentName(name);
  if (!normalized) return false;
  const { subagents } = await loadSubagents();
  if (!subagents.some((item) => item.name === normalized)) return false;
  const state = await readState();
  const disabled = new Set(state.disabled);
  if (enabled) disabled.delete(normalized);
  else disabled.add(normalized);
  await writeState({ disabled: [...disabled] });
  return true;
}
