import { describe, expect, it } from "vitest";
import { appBuildStatus, BUILD_STALENESS_TOLERANCE_MS } from "./build-status";

/**
 * 「主进程是旧构建」的自查：本地重建产物后，已在跑的进程仍在执行内存里的旧代码
 * （真实踩过：worker 里的子代理目录已是新工具，主进程给子代理的任务仍是旧工具集）。
 */
describe("appBuildStatus", () => {
  const startedAt = 1_000_000;

  it("磁盘产物比进程新 → 提示需要重启", () => {
    expect(appBuildStatus(startedAt, startedAt + BUILD_STALENESS_TOLERANCE_MS + 1).restartRequired).toBe(true);
  });

  it("同一批次构建/启动（容差内）不误报", () => {
    expect(appBuildStatus(startedAt, startedAt + 500).restartRequired).toBe(false);
    expect(appBuildStatus(startedAt, startedAt - 10_000).restartRequired).toBe(false);
  });

  it("取不到 bundle mtime 时不误报", () => {
    expect(appBuildStatus(startedAt, undefined).restartRequired).toBe(false);
  });
});
