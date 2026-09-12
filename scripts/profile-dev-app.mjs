/**
 * 真实 dev 窗口的按帧体检：CPU profile + Blink 阶段归因 + **按帧现场标记**。
 *
 * 用法：
 *   1) 另开一个终端：pnpm dev:attach      # vite 已在 5177 时可用，CDP 在 9222
 *   2) 在那个窗口里正常发一条消息跑起来
 *   3) node scripts/profile-dev-app.mjs [采样秒数] [--scroll]
 *      --scroll：采样期间注入真实滚轮手势（交替上下），用来量「滚动时的帧」。
 *
 * 输出：
 *   - 总体帧间隔，以及**滚动帧 / 静止帧**分开的 p50·p95·最长
 *   - **折叠瞬间**（思考条目从展开变成 `.clipped`）前后 ±0.4s 的帧
 *   - 最差 10 帧及其现场（是否在滚、clipped 数、挂载条目数、末尾文本长度）
 *   - CPU 自耗时排序、Blink 阶段总时长、`Performance` 累计指标差值
 *
 * 只在采样期间注入帧计数器，不改业务代码。
 */

const endpoint = process.env.TACODE_CDP ?? "http://127.0.0.1:9222";
const seconds = Number(process.argv[2] ?? 25);
const scrollMode = process.argv.includes("--scroll") || process.argv.includes("--watch");
/** --watch：等真实流式开始再采样，一直采到思考折叠（或停滞 6s）之后再收 3s。 */
const watchMode = process.argv.includes("--watch");

const targets = await (await fetch(`${endpoint}/json/list`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error(`没有找到页面目标（${endpoint}/json/list）`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const traceEvents = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === "Tracing.dataCollected") traceEvents.push(...(message.params?.value ?? []));
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(JSON.stringify(message.error)));
  else resolve(message.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result?.result?.value;
};

const SAMPLER = `(() => {
  const state = { records: [], longTasks: 0, stop: false, last: 0, lastScroll: 0 };
  window.__perfProbe = state;
  const tick = () => {
    if (state.stop) return;
    const now = performance.now();
    const box = document.querySelector(".conversation");
    const scrollTop = box ? box.scrollTop : 0;
    if (state.last) {
      state.records.push({
        dt: now - state.last,
        scroll: Math.abs(scrollTop - state.lastScroll) > 1,
        delta: Math.round(scrollTop - state.lastScroll),
        clipped: document.querySelectorAll(".flow-thought-text.clipped").length,
        items: document.querySelectorAll(".message-item").length,
        text: (document.querySelector(".message-item:last-child")?.textContent ?? "").length,
        thought: (document.querySelector(".flow-thought-text")?.textContent ?? "").length,
      });
    }
    state.lastScroll = scrollTop;
    state.last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => { state.longTasks += list.getEntries().length; }).observe({ entryTypes: ["longtask"] });
  } catch {}
  return "ok";
})()`;

const METRICS = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount", "JSHeapUsedSize"];
const metricsOf = async () => {
  await send("Performance.enable").catch(() => undefined);
  const { metrics } = await send("Performance.getMetrics");
  const out = {};
  for (const metric of metrics) if (METRICS.includes(metric.name)) out[metric.name] = metric.value;
  return out;
};

const quantile = (values, q) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q))].toFixed(1));
};
const stats = (records) => ({
  n: records.length,
  p50: quantile(records.map((r) => r.dt), 0.5),
  p95: quantile(records.map((r) => r.dt), 0.95),
  max: records.length ? Number(Math.max(...records.map((r) => r.dt)).toFixed(1)) : 0,
  over20: records.filter((r) => r.dt > 20).length,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probeStream() {
  const raw = await evaluate(`(() => {
    const live = document.querySelector(".flow-thought-text:not(.clipped)");
    return JSON.stringify({
      live: Boolean(live),
      text: (live?.textContent ?? "").length,
      clipped: document.querySelectorAll(".flow-thought-text.clipped").length,
    });
  })()`);
  return JSON.parse(raw || "{}");
}

if (watchMode) {
  process.stdout.write("等待流式开始（请在窗口里发一条消息）…\n");
  const deadline = Date.now() + Number(process.env.TACODE_WATCH_TIMEOUT_MS ?? 300_000);
  let previous = -1;
  let detected = null;
  while (Date.now() < deadline) {
    const state = await probeStream();
    if (!state.live) previous = -1;
    else if (previous >= 0 && state.text > previous + 40) { detected = state; break; }
    else previous = state.text;
    await sleep(400);
  }
  if (!detected) {
    console.log("等待超时：没检测到流式开始（窗口里发一条消息即可）");
    ws.close();
    process.exit(2);
  }
  console.log(`检测到流式（思考 ${detected.text} 字符），开始采样 + 注入滚动`);
}

const box = JSON.parse(await evaluate(`(() => {
  const el = document.querySelector(".conversation");
  if (!el) return "null";
  const r = el.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 160)) });
})()`) || "null");

await evaluate(SAMPLER);
const metricsBefore = await metricsOf();
await send("Tracing.start", { categories: "devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline.frame", transferMode: "ReportEvents" });
await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 200 });
await send("Profiler.start");

