import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "tsup";
import { build as buildRenderer } from "vite";
import react from "@vitejs/plugin-react";
import electron from "electron";

const output = await mkdtemp(path.join(tmpdir(), "tacode-capability-smoke-build-"));
try {
  await symlink(path.resolve("node_modules"), path.join(output, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await build({ entry: { smoke: "scripts/capabilities-smoke.ts" }, format: ["esm"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".mjs" }) });
  await buildRenderer({ configFile: false, plugins: [react()], base: "./", logLevel: "warn", build: { outDir: path.join(output, "renderer"), emptyOutDir: true, rollupOptions: { input: "scripts/fixtures/capabilities.html" } } });
  const env = { ...process.env, TACODE_CAPABILITY_FIXTURE: path.join(output, "renderer/scripts/fixtures/capabilities.html"), TACODE_TEST_NODE: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(output, "smoke.mjs")], { env, stdio: "inherit" });
    child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1));
  });
} finally { await rm(output, { recursive: true, force: true }); }
