/**
 * 滚动抖动探针：等真实流式开始后，按帧记录 `scrollTop` / `scrollHeight`，
 * 在中途把滚动容器的 `overflow-anchor` 切成 `none`，同一段流式里做前后对比。
 *
 * 判据：跟随中内容只增长，理想的 `scrollTop` 应当单调不减。出现回退（逆向移动）
 * 就是「滚动条抖动」——那说明有别的写入者（浏览器滚动锚定 / 虚拟列表位移补偿）
 * 在和我们抢同一帧的位置。
 *
 * 用法：node scripts/scroll-jitter.mjs [--wait] [每段秒数]
 *   --wait 时先等流式开始（默认等 5 分钟）。
 */

const endpoint = process.env.TACODE_CDP ?? "http://127.0.0.1:9222";
const perPhase = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? 12);
const waitForStream = process.argv.includes("--wait");

const targets = await (await fetch(`${endpoint}/json/list`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("没有找到页面目标（先跑 pnpm dev:attach）");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
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
  if (result?.exceptionDetails) {
    console.log(`表达式中抛出：${result.exceptionDetails.exception?.description?.split("\n")[0] ?? "?"}`);
  }
  return result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SAMPLER = `(() => {
  const state = { records: [], stop: false, last: 0, writes: [] };
  window.__jitterProbe = state;
  // 挂钩 scrollTop 写入者：JS 侧的写入都会经过它的 setter，浏览器的滚动锚定不会。
  // 于是「帧上看到回退、但没有对应写入」就等于锚定在动手。
  const box = document.querySelector(".conversation");
  try {
  if (box && !box.__jitterHooked) {
    box.__jitterHooked = true;
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(box, "scrollTop", {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) {
        const before = descriptor.get.call(this);
        if (value < before - 0.5) {
          const stack = String(new Error().stack || "").split("\\n").slice(2, 5).join(" <- ");
          state.writes.push({ delta: Math.round(value - before), stack });
        }
        descriptor.set.call(this, value);
      },
    });
  }
  } catch (error) { state.hookError = String(error); }
  const tick = () => {
    if (state.stop) return;
    const now = performance.now();
    const box = document.querySelector(".conversation");
    if (box && state.last) {
      const thought = (document.querySelector(".flow-thought-text:not(.clipped)")?.textContent ?? "").length;
      const previousThought = state.lastThought ?? 0;
      if (thought > previousThought) state.growth = (state.growth ?? 0) + 1;
      state.lastThought = thought;
      state.records.push({
        dt: now - state.last,
        top: box.scrollTop,
        height: box.scrollHeight,
        client: box.clientHeight,
        anchor: getComputedStyle(box).overflowAnchor,
        thought: (document.querySelector(".flow-thought-text:not(.clipped)")?.textContent ?? "").length,
        visible: document.visibilityState,
      });
    }
    state.last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return "ok";
})()`;

if (process.argv.includes("--inject")) {
  await evaluate("if (window.__jitterProbe) window.__jitterProbe.stop = true;");
// 清掉历史上可能残留的内联覆盖，保证测到的是 CSS 里的真实状态。
await evaluate("document.querySelector('.conversation')?.style.removeProperty('overflow-anchor')");
  const raw = await send("Runtime.evaluate", { expression: SAMPLER, returnByValue: true });
  console.log("注入结果：", JSON.stringify(raw.result ?? {}), "异常：", raw.exceptionDetails ? JSON.stringify(raw.exceptionDetails).slice(0, 400) : "无");
  const frames = await evaluate("setTimeout(() => {}, 0), JSON.stringify({ records: window.__jitterProbe?.records?.length ?? -1, hook: window.__jitterProbe?.hookError ?? null })");
  console.log("状态：", frames);
  ws.close();
  process.exit(0);
}

if (process.argv.includes("--clean")) {
  const computed = await evaluate(`(() => {
    const box = document.querySelector(".conversation");
    if (!box) return "没有找到 .conversation";
    box.style.overflowAnchor = "";
    return getComputedStyle(box).overflowAnchor;
  })()`);
  console.log(`已清除内联覆盖，当前计算样式 overflow-anchor = ${computed}`);
  ws.close();
  process.exit(0);
}

if (waitForStream) {
  process.stdout.write("等待流式开始（在窗口里发一条消息）…\n");
  const deadline = Date.now() + Number(process.env.TACODE_WATCH_TIMEOUT_MS ?? 300_000);
  let previous = -1;
  while (Date.now() < deadline) {
    const raw = await evaluate(`(() => {
      const live = document.querySelector(".flow-thought-text:not(.clipped)");
      return JSON.stringify({ live: Boolean(live), text: (live?.textContent ?? "").length });
    })()`);
    const state = JSON.parse(raw || "{}");
    if (!state.live) previous = -1;
    else if (previous >= 0 && state.text > previous + 40) break;
    else previous = state.text;
    await sleep(400);
  }
  console.log("检测到流式，开始记录");
}

/** 一段采样：返回该段的帧记录。 */
async function phase(label) {
  await evaluate("window.__jitterProbe.records = []; window.__jitterProbe.writes = []; window.__jitterProbe.last = 0; window.__jitterProbe.growth = 0; window.__jitterProbe.lastThought = 0;");
  // 等到真正采到「出字增长」的帧为止（最多等 4 分钟），否则再长的窗口也可能全落在间隙里。
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    if ((await evaluate("typeof window.__jitterProbe")) !== "object") {
      await evaluate("if (window.__jitterProbe) window.__jitterProbe.stop = true;");
      await evaluate(SAMPLER);
      await evaluate("document.querySelector('.conversation')?.style.removeProperty('overflow-anchor')");
    }
    const growth = await evaluate("window.__jitterProbe && window.__jitterProbe.growth || 0");
    if ((growth ?? 0) >= perPhase * 45) break;
  }
  const raw = await evaluate("JSON.stringify({ records: window.__jitterProbe?.records ?? [], writes: window.__jitterProbe?.writes ?? [], anchor: (() => { const box = document.querySelector('.conversation'); return box ? getComputedStyle(box).overflowAnchor : '?'; })() })");
  const parsed = JSON.parse(raw || "{}");
  return { label, anchor: parsed.anchor, records: parsed.records ?? [], writes: parsed.writes ?? [] };
}

/** 只保留「思考文本在增长」的帧：出字期间的抖动看这一段。 */
function growthFrames(frames) {
  const out = [];
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const current = frames[index];
    if (current.thought > previous.thought || (current.thought > 0 && current.top > previous.top)) out.push({ previous, current });
  }
  return out;
}

