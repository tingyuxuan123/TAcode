import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "tsup";
import { build as buildRenderer } from "vite";
import react from "@vitejs/plugin-react";
import electron from "electron";

const output = await mkdtemp(path.join(tmpdir(), "tacode-file-editing-build-"));
const directory = await mkdtemp(path.join(tmpdir(), "tacode-file-editing-"));
const artifacts = process.env.TACODE_FILE_EDIT_ARTIFACTS ?? await mkdtemp(path.join(tmpdir(), "tacode-file-editing-artifacts-"));
try {
  await build({ entry: { smoke: "scripts/file-editing-smoke.ts" }, format: ["esm"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".mjs" }) });
  await build({ entry: { preload: "src/preload/index.ts" }, format: ["cjs"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".cjs" }) });
  await buildRenderer({ configFile: false, plugins: [react()], base: "./", logLevel: "warn", worker: { format: "es" }, build: { outDir: path.join(output, "renderer"), emptyOutDir: true, rollupOptions: { input: "scripts/fixtures/file-workbench.html" } } });
  const env = { ...process.env, TACODE_FILE_WORKBENCH_FIXTURE: path.join(output, "renderer/scripts/fixtures/file-workbench.html"), TACODE_FILE_EDIT_DIR: directory, TACODE_FILE_EDIT_ARTIFACTS: artifacts }; delete env.ELECTRON_RUN_AS_NODE;
  for (const phase of ["initial", "restart"]) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(electron, [path.join(output, "smoke.mjs")], { env: { ...env, TACODE_FILE_EDIT_PHASE: phase }, stdio: ["ignore", "pipe", "inherit"] });
      let timeout = setTimeout(() => { console.error(`Electron ${phase} failed to exit`); child.kill("SIGKILL"); }, 200_000);
      child.stdout.on("data", (chunk) => {
        const text = chunk.toString(); process.stdout.write(text);
        if (text.includes("FILE_EDITING_EXIT 1")) { clearTimeout(timeout); timeout = setTimeout(() => child.kill("SIGKILL"), 1000); }
      });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => { clearTimeout(timeout); resolve(code ?? 1); });
    });
    if (code !== 0) { process.exitCode = code; break; }
  }
  if (!process.exitCode) {
    const phases = await Promise.all(["initial", "restart"].map(async (phase) => JSON.parse(await readFile(path.join(artifacts, `${phase}.json`), "utf8"))));
    const result = { date: new Date().toISOString(), phases, artifacts, boundary: "Two separate offline Electron processes using production preload/files IPC, native Chromium keyboard/mouse, real APFS files and durable application recovery records." };
    await writeFile(process.env.TACODE_FILE_EDIT_REPORT ?? "docs/file-review-reference/fr-08-result.json", JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  }
} finally { await rm(output, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); }
