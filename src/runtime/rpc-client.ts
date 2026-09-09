/**
 * TACode Runtime 入口定位。
 *
 * 主进程用 `spawn(process.execPath, [getTacodeRpcEntryPath(), ...])` 启动 worker。
 * 入口是 tsup 构建产物 `dist-electron/runtime/rpc-entry.js`，因此在开发、
 * 打包（asar: false）与测试环境下都能拿到真实文件路径。
 */

import { createRequire } from "node:module";
import path from "node:path";
import { tacodeEnv } from "./env.js";

/** 相对应用根目录的运行时入口路径。 */
const RUNTIME_ENTRY_RELATIVE = path.join("dist-electron", "runtime", "rpc-entry.js");

export function getTacodeRpcEntryPath(): string {
  const override = tacodeEnv("RUNTIME_ENTRY");
  if (override) return path.resolve(override);
  return path.join(getAppRoot(), RUNTIME_ENTRY_RELATIVE);
}

function getAppRoot(): string {
  const override = tacodeEnv("APP_ROOT");
  if (override) return path.resolve(override);
  const electronRoot = electronAppPath();
  if (electronRoot) return electronRoot;
  return process.cwd();
}

function electronAppPath(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const electron = require("electron") as { app?: { getAppPath?(): string } };
    const value = electron.app?.getAppPath?.();
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}
