import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "tsup";
import { build as buildRenderer } from "vite";
import react from "@vitejs/plugin-react";
import electron from "electron";

// Independent outputs and profile: safe to run alongside the main checkout.
const output = await mkdtemp(path.join(tmpdir(), "tacode-file-review-build-"));
try {
  await build({ entry: { "file-review-smoke": "scripts/file-review-smoke.ts" }, format: ["esm"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".mjs" }) });
  await writeFile(path.join(output, "file-review-preload.cjs"), `const { contextBridge } = require("electron"); contextBridge.exposeInMainWorld("harness", { app: { getLocale: async () => "zh", setLocale: async () => {} }, platform: process.platform });\n`);
  await buildRenderer({ configFile: false, plugins: [react()], base: "./", logLevel: "warn", worker: { format: "es" }, build: { outDir: path.join(output, "renderer"), emptyOutDir: true, rollupOptions: { input: "scripts/fixtures/file-review.html" } } });
  const env = { ...process.env, TACODE_FILE_REVIEW_FIXTURE: path.join(output, "renderer/scripts/fixtures/file-review.html") };
  delete env.ELECTRON_RUN_AS_NODE;
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(output, "file-review-smoke.mjs")], { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await rm(output, { recursive: true, force: true });
}
