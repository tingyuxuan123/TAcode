import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { DelegationRecordSnapshot } from "../src/shared/delegation";

export function createPanelFixture(project: string, parent: string) {
  const now = Date.now();
  const records: DelegationRecordSnapshot[] = Array.from({ length: 3 }, (_, i) => ({
    delegationId: `performance-${i}`, parentSessionPath: parent, childSessionPath: path.join(project, `child-${i}.jsonl`),
    title: `性能子会话 ${i + 1}`, role: "explorer", task: `性能子会话 ${i + 1}`, permission: "auto", status: "running", startedAt: now,
  }));
  const messages = new Map<string, unknown[]>();
  for (const file of [parent, ...records.map((item) => item.childSessionPath!)]) messages.set(file, Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: i % 2 ? `历史回答 ${i}。**检查结果**：内容保留，支持继续阅读。` : `历史问题 ${i}` }], timestamp: now - 100_000 + i, stopReason: "stop",
  })));
  return { records, messages, now };
}

export async function testPanelPerformance(main: BrowserWindow, parent: string, fixture: ReturnType<typeof createPanelFixture>, emitMain: (event: Record<string, unknown>) => void, screenshot: (name: string) => Promise<void>) {
  const evaluate = <T = unknown>(script: string): Promise<T> => main.webContents.executeJavaScript(script, true);
  const wait = async (condition: () => Promise<unknown>, label: string, timeout = 15_000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
    throw new Error(`Panel performance: ${label}`);
  };
  await wait(() => evaluate("document.querySelectorAll('.child-session-panel').length === 3"), "three child panels");
  await wait(() => evaluate("Array.from(document.querySelectorAll('.child-session-panel')).filter(el => el.offsetParent !== null).every(el => el.textContent.includes('历史回答 199'))"), "initial transcripts");
  const emit = (index: number, event: Record<string, unknown>) => index < 0 ? emitMain(event) : main.webContents.send("delegations:agent-event", { delegationId: fixture.records[index].delegationId, event });
  const files = [parent, ...fixture.records.map((item) => item.childSessionPath!)];
  const streams = files.map((file, i) => ({ file, index: i - 1, timestamp: fixture.now + 1000 + i, text: "" }));
  for (const stream of streams) {
    const user = { role: "user", content: [{ type: "text", text: "开始固定速率回放" }], timestamp: stream.timestamp - 1 };
    emit(stream.index, { type: "agent_start" });
    emit(stream.index, { type: "message_start", message: user });
    fixture.messages.set(stream.file, [...fixture.messages.get(stream.file)!, user]);
  }
  await evaluate(`(() => {
    window.__tacodePerf = { commits: [], longTasks: [], mutations: {} };
    window.__perfObserver = new PerformanceObserver(list => window.__tacodePerf.longTasks.push(...list.getEntries().map(entry => entry.duration)));
    window.__perfObserver.observe({ type: 'longtask' });
    window.__mutationObserver = new MutationObserver(records => { for (const record of records) { const node = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement; const panel = node?.closest('.child-session-panel'); const task = panel?.querySelector('.child-session-task')?.textContent; if (task) window.__tacodePerf.mutations[task] = (window.__tacodePerf.mutations[task] || 0) + 1; } });
    document.querySelectorAll('.child-session-flow').forEach(el => window.__mutationObserver.observe(el, { subtree: true, childList: true, characterData: true }));
    document.querySelector('.prompt-input').focus();
  })()`);
  main.focus(); main.webContents.focus();
  const inputs: number[] = [];
  const started = performance.now();
  let ticks = 0;
  let inputJob: Promise<void> | undefined;
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      ticks++;
      for (const stream of streams) {
        stream.text = `流式回放 ${stream.index + 1} · ${ticks}\n\n` + "正文追加。".repeat(ticks);
        emit(stream.index, { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: stream.text }], timestamp: stream.timestamp } });
      }
      if (ticks % 12 === 0 && !inputJob) {
        const begin = performance.now();
        inputJob = (async () => {
          await main.webContents.insertText("测");
          await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
          inputs.push(performance.now() - begin);
        })().finally(() => { inputJob = undefined; });
      }
      if (ticks === 180) { clearInterval(timer); resolve(); }
    }, 1000 / 60);
  });
  await inputJob;
  await wait(() => evaluate("Array.from(document.querySelectorAll('.child-session-panel')).filter(el => el.offsetParent !== null).every(el => el.textContent.includes('· 180'))"), "visible final delta");
  const report = await evaluate<{ commits: Array<{ id: string; duration: number }>; longTasks: number[]; mutations: Record<string, number> }>("window.__perfObserver.disconnect(); window.__mutationObserver.disconnect(); window.__tacodePerf");
  await evaluate("window.__tacodePerf = undefined");
  const durationMs = performance.now() - started;
  const percentile = (values: number[], ratio: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * ratio))] ?? 0;
  const profiles = Object.fromEntries([...new Set(report.commits.map((commit) => commit.id))].map((id) => {
    const durations = report.commits.filter((commit) => commit.id === id).map((commit) => commit.duration);
    return [id, { commits: durations.length, renderMs: durations.reduce((a, b) => a + b, 0), p95Ms: percentile(durations, 0.95), maxMs: Math.max(0, ...durations) }];
  }));
  const measurement = { baseline: process.env.TACODE_ACTIVITY_BASELINE === "1", historyTurnsPerStream: 100, streamCount: 4, targetEventsPerSecondPerStream: 60, ticks, durationMs, inputSamples: inputs, inputP95Ms: percentile(inputs, 0.95), inputMaxMs: Math.max(...inputs), longTasks: report.longTasks, profiles, mutations: report.mutations };
  if (process.env.TACODE_PANEL_REPORT) await writeFile(process.env.TACODE_PANEL_REPORT, JSON.stringify(measurement, null, 2) + "\n");
  console.log("PANEL_RESULT " + JSON.stringify(measurement));

  for (const stream of streams) {
    const assistant = { role: "assistant", content: [{ type: "text", text: stream.text }], timestamp: stream.timestamp, stopReason: "stop" };
    fixture.messages.set(stream.file, [...fixture.messages.get(stream.file)!, assistant]);
    emit(stream.index, { type: "message_end", message: assistant });
    emit(stream.index, { type: "agent_settled" });
  }
  const selectChild = async (i: number) => {
    const label = fixture.records[i].task;
    await evaluate(`Array.from(document.querySelectorAll('[role=tab]')).find(el => el.textContent.includes(${JSON.stringify(label)})).click()`);
    await wait(() => evaluate(`Array.from(document.querySelectorAll('.child-session-panel')).some(el => el.offsetParent !== null && el.textContent.includes('流式回放 ${i + 1} · 180'))`), "hidden content restored");
  };
  for (let i = 0; i < 3; i++) await selectChild(i);
  if (process.env.TACODE_ACTIVITY_BASELINE !== "1") assert.ok(await evaluate<number>("document.querySelectorAll('.child-session-flow .user-turn').length") < 100, "child history should be virtualized");
  fixture.records[0] = { ...fixture.records[0], uiRequest: { id: "perf-approval", method: "confirm", title: "性能确认", message: "隐藏面板的审批仍然可见" } };
  main.webContents.send("delegations:event", fixture.records[0]);
  await wait(() => evaluate("Array.from(document.querySelectorAll('.child-session-panel')).some(el => el.offsetParent !== null && el.textContent.includes('隐藏面板的审批仍然可见'))"), "approval is immediately visible");
  fixture.records[1] = { ...fixture.records[1], status: "failed", error: "fixture child failed", completedAt: Date.now() };
  fixture.records[2] = { ...fixture.records[2], status: "completed", completedAt: Date.now() };
  main.webContents.send("delegations:event", fixture.records[1]);
  main.webContents.send("delegations:event", fixture.records[2]);
  await selectChild(1);
  await wait(() => evaluate("Array.from(document.querySelectorAll('.child-session-panel')).some(el => el.offsetParent !== null && el.textContent.includes('fixture child failed'))"), "failure preserved");
  await selectChild(2);
  await wait(() => evaluate("Array.from(document.querySelectorAll('.child-session-panel')).some(el => el.offsetParent !== null && !el.querySelector('.child-session-stop'))"), "completion preserved");
  await screenshot("multiple-chat-panels.png");
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, altKey: true }))");
  await wait(() => evaluate("!!document.querySelector('.side-chat-composer textarea')"), "side chat composer");
  await evaluate("document.querySelector('.side-chat-composer textarea').focus()");
  await main.webContents.insertText("验证侧聊合批");
  await evaluate("document.querySelector('.side-chat-composer').requestSubmit()");
  await wait(() => evaluate("document.querySelector('.side-chat-body').textContent.includes('流式回放 0 · 180')"), "side chat snapshot");
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }))");
  await wait(() => evaluate("document.querySelector('.side-chat-panel').offsetParent === null"), "side chat hidden");
  const sideEvent = (event: Record<string, unknown>) => main.webContents.send("side-chat:event", { ...event, __runtimeId: "perf-side" });
  sideEvent({ type: "message_start", message: { role: "user", content: "侧聊问题", timestamp: fixture.now + 5000 } });
  for (let i = 0; i < 100; i++) sideEvent({ type: "message_update", message: { role: "assistant", content: `侧聊正文 ${i}`, timestamp: fixture.now + 5001 } });
  sideEvent({ type: "agent_settled" });
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, altKey: true }))");
  await wait(() => evaluate("document.querySelector('.side-chat-body').textContent.includes('侧聊正文 99')"), "side chat content restored");
  console.log("Panel smoke passed: four fixed-rate streams, hidden content on activation, virtualized history, approval/failure/completion.");
}
