import { app, BrowserWindow } from "electron";

/**
 * 流式渲染性能探针的 Electron 主进程驱动。
 *
 * 逐场景加载 fixture，采样渲染进程 CPU（对齐活动监视器的 %CPU），
 * 并用 CDP Profiler 抓真实 CPU profile 做自耗时归因。
 *
 * 用法：由 `scripts/stream-perf.mjs` 经 TACODE_STREAM_PERF_FIXTURE 传入 fixture 路径。
 */

const fixture = process.env.TACODE_STREAM_PERF_FIXTURE;
const scenarios = (process.env.TACODE_STREAM_PERF_SCENARIOS || "reply").split(",").filter(Boolean);
const label = process.env.TACODE_STREAM_PERF_LABEL || "run";
let runIndex = 0;

if (!fixture) {
  console.error("缺少 TACODE_STREAM_PERF_FIXTURE");
  process.exit(2);
}

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.on("window-all-closed", () => {});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rendererCpu() {
  const entries = app.getAppMetrics().filter((entry) => entry.type === "Tab" || entry.type === "Renderer" || /renderer/i.test(entry.name ?? ""));
  const cumulative = entries.reduce((sum, entry) => sum + (entry.cpu?.cumulativeCPUUsage ?? 0), 0);
  const percent = entries.reduce((sum, entry) => sum + (entry.cpu?.percentCPUUsage ?? 0), 0);
  return { cumulative, percent };
}

function aggregate(profile) {
  if (!profile?.nodes) return [];
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  let total = 0;
  const deltas = profile.timeDeltas ?? [];
  const samples = profile.samples ?? [];
  for (let index = 0; index < samples.length; index += 1) {
    const node = byId.get(samples[index]);
    if (!node) continue;
    const ms = (deltas[index] ?? 1000) / 1000;
    total += ms;
    const frame = node.callFrame ?? {};
    let url = String(frame.url ?? "");
    if (url.startsWith("file://")) url = url.slice(url.indexOf("/scripts/") >= 0 ? url.indexOf("/scripts/") : url.lastIndexOf("/"));
    const name = frame.functionName || "(anonymous)";
    const key = `${name} @ ${url}:${(frame.lineNumber ?? -1) + 1}`;
    self.set(key, (self.get(key) ?? 0) + ms);
  }
  return [...self.entries()]
    .map(([key, ms]) => ({ key, ms: Math.round(ms), share: Number((ms / total * 100).toFixed(1)) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 18);
}

async function runScenario(win, scenario) {
  // 同 URL 同 hash 的 loadFile 属于同文档导航，不会重新执行页面；用 query 强制重载。
  const query = { run: String(runIndex += 1) };
  if (process.env.TACODE_STREAM_PERF_TURNS) query.turns = process.env.TACODE_STREAM_PERF_TURNS;
  await win.loadFile(fixture, { hash: scenario, query });
  const debuggerApi = win.webContents.debugger;
  if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
  await debuggerApi.sendCommand("Profiler.enable");
  await debuggerApi.sendCommand("Profiler.setSamplingInterval", { interval: 200 });

  const logs = [];
  const onConsole = (event, ...rest) => {
    // Electron 37 起 console-message 只给事件对象。
    const message = typeof event === "object" && event !== null && "message" in event ? event.message : rest[0];
    if (typeof message === "string") { logs.push(message); if (process.env.TACODE_STREAM_PERF_VERBOSE) console.error("[renderer]", message); }
  };
  win.webContents.on("console-message", onConsole);

  const started = performance.now();
  let cpuStart = rendererCpu();
  let peakPercent = 0;
  let probeStart = false;
  const sampler = setInterval(() => {
    const sample = rendererCpu();
    peakPercent = Math.max(peakPercent, sample.percent);
  }, 120);

  const deadline = Date.now() + 90_000;
  let result;
  while (Date.now() < deadline) {
    const done = logs.find((entry) => entry.startsWith("__STREAM_PERF__"));
    if (!probeStart && logs.includes("__STREAM_PERF_START__")) {
      probeStart = true;
      cpuStart = rendererCpu();
      await debuggerApi.sendCommand("Profiler.start");
    }
    if (done) {
      const { profile } = await debuggerApi.sendCommand("Profiler.stop");
      result = { metrics: JSON.parse(done.slice("__STREAM_PERF__".length)), top: aggregate(profile) };
      break;
    }
    await sleep(50);
  }
  clearInterval(sampler);
  win.webContents.removeListener("console-message", onConsole);
  if (!result) {
    console.error(`[probe] ${scenario} 超时，渲染层日志：`);
    for (const entry of logs.slice(-40)) console.error(`  ${entry}`);
    throw new Error(`${scenario} 未在 90s 内完成`);
  }

  const cpuEnd = rendererCpu();
  return {
    label,
    scenario,
    wallMs: Math.round(performance.now() - started),
    rendererCpuSeconds: Number((cpuEnd.cumulative - cpuStart.cumulative).toFixed(2)),
    rendererPeakPercent: Number(peakPercent.toFixed(1)),
    ...result.metrics,
    top: result.top,
  };
}

async function main() {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    show: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
  });
  win.showInactive();
  const runs = [];
  try {
    for (const scenario of scenarios) runs.push(await runScenario(win, scenario.trim()));
    // 每个场景跑两遍，第二遍用来抵消 JIT 预热；只输出全部结果，由外层取第二轮。
    for (const scenario of scenarios) runs.push(await runScenario(win, scenario.trim()));
    console.log(`__STREAM_PERF_RESULT__${JSON.stringify({ label, runs })}`);
  } catch (error) {
    console.error(String(error?.stack ?? error));
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.quit();
  }
}

app.whenReady().then(main);
