/**
 * 消息列表性能探针：在真实 Electron 窗口里跑生产组件链路
 * （MessageList + useFollowScroll + AssistantTurn，StrictMode，150 轮历史），
 * 量三件事，给「运行中卡 / 滚动不丝滑」的修复做前后对比：
 *
 *   A. 流式增长（模拟落字）：跟随底部时逐帧 grow() 尾轮内容。
 *      判据：帧间隔 p50/p95/max、scrollTop 逆向移动（跟随中被反向补偿=抖动）。
 *   B. 历史滚动：合成滚轮手势向上翻历史。
 *      判据：帧间隔 p50/p95/max、挂载条目数（窗口化是否生效）。
 *   C. 锚点跳转：跳到最早一轮再回底部。
 *      判据：落点误差收敛帧数、跳转后的位置修正幅度。
 *
 * 用法：node scripts/message-list-perf.mjs [轮数=150]
 */

import { build as buildRenderer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import electron from "electron";

const turns = Number(process.argv[2] ?? 150) || 150;
const output = await mkdtemp(path.join(tmpdir(), "tacode-message-list-perf-"));

/** Electron 主进程脚本：加载 fixture、注入采样器、跑三个场景、回传 JSON。 */
const main = `
import { app, BrowserWindow } from "electron";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function run() {
app.on("window-all-closed", () => {});
await app.whenReady();
const profile = await mkdtemp(path.join(tmpdir(), "tacode-perf-profile-"));
app.setPath("userData", profile);

const fixture = process.env.TACODE_MESSAGE_LIST_FIXTURE;
const window = new BrowserWindow({
  width: 1120, height: 780, show: false,
  webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
});

window.webContents.on("console-message", (event, ...rest) => {
  const message = typeof event === "object" && event !== null && "message" in event ? event.message : rest[0];
  if (typeof message === "string" && message.trim()) console.error("[renderer]", message.slice(0, 300));
});
const evaluate = (script) => window.webContents.executeJavaScript(script, true);
await window.loadFile(fixture, { query: { turns: "${turns}" } });
console.error("[step] page loaded");
for (let i = 0; i < 200; i++) {
  if (await evaluate("Boolean(window.__messageListFixture && document.querySelector('.conversation'))").catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 50));
  if (i === 199) { console.error("fixture 未就绪"); app.exit(1); }
}
console.error("[step] fixture ready");

const SAMPLER = \`(() => {
  const state = { records: [], stop: false, last: 0, lastTop: 0, reversals: [], lastWrites: [] };
  window.__perfState = state;
  const box = document.querySelector('.conversation');
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(box, 'scrollTop', {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(value) {
      const before = descriptor.get.call(this);
      if (value < before - 0.5) {
        const stack = String(new Error().stack || '').split(String.fromCharCode(10)).slice(2, 4).join(' <- ');
        state.lastWrites.push({ delta: Math.round(value - before), stack });
      }
      descriptor.set.call(this, value);
    },
  });
  const tick = () => {
    if (state.stop) return;
    const now = performance.now();
    if (state.last) {
      const top = box.scrollTop;
      state.records.push({ dt: now - state.last, top, height: box.scrollHeight });
      if (top < state.lastTop - 0.5) state.reversals.push({ at: now, px: Math.round(state.lastTop - top) });
      state.lastTop = top;
    }
    state.last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 'ok';
})()\`;

const reset = () => evaluate("window.__perfState.records = []; window.__perfState.reversals = []; window.__perfState.last = 0; window.__perfState.lastWrites = []; window.__perfState.lastTop = document.querySelector('.conversation').scrollTop;");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scrollScenario() {
  // 从底部向上翻 6 秒，滚轮手势打在滚动容器上。
  const box = JSON.parse(await evaluate(\`(() => { const r = document.querySelector('.conversation').getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); })()\`));
  let direction = -1;
  const timer = setInterval(() => {
    window.webContents.sendInputEvent({ type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: direction * 480 });
  }, 300);
  await sleep(6000);
  clearInterval(timer);
}

async function growScenario() {
  // 模拟流式：每 ~33ms 长出一小段内容（真实落字节奏），持续 8 秒。
  const start = Date.now();
  while (Date.now() - start < 8000) {
    await evaluate("window.__messageListFixture.grow(); 'ok'");
    await sleep(33);
  }
  await sleep(1200);
}

const quantile = (values, q) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.round((sorted.length - 1) * q))].toFixed(1));
};
const summarize = async (label) => {
  const raw = await evaluate("window.__perfState.stop ? '{}' : JSON.stringify({ records: window.__perfState.records, reversals: window.__perfState.reversals, writes: window.__perfState.lastWrites })");
  const state = JSON.parse(raw);
  const dts = state.records.map((r) => r.dt);
  const out = {
    label,
    frames: dts.length,
    p50: quantile(dts, 0.5),
    p95: quantile(dts, 0.95),
    max: dts.length ? Number(Math.max(...dts).toFixed(1)) : 0,
    over20: dts.filter((d) => d > 20).length,
    reversals: state.reversals.length,
    reversalPx: state.reversals.reduce((sum, r) => sum + r.px, 0),
    maxReversal: state.reversals.length ? Math.max(...state.reversals.map((r) => r.px)) : 0,
    writeReversals: (state.writes ?? []).length,
  };
  out.reversalSamples = (state.reversals ?? []).slice(-5).map((r) => r.px);
  return out;
};

const step = (m) => console.error("[step]", m);
step("sampler") ; await evaluate(SAMPLER);
step("reset+grow"); await reset();
await growScenario();
const streaming = await summarize("streaming-grow");

// 流式结束后回到底部，再量滚动。
step("scroll"); await evaluate("document.querySelector('.conversation').scrollTop = 1e9; 'ok'");
await sleep(600);
await reset();
await scrollScenario();
const scrolling = await summarize("history-scroll");

// 锚点跳转：跳到最早一轮（smooth=false），量逐帧位置修正。
step("jump"); await reset();
await evaluate("window.__perfState.records = []; window.__perfState.reversals = []; window.__perfState.lastWrites = []; 'ok'");
await evaluate("window.__messageListFixture.scrollToAnchor('turn-user-0'); 'ok'");
await sleep(2500);
const jump = await summarize("anchor-jump");
const jumpError = await evaluate(\`(() => {
  const box = document.querySelector('.conversation');
  const node = document.getElementById('turn-user-0');
  if (!node) return -1;
  return Math.round(node.getBoundingClientRect().top - box.getBoundingClientRect().top);
})()\`);

// 重开（reload）后再跳同一锚点：已测高度缓存生效的第二趟，收敛应明显更快更稳。
await window.loadFile(fixture, { query: { turns: "${turns}" } });
console.error("[step] reopened");
for (let i = 0; i < 200; i++) {
  if (await evaluate("Boolean(window.__messageListFixture && document.querySelector('.conversation'))").catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 50));
}
await evaluate(SAMPLER);
await reset();
await evaluate("window.__messageListFixture.scrollToAnchor('turn-user-0'); 'ok'");
await sleep(2500);
const jumpReopen = await summarize("anchor-jump-reopen");
const jumpReopenError = await evaluate(\`(() => {
  const box = document.querySelector('.conversation');
  const node = document.getElementById('turn-user-0');
  if (!node) return -1;
  return Math.round(node.getBoundingClientRect().top - box.getBoundingClientRect().top);
})()\`);
const mounted = await evaluate("document.querySelectorAll('.message-item').length");

console.log("PERF_JSON:" + JSON.stringify({ streaming, scrolling, jump, jumpError, jumpReopen, jumpReopenError, mounted }));
console.error("[step] done");
await evaluate("window.__perfState.stop = true");
if (process.env.TACODE_BROWSER_ARTIFACTS) {
  const image = await window.webContents.capturePage();
  await writeFile(path.join(process.env.TACODE_BROWSER_ARTIFACTS, "message-list-perf.png"), image.toPNG());
}
app.exit(0);
}

run().catch((error) => { console.error(error); app.exit(1); });
`;

try {
  await buildRenderer({
    configFile: false,
    plugins: [react()],
    base: "./",
    logLevel: "warn",
    build: {
      outDir: path.join(output, "renderer"),
      emptyOutDir: true,
      rollupOptions: { input: path.resolve("scripts/fixtures/message-list.html") },
    },
  });
  const mainFile = path.join(output, "perf-main.mjs");
  await writeFile(mainFile, main);
  const env = {
    ...process.env,
    TACODE_MESSAGE_LIST_FIXTURE: path.join(output, "renderer/scripts/fixtures/message-list.html"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(electron, [mainFile], { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(output, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
}
