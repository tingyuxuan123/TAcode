import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { build as buildRenderer } from "vite";
import react from "@vitejs/plugin-react";
import electron from "electron";

/**
 * 流式渲染性能探针入口：构建 fixture → 启动 Electron 驱动 → 打印对比表。
 *
 * 用法：
 *   node scripts/stream-perf.mjs [scenarios] [label]
 *   node scripts/stream-perf.mjs reply,reply-code,thinking before
 */

const scenarios = process.argv[2] || "reply";
const label = process.argv[3] || "run";
const output = await mkdtemp(path.join(tmpdir(), "tacode-stream-perf-"));
try {
  await buildRenderer({
    configFile: false,
    plugins: [react()],
    base: "./",
    logLevel: "warn",
    build: {
      outDir: path.join(output, "renderer"),
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rollupOptions: { input: "scripts/fixtures/stream-perf.html" },
    },
  });
  const env = {
    ...process.env,
    TACODE_STREAM_PERF_FIXTURE: path.join(output, "renderer/scripts/fixtures/stream-perf.html"),
    TACODE_STREAM_PERF_SCENARIOS: scenarios,
    TACODE_STREAM_PERF_LABEL: label,
  };
  if (process.argv[4]) env.TACODE_STREAM_PERF_TURNS = process.argv[4];
  delete env.ELECTRON_RUN_AS_NODE;
  const stdout = [];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, ["scripts/stream-perf-main.mjs"], { env });
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
    child.once("error", reject);
    child.once("exit", (exit) => resolve(exit ?? 1));
  });

  const text = stdout.join("");
  const line = text.split("\n").find((entry) => entry.includes("__STREAM_PERF_RESULT__"));
  if (!line) {
    console.error(text);
    throw new Error("探针未返回结果");
  }
  const { runs } = JSON.parse(line.slice(line.indexOf("__STREAM_PERF_RESULT__") + "__STREAM_PERF_RESULT__".length));
  const half = runs.length / 2;
  const measured = runs.slice(half);
  for (const run of measured) {
    console.log(`\n=== [${run.label}] ${run.scenario} ===`);
    console.log(`字符 ${run.charCount} / ${run.chunkCount} 块，流式 ${run.streamMs}ms，落字延迟 ${run.settleLagMs}ms`);
    console.log(`帧 ${run.frameCount}（${run.fps} fps，最长帧间隔 ${run.maxFrameGapMs}ms），长任务 ${run.longTaskCount} 个 / ${run.longTaskMs}ms`);
    console.log(`DOM 增/删 ${run.domAdds}/${run.domRemoves}，代码块增/删 ${run.codeBlockAdds}/${run.codeBlockRemoves}`);
    console.log(`渲染进程 CPU：${run.rendererCpuSeconds}s，峰值 ${run.rendererPeakPercent}%`);
    console.log("热点（自耗时占比）：");
    for (const item of run.top.slice(0, 12)) console.log(`  ${String(item.share).padStart(5)}%  ${String(item.ms).padStart(6)}ms  ${item.key}`);
  }
  console.log(`\n__RAW__${JSON.stringify(measured)}`);
  process.exitCode = code;
} finally {
  await rm(output, { recursive: true, force: true });
}
