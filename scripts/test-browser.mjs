import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "tsup";
import { build as buildRenderer } from "vite";
import react from "@vitejs/plugin-react";
import electron from "electron";

const output = await mkdtemp(path.join(tmpdir(), "tether-browser-smoke-build-"));
try {
  await build({ entry: { smoke: "scripts/browser-smoke.ts", workbench: "scripts/workbench-smoke.ts" }, format: ["esm"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".mjs" }) });
  await buildRenderer({ configFile: false, plugins: [react()], base: "./", logLevel: "warn", build: { outDir: path.join(output, "renderer"), emptyOutDir: true, rollupOptions: { input: "scripts/fixtures/workbench.html" } } });
  const env = { ...process.env, TETHER_WORKBENCH_FIXTURE: path.join(output, "renderer/scripts/fixtures/workbench.html") };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const entry of process.env.TETHER_COMPOSER_ONLY ? ["workbench"] : ["smoke", "workbench"]) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(electron, [path.join(output, `${entry}.mjs`)], { env, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (code !== 0) { process.exitCode = code; break; }
  }
} finally {
  await rm(output, { recursive: true, force: true });
}
