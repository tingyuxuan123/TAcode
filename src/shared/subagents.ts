/**
 * 子代理（Subagent / delegate）定义模型：共享给运行时、主进程与渲染层。
 *
 * 定义即 Markdown 文档（YAML-ish frontmatter + body 作 system prompt），
 * 参考 PI-Desktop 的设计但按 TACode 的工具名与权限模式重写：
 * - 不声明 `tools` 就是只读；
 * - 写能力必须显式声明，且永不超过父会话的权限模式；
 * - 解析失败只降级为告警，不拖垮会话。
 */

import {
  DELEGATION_MAX_CONCURRENCY,
  DELEGATION_MAX_REPORT_CHARS,
} from "./delegation.js";

/** 子代理可以调用的 TACode 工具名。 */
export const SUBAGENT_ASSIGNABLE_TOOLS = [
  "read_file",
  "list_files",
  "search_files",
  "write_file",
  "edit_file",
  "apply_patch",
  "exec_command",
  "write_stdin",
] as const;

export type SubagentToolName = (typeof SUBAGENT_ASSIGNABLE_TOOLS)[number];

/** 会直接改写工作区文件的工具。 */
export const SUBAGENT_FILE_WRITE_TOOLS: readonly SubagentToolName[] = [
  "write_file",
  "edit_file",
  "apply_patch",
];

/**
 * 会改动工作区或进程的工具：声明了任意一个即视为「可写子代理」。
 * 注意它比 FILE_WRITE 更宽——`test-runner` 声明 `exec_command` 也在内，
 * 但它的提示词要求只跑命令、不改文件（见 `subagentEditsFiles`）。
 */
export const SUBAGENT_MUTATING_TOOLS: readonly SubagentToolName[] = [
  ...SUBAGENT_FILE_WRITE_TOOLS,
  "exec_command",
  "write_stdin",
];

/** 缺省工具集：只读探索。 */
export const DEFAULT_SUBAGENT_TOOLS: readonly SubagentToolName[] = [
  "read_file",
  "list_files",
  "search_files",
];

export const SUBAGENT_THINKING_LEVELS = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];

export const MAX_SUBAGENT_DEFINITIONS = 16;
/** 同一会话同时运行的子代理上限；与桥接路径共用同一常量。 */
export const MAX_SUBAGENT_CONCURRENCY = DELEGATION_MAX_CONCURRENCY;
export const MAX_SUBAGENT_MAX_TURNS = 60;
/** 回灌给父模型的报告上限（首尾各半截断）；与桥接落库共用同一常量。 */
export const MAX_SUBAGENT_REPORT_CHARS = DELEGATION_MAX_REPORT_CHARS;
/** 单个定义文档上限。 */
export const MAX_SUBAGENT_DOCUMENT_BYTES = 32 * 1024;
export const MAX_SUBAGENT_NAME_LENGTH = 40;

export type SubagentSource = "builtin" | "user";

/** 子代理自己的权限模式；`inherit` 跟随父会话。 */
export type SubagentPermission = "inherit" | "plan" | "ask" | "auto" | "full";

export interface SubagentModelPin {
  providerId: string;
  modelId: string;
}

export const SUBAGENT_EXEC_POLICIES = ["readonly"] as const;

export type SubagentExecPolicy = (typeof SUBAGENT_EXEC_POLICIES)[number];

export function isSubagentExecPolicy(value: string): value is SubagentExecPolicy {
  return (SUBAGENT_EXEC_POLICIES as readonly string[]).includes(value);
}

export interface SubagentDefinition {
  /** `delegate` 的 role/handle，slug 形式。 */
  name: string;
  /** 一句话说明何时该委派给它；父模型据此选择。 */
  description: string;
  /** 允许调用的工具；缺省只读。 */
  tools: SubagentToolName[];
  model?: SubagentModelPin;
  thinkingLevel?: SubagentThinkingLevel;
  permission?: SubagentPermission;
  /** 轮次硬上限；省略表示默认上限。 */
  maxTurns?: number;
  /**
   * 命令执行策略：`readonly` 表示这个子代理只能跑只读命令（见 `shared/readonly-commands.ts`）。
   * 让 explorer 这类只读角色能跑 `wc -l` / `git log`，同时挡住一切写盘与间接执行。
   */
  execPolicy?: SubagentExecPolicy;
  /** Markdown body，作为子代理 system prompt。 */
  prompt: string;
  source: SubagentSource;
  /** 用户文档的绝对路径。 */
  filePath?: string;
}