process.stdout.write(`采样中${scrollMode ? "（注入滚动手势）" : ""}…`);
const started = Date.now();
let direction = -1;
const scrollTimer = scrollMode && box ? setInterval(() => {
  void send("Input.synthesizeScrollGesture", {
    x: box.x,
    y: box.y,
    xDistance: 0,
    yDistance: direction * 600,
    speed: 800,
    gestureSourceType: "mouse",
  }).catch(() => undefined);
  direction *= -1;
}, 1200) : null;

if (watchMode) {
  // 采到「思考折叠」或「文本停滞 6s」为止，再多收 3s。
  const deadline = Date.now() + Number(process.env.TACODE_WATCH_STREAM_MS ?? 600_000);
  let lastText = -1;
  let lastGrow = Date.now();
  while (Date.now() < deadline) {
    const state = await probeStream();
    if (state.text > lastText) { lastText = state.text; lastGrow = Date.now(); }
    const collapsed = state.clipped > 0 && !state.live;
    const stalled = Date.now() - lastGrow > 6_000;
    if (collapsed || stalled) {
      process.stdout.write(collapsed ? " 检测到折叠，" : " 文本停滞，");
      break;
    }
    await sleep(400);
  }
  await sleep(3_000);
} else {
  await sleep(seconds * 1000);
}
if (scrollTimer) clearInterval(scrollTimer);
process.stdout.write("完成\n");

const { profile } = await send("Profiler.stop");
await send("Tracing.end");
await new Promise((resolve) => setTimeout(resolve, 700));
const metricsAfter = await metricsOf();
const raw = await evaluate("window.__perfProbe.stop = true; JSON.stringify({ records: window.__perfProbe.records, longTasks: window.__perfProbe.longTasks })");
const state = JSON.parse(raw || "{}");
const records = state.records ?? [];
const elapsed = ((Date.now() - started) / 1000).toFixed(0);

console.log(`\n采样 ${elapsed}s：${records.length} 帧，长任务 ${state.longTasks ?? 0} 个`);
const all = stats(records);
console.log(`总体帧间隔 p50/p95/最长 ${all.p50} / ${all.p95} / ${all.max} ms，>20ms 帧 ${all.over20} 个`);

const scrolling = records.filter((r) => r.scroll);
const still = records.filter((r) => !r.scroll);
if (scrollMode && scrolling.length) {
  const a = stats(scrolling);
  const b = stats(still);
  console.log(`\n滚动帧（${a.n} 帧）：   p50/p95/最长 ${a.p50} / ${a.p95} / ${a.max} ms，>20ms ${a.over20} 个`);
  console.log(`静止帧（${b.n} 帧）：   p50/p95/最长 ${b.p50} / ${b.p95} / ${b.max} ms，>20ms ${b.over20} 个`);
} else if (scrollMode) {
  console.log("\n⚠️ 没有捕到滚动帧（滚轮手势可能没落在滚动容器上）");
}

