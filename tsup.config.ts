import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { "main/index": "src/main/index.ts" },
    format: ["esm"],
    platform: "node",
    outDir: "dist-electron",
    sourcemap: true,
    clean: false,
    external: ["electron"],
    outExtension: () => ({ js: ".mjs" }),
  },
  {
    entry: { "preload/index": "src/preload/index.ts", "preload/webview-browser": "src/preload/webview-browser.ts" },
    format: ["cjs"],
    platform: "node",
    outDir: "dist-electron",
    sourcemap: true,
    clean: false,
    external: ["electron"],
    outExtension: () => ({ js: ".cjs" }),
  },
  {
    entry: { "extensions/vision": "src/extensions/vision.ts", "extensions/provider": "src/extensions/provider.ts", "extensions/browser": "src/extensions/browser.ts" },
    format: ["esm"],
    platform: "node",
    outDir: "dist-electron",
    sourcemap: false,
    clean: false,
    outExtension: () => ({ js: ".js" }),
  },
  {
    // Agent Runtime worker：由 agent-host 以 node 子进程启动，依赖从 node_modules 解析。
    entry: { "runtime/rpc-entry": "src/runtime/rpc-entry.ts" },
    format: ["esm"],
    platform: "node",
    outDir: "dist-electron",
    sourcemap: true,
    clean: false,
    outExtension: () => ({ js: ".js" }),
  },
]);
