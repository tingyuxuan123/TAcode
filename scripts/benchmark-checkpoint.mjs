import fs from "node:fs/promises";
import { tmpdir, cpus, platform, release } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "tsup";

const exec = promisify(execFile);
const root = await fs.mkdtemp(path.join(tmpdir(), "tacode-checkpoint-benchmark-"));
const project = path.join(root, "project");
const baselineRevision = "dca5047";
const samples = [];
try {
  const paths = (await exec("git", ["ls-files", "-z", "--", "src", "scripts", "package.json", "tsconfig.json", "README.md"])).stdout.split("\0").filter(Boolean);
  for (const relative of paths) {
    const target = path.join(project, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(relative, target);
  }
  const baseline = path.join(root, "baseline.ts");
  await fs.writeFile(baseline, (await exec("git", ["show", `${baselineRevision}:src/runtime/tools/checkpoint.ts`])).stdout);
  for (const [entry, output] of [[baseline, "baseline"], ["src/runtime/tools/checkpoint.ts", "current"], ["src/runtime/tools/workspace.ts", "workspace"]]) {
    await build({ entry: { [output]: entry }, outDir: root, bundle: true, platform: "node", format: ["esm"], config: false, silent: true, target: "node22", outExtension: () => ({ js: ".mjs" }) });
  }
  const baselineApi = await import(pathToFileURL(path.join(root, "baseline.mjs")).href);
  const currentApi = await import(pathToFileURL(path.join(root, "current.mjs")).href);
  const { Workspace } = await import(pathToFileURL(path.join(root, "workspace.mjs")).href);
  const cache = new currentApi.WorkspaceCheckpointCache();
  const originalRead = fs.readFile;
  let reads = 0;
  fs.readFile = async (...args) => { reads++; return originalRead(...args); };
  try {
    for (let round = 0; round < 6; round++) for (const mode of round % 2 ? ["cached", "baseline"] : ["baseline", "cached"]) {
      reads = 0;
      let commandMs = 0;
      const start = performance.now();
      const result = await (mode === "baseline" ? baselineApi : currentApi).captureWorkspaceCheckpoint(new Workspace(project), "node -e empty", async () => {
        const at = performance.now();
        await exec(process.execPath, ["-e", "process.stdout.write('ok')"], { cwd: project });
        commandMs = performance.now() - at;
        return { running: false };
      }, { cache });
      samples.push({ mode, round, totalMs: performance.now() - start, commandMs, scanMs: performance.now() - start - commandMs, reads, metrics: result.metrics });
    }
  } finally { fs.readFile = originalRead; }
  const report = { date: new Date().toISOString(), baselineRevision, cpu: cpus()[0]?.model, platform: platform(), os: release(), files: paths.length, samples };
  const output = process.argv[2];
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