// 折叠瞬间：思考条目从「展开」变成「.clipped」的那一帧前后 ±0.4s。
const transitions = [];
for (let index = 1; index < records.length; index += 1) {
  if (records[index].clipped > records[index - 1].clipped) transitions.push(index);
}
if (transitions.length) {
  const window = 24;
  const around = [];
  for (const index of transitions) around.push(...records.slice(Math.max(0, index - window), index + window));
  const c = stats(around);
  console.log(`\n折叠瞬间（${transitions.length} 次，前后 ±0.4s 共 ${c.n} 帧）：p50/p95/最长 ${c.p50} / ${c.p95} / ${c.max} ms，>20ms ${c.over20} 个`);
} else {
  console.log("\n（本次没捕到思考条目的折叠瞬间）");
}

const worst = [...records].sort((a, b) => b.dt - a.dt).slice(0, 10);
console.log("\n最差 10 帧的现场：");
for (const frame of worst) {
  console.log(`  ${String(frame.dt.toFixed(1)).padStart(7)}ms  滚动=${frame.scroll ? `是(${frame.delta})` : "否"}  clipped=${frame.clipped}  挂载=${frame.items}  末尾文本=${frame.text}  思考=${frame.thought}`);
}

const byId = new Map((profile?.nodes ?? []).map((node) => [node.id, node]));
const self = new Map();
const files = new Map();
let total = 0;
const deltas = profile?.timeDeltas ?? [];
const samples = profile?.samples ?? [];
for (let index = 0; index < samples.length; index += 1) {
  const node = byId.get(samples[index]);
  if (!node) continue;
  const ms = (deltas[index] ?? 0) / 1000;
  total += ms;
  const frame = node.callFrame ?? {};
  let url = String(frame.url ?? "");
  if (url.startsWith("file://")) url = url.slice(url.lastIndexOf("/") + 1);
  else if (url.includes("/src/")) url = url.slice(url.indexOf("/src/") + 1);
  const name = frame.functionName || "(anonymous)";
  self.set(`${name} @ ${url}:${(frame.lineNumber ?? -1) + 1}`, (self.get(`${name} @ ${url}:${(frame.lineNumber ?? -1) + 1}`) ?? 0) + ms);
  files.set(url || "(vm)", (files.get(url || "(vm)") ?? 0) + ms);
}
const fmt = (ms) => `${ms.toFixed(1)}ms (${((ms / (total || 1)) * 100).toFixed(1)}%)`;
console.log(`\nJS 自耗时排序（采样 ${total.toFixed(0)}ms）：`);
for (const [key, ms] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`  ${fmt(ms).padEnd(17)} ${key}`);
console.log("按文件：");
for (const [file, ms] of [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${fmt(ms).padEnd(17)} ${file}`);

const phases = new Map();
for (const event of traceEvents) {
  if (event.ph !== "X" || typeof event.dur !== "number") continue;
  phases.set(event.name, (phases.get(event.name) ?? 0) + event.dur / 1000);
}
const phaseTotal = [...phases.values()].reduce((sum, ms) => sum + ms, 0);
console.log(`\nBlink 阶段总时长 ${phaseTotal.toFixed(0)}ms：`);
for (const [name, ms] of [...phases.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${`${ms.toFixed(1)}ms (${((ms / (phaseTotal || 1)) * 100).toFixed(1)}%)`.padEnd(17)} ${name}`);
}

console.log("\nBlink 累计指标差值：");
for (const name of METRICS) {
  const delta = (metricsAfter[name] ?? 0) - (metricsBefore[name] ?? 0);
  console.log(`  ${name.padEnd(20)} ${name.endsWith("Duration") ? `${(delta * 1000).toFixed(0)}ms` : `${delta.toFixed(0)}`}`);
}

ws.close();
