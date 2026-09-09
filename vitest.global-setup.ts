/**
 * vitest 全局准备：确保 Agent Runtime worker 已构建。
 * `src/main` 的集成测试会真实 spawn `dist-electron/runtime/rpc-entry.js`。
 */

import { ensureRuntimeBuilt } from "./scripts/ensure-runtime.mjs";

export default function globalSetup(): void {
  ensureRuntimeBuilt();
}
