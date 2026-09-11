import type { AppBuildStatus } from "../shared/types";

/**
 * 运行中的代码是不是「旧构建」。
 *
 * 背景：`pnpm build` / `pnpm dev` 重建产物后，**已经在跑的 Electron 主进程仍执行内存里的旧代码**
 * （只有新起的 RPC worker 会读到新产物）。这会造成很难自查的现象，例如：worker 注入的子代理目录
 * 里已经有新工具，而主进程合成给子代理的任务里还是旧工具集（真实踩过一次）。
 *
 * 判定：主进程启动时间 vs 磁盘上主进程 bundle 的 mtime —— 磁盘更新即说明「本地已重建，需要重启」。
 */

/** 容差：构建与启动几乎同时发生时不要误报。 */
export const BUILD_STALENESS_TOLERANCE_MS = 2_000;

/** 纯函数，便于单测。 */
export function appBuildStatus(startedAt: number, bundleMtimeMs: number | undefined): AppBuildStatus {
  const restartRequired = bundleMtimeMs !== undefined
    && bundleMtimeMs > startedAt + BUILD_STALENESS_TOLERANCE_MS;
  return { startedAt, ...(bundleMtimeMs !== undefined ? { bundleMtimeMs } : {}), restartRequired };
}
