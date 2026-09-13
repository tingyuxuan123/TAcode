import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { build } from "tsup";
import { build as buildRenderer } from "vite";
import react from "@vitejs/plugin-react";
import electron from "electron";

const output = await mkdtemp(path.join(tmpdir(), "tacode-activity-build-"));
try {
  await symlink(path.resolve("node_modules"), path.join(output, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await build({ entry: { smoke: "scripts/session-activity-smoke.ts" }, format: ["esm"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".mjs" }) });
  await build({ entry: { preload: "src/preload/index.ts" }, format: ["cjs"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".cjs" }) });
  const baseline = process.env.TACODE_ACTIVITY_BASELINE === "1";
  const baselineFiles = new Set(["src/renderer/App.tsx", "src/renderer/ui.tsx", "src/renderer/styles.css"]);
  const baselinePlugin = { name: "activity-navigation-baseline", enforce: "pre", load(id) {
    const file = path.relative(process.cwd(), id);
    if (baseline && baselineFiles.has(file)) return execFileSync("git", ["show", `${process.env.TACODE_ACTIVITY_BASELINE_REF ?? "HEAD"}:${file}`], { encoding: "utf8", maxBuffer: 2 ** 22 });
  } };
  await buildRenderer({ configFile: false, plugins: [baselinePlugin, react()], base: "./", logLevel: "warn", build: { outDir: path.join(output, "renderer"), emptyOutDir: true, rollupOptions: { input: "index.html" } } });
  const env = { ...process.env, TACODE_ACTIVITY_FIXTURE: path.join(output, "renderer/index.html") };
  delete env.ELECTRON_RUN_AS_NODE;
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(output, "smoke.mjs")], { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await rm(output, { recursive: true, force: true });
}
