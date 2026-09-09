#!/usr/bin/env node
/**
 * TACode 自研 Agent Runtime 入口（RPC 模式）。
 *
 * 与 `tether-agent-core` 的 rpc-entry 不同，这里直接调用 Pi 的 `main()`：
 * RPC 协议、会话管理、内置工具、模型协议都由 `@earendil-works/pi-coding-agent`
 * 提供，TACode 只注入自己的扩展（`createTacodeExtension`）与数据目录/凭据。
 *
 * 由 `src/main/agent-host.ts` 以 `ELECTRON_RUN_AS_NODE=1` 子进程方式启动，
 * 通过换行分隔的 JSON-RPC over stdio 通信，命令白名单与 Tether Runtime 一致。
 *
 * 注意：不要设置 `process.title`。worker 是 Electron 二进制以 node 模式运行的子进程，
 * 在 macOS 上调用 `process.title` 会让 LaunchServices 给每个 worker 注册一个 Dock 图标
 * （通用 Unix 可执行图标），每开一个会话就多一个。去掉标题后 ps 里仍能看到完整命令行。
 */

import { main } from "@earendil-works/pi-coding-agent";
import { ensureProviderConfigured } from "./auth.js";
import { installTacodeCredentialStore } from "./credential-store.js";
import { createTacodeExtension } from "./extension.js";
import { initializeTacodeHome } from "./home.js";
import { parseRuntimeArgs } from "./options.js";

process.env.PI_CODING_AGENT = "true";
process.env.PI_TELEMETRY ??= "0";
process.env.PI_SKIP_VERSION_CHECK ??= "1";

const parsed = parseRuntimeArgs(process.argv.slice(2));
process.chdir(parsed.options.cwd);

try {
  await initializeTacodeHome();
  await installTacodeCredentialStore();
  await ensureProviderConfigured(parsed.options.providerId);
  await main(parsed.piArgs, {
    extensionFactories: [createTacodeExtension(parsed.options)],
  });
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`error: ${detail}\n`);
  process.exitCode = 1;
}
