import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "tsup";
import { build as buildRenderer } from "vite";
import react from "@vitejs/plugin-react";
import electron from "electron";
const output = await mkdtemp(path.join(tmpdir(), "tacode-ui-review-build-"));
try {
  await build({ entry: { smoke: "scripts/ui-review-smoke.ts" }, format: ["esm"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".mjs" }) });
  await build({ entry: { preload: "src/preload/index.ts" }, format: ["cjs"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".cjs" }) });
  await buildRenderer({ configFile: false, plugins: [react()], base: "./", logLevel: "warn", worker: { format: "es" }, build: { outDir: path.join(output, "renderer"), emptyOutDir: true, rollupOptions: { input: "scripts/fixtures/file-workbench.html" } } });
  await mkdir(path.resolve("docs/file-review-reference"), { recursive: true });
  const env = { ...process.env, TACODE_FILE_WORKBENCH_FIXTURE: path.join(output, "renderer/scripts/fixtures/file-workbench.html") }; delete env.ELECTRON_RUN_AS_NODE;
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(output, "smoke.mjs")], { env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); }); child.once("exit", (code) => { clearTimeout(timer); resolve(code ?? 1); });
  });
} finally { await rm(output, { recursive: true, force: true }); }
