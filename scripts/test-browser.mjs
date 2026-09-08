import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build } from "tsup";
import electron from "electron";

const output = await mkdtemp(path.join(tmpdir(), "tether-browser-smoke-build-"));
try {
  await build({ entry: { smoke: "scripts/browser-smoke.ts" }, format: ["esm"], platform: "node", target: "node22", outDir: output, external: ["electron"], config: false, silent: true, outExtension: () => ({ js: ".mjs" }) });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(output, "smoke.mjs")], { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(output, { recursive: true, force: true });
}
