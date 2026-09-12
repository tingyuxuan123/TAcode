import { build } from "vite";
import react from "@vitejs/plugin-react";

/** 把「流式落字路径探针」构建成生产 React 版本，用来量 dev 与打包版的差距。 */
await build({
  configFile: false,
  plugins: [react()],
  base: "./",
  logLevel: "warn",
  root: ".",
  build: {
    outDir: process.argv[2] ?? "/tmp/live-text-prod",
    emptyOutDir: true,
    rollupOptions: { input: "scripts/fixtures/stream-live-text.html" },
  },
});
console.log("built");
