/**
 * 确保 Agent Runtime worker 已构建（`dist-electron/runtime/rpc-entry.js`）。
 *
 * `src/main` 的集成测试会真实 spawn 这个 worker，而 `pnpm test` 本身不跑构建。
 * 这里在 vitest globalSetup 阶段检查：产物缺失或落后于 `src/runtime` 源码时，
 * 只重跑 tsup（毫秒级），避免测试用到过期产物。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(repoRoot, "dist-electron", "runtime", "rpc-entry.js");

function newestMtimeMs(directory) {
  let newest = 0;
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = statSync(file);
    if (stat.isDirectory()) newest = Math.max(newest, newestMtimeMs(file));
    else newest = Math.max(newest, stat.mtimeMs);
  }
  return newest;
}

export function ensureRuntimeBuilt() {
  const config = path.join(repoRoot, "tsup.config.ts");
  let sources = 0;
  try {
    sources = Math.max(newestMtimeMs(path.join(repoRoot, "src", "runtime")), statSync(config).mtimeMs);
  } catch {
    sources = 0;
  }
  if (existsSync(entry) && statSync(entry).mtimeMs >= sources) return;

  const result = spawnSync("pnpm", ["exec", "tsup"], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error("Agent Runtime 构建失败：无法生成 dist-electron/runtime/rpc-entry.js");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureRuntimeBuilt();
}
