/**
 * 子代理定义的发现与持久化（运行时/主进程共用）。
 *
 * 层次：内置定义（explorer / code-reviewer / test-runner / fixer）+ 用户文档
 * `~/.tether/subagents/*.md`（按名覆盖内置）。启用状态单独存
 * `~/.tether/subagents.json`，不写进 Markdown。
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

/** 内置子代理：只读探索为主，只有 fixer 可写。 */
export const BUILTIN_SUBAGENTS: SubagentDefinition[] = [
  {
    name: "explorer",
    description:
      "Read-only repository explorer. Use for broad codebase questions, locating implementations, and gathering context across many files.",
    tools: ["read_file", "list_files", "search_files"],
    thinkingLevel: "medium",
    maxTurns: 40,
    prompt: [
      "You are the explorer subagent. Answer exactly the question you were delegated.",
      "Search broadly first, then read only the files that matter. Prefer concrete evidence over speculation.",
      "Report findings as: the answer, the exact files and line numbers, and any open questions.",
      "Never claim to have changed or run anything: you only read.",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "code-reviewer",
    description:
      "Adversarial reviewer. Use after changes to hunt for defects, regressions, and missing tests in a specific diff or area.",
    tools: ["read_file", "list_files", "search_files"],
    thinkingLevel: "high",
    maxTurns: 40,
    prompt: [
      "You are the code-reviewer subagent. Review the delegated diff or area for defects only.",
      "Look for correctness bugs, broken edge cases, unsafe assumptions, and missing validation or tests.",
      "Report each finding as `path:line` plus one sentence explaining the failure mode, ordered by severity.",
      "Do not restate the code or praise it. If you find nothing, say so and list what you checked.",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "test-runner",
    description:
      "Runs focused checks (tests, typecheck, lint) and reports failures with exact output. Use to verify work without spending the main agent's context.",
    tools: ["read_file", "list_files", "search_files", "exec_command", "write_stdin"],
    thinkingLevel: "low",
    maxTurns: 30,
    prompt: [
      "You are the test-runner subagent. Run the checks you were asked to run, then report.",
      "Start with the narrowest command that can prove the change, then broaden only if asked.",
      "Report: pass/fail counts, each failure with its exact error text and file:line, and any command you could not run.",
      "Never edit files. If a test is failing because of an obvious one-line typo, report it, do not fix it.",
    ].join("\n"),
    source: "builtin",
  },
  {
    name: "fixer",
    description:
      "Write-capable implementation worker. Use for a bounded, well-specified change that you can verify afterwards.",
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
      "You are the fixer subagent. Implement exactly the delegated change; leave everything else untouched.",
      "Read before you write, keep the diff minimal, and follow the existing code style.",
      "Verify with a focused check (test or typecheck) before reporting.",
      "Report as: what you changed (paths), how you verified it, and anything you could not finish.",
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
