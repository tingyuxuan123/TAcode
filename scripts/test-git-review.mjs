import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "tsup";
import { build as buildRenderer } from "vite";
import react from "@vitejs/plugin-react";
import electron from "electron";

const output = await mkdtemp(path.join(tmpdir(), "tacode-git-review-build-"));
try {
  await build({ entry: { "git-review-smoke": "scripts/git-review-smoke.ts" }, format: ["esm"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".mjs" }) });
  // This is the production contextBridge API, not a renderer-side Git mock.
  await build({ entry: { "git-review-preload": "src/preload/index.ts" }, format: ["cjs"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".cjs" }) });
  await buildRenderer({ configFile: false, plugins: [react()], base: "./", logLevel: "warn", worker: { format: "es" }, build: { outDir: path.join(output, "renderer"), emptyOutDir: true, rollupOptions: { input: "scripts/fixtures/git-review.html" } } });
  const env = { ...process.env, TACODE_GIT_REVIEW_FIXTURE: path.join(output, "renderer/scripts/fixtures/git-review.html") };
  delete env.ELECTRON_RUN_AS_NODE;
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(output, "git-review-smoke.mjs")], { env, stdio: "inherit" });
    child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1));
  });
} finally { await rm(output, { recursive: true, force: true }); }
