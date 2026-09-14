import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "tsup";
import electron from "electron";

const output = await mkdtemp(path.join(tmpdir(), "tacode-file-editing-app-build-"));
const directory = await mkdtemp(path.join(tmpdir(), "tacode-file-editing-app-"));
const artifacts = process.env.TACODE_FILE_EDIT_ARTIFACTS ?? await mkdtemp(path.join(tmpdir(), "tacode-file-editing-app-artifacts-"));
try {
  await build({ entry: { smoke: "scripts/file-editing-app-smoke.ts" }, format: ["esm"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".mjs" }) });
  const env = { ...process.env, TACODE_FILE_EDIT_APP_DIR: directory, TACODE_FILE_EDIT_ARTIFACTS: artifacts, TACODE_PRODUCTION_MAIN: path.resolve("dist-electron/main/index.mjs") }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(output, "smoke.mjs")], { env, stdio: ["ignore", "pipe", "inherit"] });
    let timeout = setTimeout(() => child.kill("SIGKILL"), 100_000);
    child.stdout.on("data", (chunk) => { const text = chunk.toString(); process.stdout.write(text); if (text.includes("FILE_EDITING_APP_FAILED")) { clearTimeout(timeout); timeout = setTimeout(() => child.kill("SIGKILL"), 1000); } });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); }); child.once("exit", (code) => { clearTimeout(timeout); resolve(code ?? 1); });
  });
  assert.equal(code, 0, `Production lifecycle failed; artifacts: ${artifacts}`);
  const expected = JSON.parse(await readFile(path.join(artifacts, "app-expected.json"), "utf8"));
  assert.equal(JSON.parse(await readFile(expected.recovery, "utf8")).content, expected.expected);
  assert.equal(await readFile(expected.disk, "utf8"), "APP_DISK_A\n");
  const result = { ...JSON.parse(await readFile(path.join(artifacts, "app.json"), "utf8")), date: new Date().toISOString(), exitCode: code, exactRecovery: true, diskUnchanged: true,
    artifacts, boundary: "Unmodified production main/preload/App builds; isolated appData/TACODE_HOME and APFS projects; semantic project commands and native editor/dialog input; natural Electron exit independently verified by the parent." };
  await writeFile(process.env.TACODE_FILE_EDIT_APP_REPORT ?? "docs/file-review-reference/fr-08-app-result.json", JSON.stringify(result, null, 2) + "\n");
  console.log(`Full production main/preload/App quit and exact recovery passed: ${artifacts}`);
} finally { await rm(output, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); }