/** 设置页/IPC 用的视图模型：定义 + 是否启用。 */
export interface SubagentInfo extends SubagentDefinition {
  enabled: boolean;
}

export interface SubagentParseResult {
  definition?: SubagentDefinition;
  warnings: string[];
}

export function subagentCanMutate(definition: Pick<SubagentDefinition, "tools">): boolean {
  return definition.tools.some((tool) =>
    (SUBAGENT_MUTATING_TOOLS as readonly string[]).includes(tool),
  );
}

/** 声明了文件写入工具才算「能改文件」；只会跑命令的角色（test-runner）不算。 */
export function subagentEditsFiles(definition: Pick<SubagentDefinition, "tools">): boolean {
  return definition.tools.some((tool) =>
    (SUBAGENT_FILE_WRITE_TOOLS as readonly string[]).includes(tool),
  );
}

/** 两个名字的编辑距离（用于「你是不是想找 explorer?」这类纠错提示）。 */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_item, index) => index);
  for (let row = 1; row < rows; row += 1) {
    const current = [row];
    for (let col = 1; col < cols; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      current[col] = Math.min(
        (previous[col] ?? 0) + 1,
        (current[col - 1] ?? 0) + 1,
        (previous[col - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[cols - 1] ?? 0;
}

/** 在已知名字里找最接近的一个：归一化相同 → 包含关系 → 编辑距离 ≤ 2。 */
export function closestSubagentName(role: string, names: readonly string[]): string | undefined {
  const want = role.trim().toLowerCase();
  if (!want) return undefined;
  const exact = names.find((name) => name.toLowerCase() === want);
  if (exact) return exact;
  const contains = names.find((name) => {
    const candidate = name.toLowerCase();
    return candidate.includes(want) || want.includes(candidate);
  });
  if (contains) return contains;
  let best: { name: string; distance: number } | undefined;
  for (const name of names) {
    const distance = editDistance(want, name.toLowerCase());
    if (distance <= 2 && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}

/**
 * 未知子代理时的提示：附上可用清单 + 最接近的名字。
 * 模型看不到 `~/.tacode/subagents/` 目录，只回一句 "Unknown subagent" 会让它继续瞎猜角色名。
 */
export function unknownSubagentMessage(
  role: string,
  definitions: Array<{ name: string; description?: string }>,
): string {
  const suggestion = closestSubagentName(role, definitions.map((item) => item.name));
  const head = suggestion
    ? `Unknown subagent: ${role}. Did you mean "${suggestion}"?`
    : `Unknown subagent: ${role}.`;
  if (definitions.length === 0) {
    return `${head}\nNo subagents are enabled. Configure them in Settings → Subagents.`;
  }
  const list = definitions
    .map((item) => `- ${item.name}${item.description ? `: ${item.description}` : ""}`)
    .join("\n");
  return `${head}\nAvailable:\n${list}`;
}

/** 模型可见的子代理目录（注入系统上下文；与设置页/源码里的目录保持一致）。 */
export function subagentCatalogText(
  definitions: Array<Pick<SubagentDefinition, "name" | "description" | "tools" | "maxTurns" | "thinkingLevel">>,
): string {
  if (definitions.length === 0) return "";
  const lines = definitions.map((item) => {
    const tools = item.tools.join(", ") || "none";
    const turns = item.maxTurns ?? MAX_SUBAGENT_MAX_TURNS;
    const thinking = item.thinkingLevel ? `; thinking ${item.thinkingLevel}` : "";
    return `- ${item.name}: ${item.description} (tools: ${tools}; maxTurns ${turns}${thinking})`;
  });
  return [
    "Subagent catalog for the `delegate` tool (roles are fixed; subagents cannot delegate further):",
    ...lines,
    "Give each subagent one self-contained task, and ask for `path:line` evidence with short verbatim quotes.",
  ].join("\n");
}

export function normalizeSubagentName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SUBAGENT_NAME_LENGTH);
}

export function isSubagentThinkingLevel(value: string): value is SubagentThinkingLevel {
  return (SUBAGENT_THINKING_LEVELS as readonly string[]).includes(value);
}

/** 已退场的「最低」档：老角色文档里写了它仍按「低」理解，不再提示非法。 */
const LEGACY_SUBAGENT_THINKING_LEVELS: Record<string, SubagentThinkingLevel> = { minimal: "low" };

export function isSubagentPermission(value: string): value is SubagentPermission {
  return ["inherit", "plan", "ask", "auto", "full"].includes(value);
}

/** 单个 `key: value` frontmatter 行；值可以是裸标量、逗号列表或 `[a, b]`。 */
function parseScalarList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  return inner
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function splitFrontmatter(text: string): { frontmatter: string; body: string } | undefined {
  const normalized = text.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return undefined;
  return {
    frontmatter: normalized.slice(4, end),
    body: normalized.slice(end + 4).replace(/^\n/, ""),
  };
}

/**
 * 解析一份子代理文档。frontmatter 键名宽松匹配（大小写、下划线、短横线等价）；
 * 非法值只告警并忽略；`description` 与 body 缺失才算失败。
 */
export function parseSubagentDocument(input: {
  text: string;
  /** 文件名 stem，frontmatter 未给 name 时回退。 */
  fallbackName?: string;
  source: SubagentSource;
  filePath?: string;
}): SubagentParseResult {
  const warnings: string[] = [];
  const split = splitFrontmatter(input.text);
  const fields = new Map<string, string>();
  if (split) {
    for (const line of split.frontmatter.split("\n")) {
      const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
      if (!match?.[1]) continue;
      fields.set(match[1].toLocaleLowerCase("en-US").replaceAll("-", "").replaceAll("_", ""), match[2] ?? "");
    }
  } else {
    warnings.push("缺少 frontmatter，已按只读默认值解析。");
  }
  const field = (name: string): string | undefined => {
    const value = fields.get(name);
    return value === undefined ? undefined : value.trim().replace(/^["']|["']$/g, "");
  };

  const rawName = field("name") ?? input.fallbackName ?? "";
  const name = normalizeSubagentName(rawName);
  if (!name) {
    return { warnings: [...warnings, "子代理名称无效（需要字母/数字/短横线）。"] };
  }

  const description = field("description") ?? "";
  if (!description) {
    return { warnings: [...warnings, `子代理 ${name} 缺少 description，父模型无法判断何时委派。`] };
  }

  const body = (split?.body ?? "").trim();
  if (!body) {
    return { warnings: [...warnings, `子代理 ${name} 缺少指令正文（body 即 system prompt）。`] };
  }

  const rawTools = fields.get("tools");
  let tools: SubagentToolName[];
  if (rawTools === undefined || !rawTools.trim()) {
    tools = [...DEFAULT_SUBAGENT_TOOLS];
  } else if (rawTools.trim() === "*") {
    tools = [...SUBAGENT_ASSIGNABLE_TOOLS];
  } else {
    const requested = parseScalarList(rawTools);
    const known = requested.filter((item): item is SubagentToolName =>
      (SUBAGENT_ASSIGNABLE_TOOLS as readonly string[]).includes(item),
    );
    const unknown = requested.filter((item) => !(SUBAGENT_ASSIGNABLE_TOOLS as readonly string[]).includes(item));
    if (unknown.length) warnings.push(`已忽略不可分配给子代理的工具：${unknown.join(", ")}。`);
    tools = known.length ? known : [...DEFAULT_SUBAGENT_TOOLS];
  }

  let model: SubagentModelPin | undefined;
  const rawModel = field("model");
  if (rawModel) {
    const [providerId, ...rest] = rawModel.split("/");
    const modelId = rest.join("/");
    if (!providerId?.trim() || !modelId.trim()) {
      warnings.push(`model 需要写成 provider/model，已忽略：${rawModel}`);
    } else {
      model = { providerId: providerId.trim(), modelId: modelId.trim() };
    }
  }

  let thinkingLevel: SubagentThinkingLevel | undefined;
  const rawThinking = field("thinkinglevel") ?? field("effort");
  if (rawThinking) {
    const normalized = LEGACY_SUBAGENT_THINKING_LEVELS[rawThinking] ?? rawThinking;
    if (isSubagentThinkingLevel(normalized)) thinkingLevel = normalized;
    else warnings.push(`thinkingLevel 非法，已忽略：${rawThinking}`);
  }

  let permission: SubagentPermission | undefined;
  const rawPermission = field("permission");
  if (rawPermission) {
    if (isSubagentPermission(rawPermission)) permission = rawPermission;
    else warnings.push(`permission 非法，已忽略：${rawPermission}`);
  }

  let maxTurns: number | undefined;
  const rawMaxTurns = field("maxturns");
  if (rawMaxTurns && rawMaxTurns !== "0" && rawMaxTurns.toLowerCase() !== "none") {
    const parsed = Number.parseInt(rawMaxTurns, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      warnings.push(`maxTurns 需要正整数，已忽略：${rawMaxTurns}`);
    } else {
      if (parsed > MAX_SUBAGENT_MAX_TURNS) {
        warnings.push(`maxTurns 超过上限 ${MAX_SUBAGENT_MAX_TURNS}，已收敛。`);
      }
      maxTurns = Math.min(parsed, MAX_SUBAGENT_MAX_TURNS);
    }
  }

  let execPolicy: SubagentExecPolicy | undefined;
  const rawExecPolicy = field("execpolicy");
  if (rawExecPolicy) {
    if (isSubagentExecPolicy(rawExecPolicy.toLowerCase())) execPolicy = rawExecPolicy.toLowerCase() as SubagentExecPolicy;
    else warnings.push(`execPolicy 非法，已忽略：${rawExecPolicy}（可用：${SUBAGENT_EXEC_POLICIES.join("/")}）`);
  }

  return {
    definition: {
      name,
      description,
      tools,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(permission ? { permission } : {}),
      ...(maxTurns ? { maxTurns } : {}),
      ...(execPolicy ? { execPolicy } : {}),
      prompt: body,
      source: input.source,
      ...(input.filePath ? { filePath: input.filePath } : {}),
    },
    warnings,
  };
}

/** 生成可写回磁盘的文档（设置页保存用）。 */
export function renderSubagentDocument(definition: SubagentDefinition): string {
  const lines = ["---", `name: ${definition.name}`, `description: ${definition.description}`];
  lines.push(`tools: [${definition.tools.join(", ")}]`);
  if (definition.model) lines.push(`model: ${definition.model.providerId}/${definition.model.modelId}`);
  if (definition.thinkingLevel) lines.push(`thinkingLevel: ${definition.thinkingLevel}`);
  if (definition.permission && definition.permission !== "inherit") lines.push(`permission: ${definition.permission}`);
  if (definition.maxTurns) lines.push(`maxTurns: ${definition.maxTurns}`);
  if (definition.execPolicy) lines.push(`execPolicy: ${definition.execPolicy}`);
  lines.push("---", "", definition.prompt.trim(), "");
  return lines.join("\n");
}

/** 用户定义按名覆盖内置定义，保持首次出现顺序。 */
export function mergeSubagentDefinitions(
  builtins: SubagentDefinition[],
  user: SubagentDefinition[],
): SubagentDefinition[] {
  const merged = new Map<string, SubagentDefinition>();
  for (const definition of [...builtins, ...user]) merged.set(definition.name, definition);
  return [...merged.values()].slice(0, MAX_SUBAGENT_DEFINITIONS);
}
