/**
 * 桥接路径（主进程 DelegationCoordinator）下，子代理「运行预算」启动选项的映射：
 * 思考等级（→ `effort`）与轮数上限（→ `maxTurns`）。
 *
 * 抽成独立纯函数是为了单测：`buildStartOptions` 本身在 `index.ts` 里，依赖 Electron
 * 与用户配置，测不到；而「角色定义里配的 thinkingLevel / maxTurns 必须真的生效」是
 * 实测暴露的缺陷（配了不生效的隐形承诺），需要有回归用例盯着。
 */

import { MAX_SUBAGENT_MAX_TURNS, isSubagentThinkingLevel } from "../shared/subagents.js";
import type { SubagentThinkingLevel } from "../shared/subagents.js";

/** `buildStartOptions` 能拿到的两处来源：共享 payload 与本地角色定义。 */
export interface DelegationRunSources {
  /** 来自桥接 payload（父会话/定义算出来的档位），可能是非法值或畸形类型。 */
  thinkingLevel?: unknown;
  /** 角色定义里的轮数上限，可能是非法值或畸形类型。 */
  maxTurns?: unknown;
  /** 角色定义里的命令策略（`readonly` 时子 worker 只跑白名单只读命令）。 */
  execPolicy?: unknown;
}

/**
 * 只接受已知档位：非法值（畸形桥接请求、版本不一致）宁可回落默认档，
 * 也不要原样塞进 `--thinking` 让 worker 启动失败。
 */
function knownThinkingLevel(value: unknown): SubagentThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const level = value.trim();
  return isSubagentThinkingLevel(level) ? level : undefined;
}

/**
 * 子代理的轮数预算：定义里配了就生效（收敛到 `MAX_SUBAGENT_MAX_TURNS`），
 * 没配则与进程内路径用同一个默认值——两条路径的收口语义必须一致。
 */
export function delegationTurnLimit(definition: Pick<DelegationRunSources, "maxTurns">): number {
  const value = definition?.maxTurns;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return Math.min(value, MAX_SUBAGENT_MAX_TURNS);
  }
  return MAX_SUBAGENT_MAX_TURNS;
}

/**
 * 思考等级 → worker 启动选项的 `effort`；轮数上限 → `maxTurns`。
 *
 * `effort` 走既有通道：`agent-host` → `--effort` → `runtime/options.ts` → `--thinking`。
 * `maxTurns` 经 `agent-host` 的 `TACODE_MAX_TURNS` 下发，由 runtime 的 `turn_end` 钩子
 * 收口（`runtime/extension.ts`），协调器再按同样的上限判定 `truncated`。
 * payload 里可能缺 `thinkingLevel`（`continue()` 重建 payload 时不带该字段），因此回落到
 * 角色定义，保证「配了就生效」而不是只写在定义里。
 */
export function delegationRunOptions(
  payload: DelegationRunSources,
  definition: DelegationRunSources,
): { effort?: string; maxTurns: number; execPolicy?: "readonly" } {
  const effort = knownThinkingLevel(payload.thinkingLevel) ?? knownThinkingLevel(definition.thinkingLevel);
  return {
    ...(effort ? { effort } : {}),
    maxTurns: delegationTurnLimit(definition),
    ...(definition.execPolicy === "readonly" ? { execPolicy: "readonly" as const } : {}),
  };
}

/** 子代理跑在哪个供应商/服务上。 */
export interface DelegationProviderTarget {
  /** 交给 worker 的供应商 id（桌面服务统一注册为 `openai`）。 */
  provider: string;
  /** 桌面服务 id；缺省表示不带服务、走内置凭据。 */
  serviceId?: string;
}

/**
 * 子代理的供应商/服务归位：
 *
 * - 钉选的 `providerId` 命中用户在「AI 服务」里加的服务（主进程查库得到 `pinnedServiceId`）
 *   → 用那个服务：运行时供应商固定为 `openai`（由 provider 扩展注册），凭据/baseUrl 都取该服务；
 * - 否则沿用父会话的供应商与服务（钉选只改模型、不改服务）。
 *
 * 服务从「父会话继承」到「可按定义覆盖」是这一层唯一的变化，权限与沙箱不受影响。
 */
export function delegationProviderTarget(input: {
  parentProvider: string;
  parentServiceId?: string;
  /** 钉选 provider 段对应的已启用桌面服务 id；未命中就是 undefined。 */
  pinnedServiceId?: string;
}): DelegationProviderTarget {
  if (input.pinnedServiceId) return { provider: "openai", serviceId: input.pinnedServiceId };
  return {
    provider: input.parentProvider,
    ...(input.parentServiceId ? { serviceId: input.parentServiceId } : {}),
  };
}
