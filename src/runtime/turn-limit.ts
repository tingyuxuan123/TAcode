/**
 * 子代理轮数预算（runtime 侧）。
 *
 * 由主进程经 `TACODE_MAX_TURNS` 下发（见 `main/agent-host.ts`）。计数必须按「每次运行」
 * 计：同一个 worker 会被 `delegate_continue` 复用，进程级计数会让续跑拿不到完整预算
 * （父侧协调器是用「本次运行新增轮次」判定的，两侧口径必须一致）。
 */

/** 解析下发的轮数上限；非正整数/畸形值一律忽略（不设上限）。 */
export function parseTurnLimit(value: string | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const limit = Number(trimmed);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

export interface TurnLimiter {
  /** 新一轮运行开始（清空计数）；到过上限后的下一轮同样从这里开始。 */
  startRun(): void;
  /** 记一轮；返回 true 表示本次运行已到上限，调用方应收口（abort）。 */
  countTurn(): boolean;
}

/** 未配置上限时返回 undefined，调用方据此不注册任何钩子。 */
export function createTurnLimiter(limit: number | undefined): TurnLimiter | undefined {
  if (limit === undefined) return undefined;
  let turns = 0;
  let reached = false;
  return {
    startRun(): void {
      turns = 0;
      reached = false;
    },
    countTurn(): boolean {
      if (reached) return false;
      turns += 1;
      if (turns >= limit) {
        reached = true;
        return true;
      }
      return false;
    },
  };
}