/** 内容变矮的帧（折叠/收起）。 */
function shrinkFrames(frames) {
  return frames.filter((frame, index) => index > 0 && frame.height < frames[index - 1].height - 2);
}

function analyze(phaseResult) {
  const frames = phaseResult.records;
  let backward = 0;
  let backwardPx = 0;
  let maxBackward = 0;
  let directionChanges = 0;
  let lastDirection = 0;
  let trailing = 0;
  let trailingFrames = 0;
  for (let index = 1; index < frames.length; index += 1) {
    const delta = frames[index].top - frames[index - 1].top;
    if (delta < -0.5) {
      backward += 1;
      backwardPx += -delta;
      maxBackward = Math.max(maxBackward, -delta);
    }
    if (Math.abs(delta) > 0.5) {
      const direction = Math.sign(delta);
      if (lastDirection !== 0 && direction !== lastDirection) directionChanges += 1;
      lastDirection = direction;
    }
    const gap = frames[index].height - frames[index].client - frames[index].top;
    trailing += gap;
    if (gap > 2) trailingFrames += 1;
  }
  const growth = growthFrames(frames);
  let growthBackward = 0;
  let growthBackwardPx = 0;
  let growthMaxBackward = 0;
  let growthTrailing = 0;
  for (const { previous, current } of growth) {
    const delta = current.top - previous.top;
    if (delta < -0.5) {
      growthBackward += 1;
      growthBackwardPx += -delta;
      growthMaxBackward = Math.max(growthMaxBackward, -delta);
    }
    growthTrailing += current.height - current.client - current.top;
  }
  const shrink = shrinkFrames(frames);
  return {
    anchor: phaseResult.anchor,
    growthFrames: growth.length,
    growthBackward,
    growthBackwardPx: Number(growthBackwardPx.toFixed(1)),
    growthMaxBackward: Number(growthMaxBackward.toFixed(1)),
    growthTrailingAvg: Number((growthTrailing / Math.max(1, growth.length)).toFixed(1)),
    shrinkEvents: shrink.length,
    shrinkTotal: Number(shrink.reduce((sum, frame, index) => sum + (frames[index] ? 0 : 0), 0).toFixed(0)),
    visibility: frames.length ? frames[0].visible : "?",
    frames: frames.length,
    backward,
    backwardPx: Number(backwardPx.toFixed(1)),
    maxBackward: Number(maxBackward.toFixed(1)),
    directionChanges,
    trailingAvg: Number((trailing / Math.max(1, frames.length)).toFixed(1)),
    trailingFrames,
    grew: frames.length ? Number((frames.at(-1).height - frames[0].height).toFixed(0)) : 0,
  };
}

