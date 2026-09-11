/**
 * 激活工具集的唯一权威（single writer）。
 *
 * 为什么需要这个模块（真实故障，会话 2026-09-11T07-13-26-347Z_01a08f50）：
 * `browser_*` / `vision` 这类扩展工具不在 worker 启动白名单里（`--tools`，见
 * `src/runtime/options.ts` 的 `defaultActiveTools`），只能由扩展自己
 * `setActiveTools([...getActiveTools(), ...本扩展工具])` 临时加进去；而权限模式变化时
 * runtime 又用 `setActiveTools(options.activeTools)` 整体替换。三处各自写同一个状态，
 * 谁最后执行谁赢 —— 结果是「生成中途切换权限」会把 browser_* 静默摘掉，同一回合内没有
 * 恢复点，模型随后撞 `Tool browser_navigate not found`（pi 在 currentContext.tools 里查不到）。
 *
 * 现在只有这里计算激活集：
 * - 基础工具 base：worker 启动时下发的 `--tools`；
 * - 扩展贡献 contributions：扩展注册的工具名 + 是否允许在 plan 模式保持激活；
 * - plan 模式：(base ∩ planAllowedToolNames) ∪ planAllowed 的贡献 ∪ {update_plan}；
 * - carryOver：进入 plan 之前额外激活、但既不在 base 也不在贡献里的工具（例如 `mcp__*`），
 *   离开 plan 后按原样恢复。
 *
 * 状态挂在 globalThis 上：runtime worker 与 `extensions/*` 是 tsup 的两组独立构建产物，
 * 同一个模块会在两边各内联一份，普通模块级单例并不共享。
 */

import type { PermissionMode } from "./types.js";

export interface ToolContribution {
  /** 该扩展贡献的工具名。 */
  names: readonly string[];
  /** 是否允许在 plan 模式下保持激活（默认 false：plan 模式只做只读探索）。 */
  planAllowed?: boolean;
}

export interface ToolSetPolicy {
  permission: PermissionMode;
  /** worker 启动时下发的 `--tools` 白名单。 */
  baseToolNames: readonly string[];
  /** plan 模式下允许保留的基础工具名。 */
  planAllowedToolNames: readonly string[];
}

export interface ToolSetDiff {
  added: string[];
  removed: string[];
}

interface ToolSetState {
  policy?: ToolSetPolicy;
  contributions: Map<string, ToolContribution>;
  carryOver: string[];
}

const STORE_KEY = Symbol.for("tacode.tool-set");

function store(): ToolSetState {
  const holder = globalThis as unknown as Record<symbol, ToolSetState | undefined>;
  holder[STORE_KEY] ??= { contributions: new Map(), carryOver: [] };
  return holder[STORE_KEY]!;
}

/** 仅供测试：清空策略、贡献与 carryOver。 */
export function resetToolSet(): void {
  const holder = globalThis as unknown as Record<symbol, ToolSetState | undefined>;
  delete holder[STORE_KEY];
}

export function setToolSetPolicy(policy: ToolSetPolicy): void {
  const state = store();
  state.policy = {
    permission: policy.permission,
    baseToolNames: [...policy.baseToolNames],
    planAllowedToolNames: [...policy.planAllowedToolNames],
  };
}

export function getToolSetPolicy(): ToolSetPolicy | undefined {
  return store().policy;
}

export function setToolContribution(owner: string, contribution: ToolContribution): void {
  store().contributions.set(owner, {
    names: [...contribution.names],
    ...(contribution.planAllowed ? { planAllowed: true } : {}),
  });
}

export function clearToolContribution(owner: string): void {
  store().contributions.delete(owner);
}

/** 本模块拥有并负责增删的名字：基础工具 + 扩展贡献。 */
export function ownedToolNames(): string[] {
  const policy = store().policy;
  return unique([...(policy?.baseToolNames ?? []), ...contributionNames()]);
}

/** 进入 plan 模式前记录「基础工具与扩展贡献之外」的激活工具，离开后恢复。 */
export function captureToolSetCarryOver(activeNames: readonly string[], baseToolNames: readonly string[]): void {
  const owned = new Set([...baseToolNames, ...contributionNames()]);
  store().carryOver = unique(activeNames.filter((name) => !owned.has(name)));
}

export function clearToolSetCarryOver(): void {
  store().carryOver = [];
}

export function contributionNames(planAllowedOnly = false): string[] {
  const names: string[] = [];
  for (const contribution of store().contributions.values()) {
    if (planAllowedOnly && !contribution.planAllowed) continue;
    names.push(...contribution.names);
  }
  return unique(names);
}

/** 计算当前应当激活的工具名；策略尚未配置时返回 undefined（不猜，避免把工具集算空）。 */
export function computeActiveToolNames(): string[] | undefined {
  const state = store();
  const policy = state.policy;
  if (!policy) return undefined;
  if (policy.permission === "plan") {
    const allowed = new Set(policy.planAllowedToolNames);
    return unique([
      ...policy.baseToolNames.filter((name) => allowed.has(name)),
      ...contributionNames(true),
      "update_plan",
    ]);
  }
  return unique([...policy.baseToolNames, ...contributionNames(), ...state.carryOver]);
}

export function toolSetDiff(before: readonly string[], after: readonly string[]): ToolSetDiff {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: after.filter((name) => !beforeSet.has(name)),
    removed: before.filter((name) => !afterSet.has(name)),
  };
}

/**
 * 幂等应用激活集：只有真的变化才 `setActiveTools`（那会重建系统提示），
 * 并在变化时打一行 diff 日志，便于事后对齐（worker stderr 会进 tacode.log / 失败详情）。
 *
 * 语义是严格的：激活集只由「基础工具 + 扩展贡献 + carryOver 快照」决定。
 * pi 在 RPC 模式会把内置工具（read/bash/edit/write）与全部扩展工具都激活，
 * 这里收敛到 TACode 的工具表（内置工具仍由 approveToolCall 的钩子拦下）；
 * 进入 plan 前由 captureToolSetCarryOver 记下「基础/贡献之外仍激活」的名字
 * （例如 `mcp__*`），离开 plan 后按原样恢复。
 */
export function applyToolSet(pi: {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}): ToolSetDiff & { skipped: boolean } {
  const policy = store().policy;
  const next = computeActiveToolNames();
  if (!policy || !next) return { added: [], removed: [], skipped: true };
  const before = pi.getActiveTools();
  const diff = toolSetDiff(before, next);
  if (!diff.added.length && !diff.removed.length) return { ...diff, skipped: false };
  pi.setActiveTools(next);
  console.error(
    `[tool-set] permission=${policy.permission} added=[${diff.added.join(", ")}] removed=[${diff.removed.join(", ")}]`,
  );
  return { ...diff, skipped: false };
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}