await evaluate("if (window.__jitterProbe) window.__jitterProbe.stop = true;");
// 清掉历史上可能残留的内联覆盖，保证测到的是 CSS 里的真实状态。
await evaluate("document.querySelector('.conversation')?.style.removeProperty('overflow-anchor')");
const injected = await evaluate(SAMPLER);
console.log(`注入采样器：${injected}`);
const hookError = await evaluate("window.__jitterProbe.hookError ?? '无'");
if (hookError !== "无") console.log(`写入挂钩失败（不影响帧统计）：${hookError}`);

const before = await phase("当前代码");
if (process.argv.includes("--ab")) {
  // 反向对照：临时内联还原成 auto（会覆盖 CSS），测完记得用 --clean 清掉。
  await evaluate(`document.querySelector('.conversation').style.overflowAnchor = 'auto'`);
  const after = await phase("临时还原 overflow-anchor: auto");
  show(analyze(after), after);
} else {
  console.log("（只测当前状态；要反向对照加 --ab，测完用 --clean 清除内联覆盖）");
}

const show = (stats, phaseResult) => {
  console.log(`\n【${stats.anchor}】${stats.frames} 帧，可见性 ${stats.visibility}，内容净变化 ${stats.grew}px`);
  console.log(`  出字增长段 ${stats.growthFrames} 帧：逆向移动 ${stats.growthBackward} 次（合计 ${stats.growthBackwardPx}px，最大 ${stats.growthMaxBackward}px），距底平均 ${stats.growthTrailingAvg}px`);
  console.log(`  内容变矮的帧 ${stats.shrinkEvents} 个（折叠/收起）`);
  console.log(`  帧上逆向移动 ${stats.backward} 次（合计 ${stats.backwardPx}px，最大单次 ${stats.maxBackward}px），方向翻转 ${stats.directionChanges} 次`);
  console.log(`  距底平均 ${stats.trailingAvg}px，>2px 的帧 ${stats.trailingFrames} 个`);
  const writes = phaseResult.writes ?? [];
  console.log(`  JS 侧回退写入 ${writes.length} 次${writes.length ? `（合计 ${writes.reduce((sum, item) => sum + item.delta, 0)}px，最大 ${Math.min(...writes.map((item) => item.delta))}px）` : ""}`);
  const byCaller = new Map();
  for (const write of writes) {
    const caller = (write.stack.split(" <- ")[0] ?? "?").replace(/https?:\/\/127\.0\.0\.1:5177/g, "").trim();
    byCaller.set(caller, (byCaller.get(caller) ?? 0) + 1);
  }
  for (const [caller, count] of [...byCaller.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`     ×${count}  ${caller}`);
  }
  if (stats.backward > writes.length) {
    console.log(`  → 帧上多出的 ${stats.backward - writes.length} 次回退没有对应 JS 写入：来自浏览器滚动锚定`);
  }
};
show(analyze(before), before);

ws.close();
