import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";
import type { AgentHost } from "../src/main/agent-host";

export interface StopSmokeControls { settle: boolean; requests: string[] }

export async function testStopping(main: BrowserWindow, a: AgentHost, b: AgentHost, controls: StopSmokeControls, emit: (host: AgentHost, event: Record<string, unknown>) => void, select: (name: string) => Promise<void>, screenshot: (name: string) => Promise<void>, replies: Array<{ runtimeId: string; id: string }>) {
  const evaluate = <T = unknown>(code: string): Promise<T> => main.webContents.executeJavaScript(code, true);
  const wait = async (condition: () => Promise<unknown>, label: string, timeout = 12_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
    throw new Error(`Stopping: ${label}`);
  };
  emit(b, { type: "agent_start" });
  await select("B");
  await evaluate("document.querySelector('.prompt-input').focus()");
  await main.webContents.insertText("B 的草稿保留");
  emit(a, { type: "agent_start" });
  await select("A");
  await wait(() => evaluate("!!document.querySelector('.prompt-wrap .send.stop')"), "stop available");
  const clicked = performance.now();
  await evaluate("document.querySelector('.prompt-wrap .send.stop').click()");
  await wait(() => evaluate("document.querySelector('.stop-notice')?.textContent.includes('已请求取消')"), "immediate feedback", 1000);
  const feedbackMs = performance.now() - clicked;
  assert.ok(feedbackMs < 150, `feedback took ${feedbackMs} ms`);
  await wait(async () => controls.requests.includes(a.runtimeId), "abort request routed to A");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(a.isInTurn(), true);
  assert.equal(await evaluate("document.querySelector('.prompt-wrap .send.stop')?.disabled"), true);
  await evaluate("document.querySelector('.prompt-input').focus()");
  await main.webContents.insertText("停止期间仍能编辑");
  await wait(() => evaluate("!!document.querySelector('.stop-notice button')"), "ten-second next action");
  const timeoutMs = performance.now() - clicked;
  assert.ok(timeoutMs >= 9900 && timeoutMs < 12_000);
  await screenshot("stop-timeout.png");
  await evaluate("document.querySelector('.stop-notice button').click()");
  await wait(() => evaluate("!document.querySelector('.stop-notice') && !document.querySelector('.prompt-wrap .send.stop')"), "forced stop completes");
  assert.equal(b.isInTurn(), true, "B must keep running when A is forced to stop");
  assert.equal(await evaluate("document.querySelector('.prompt-input').textContent.includes('停止期间仍能编辑')"), true);
  await select("B");
  assert.equal(await evaluate("document.querySelector('.prompt-input').textContent.includes('B 的草稿保留')"), true);
  emit(b, { type: "extension_ui_request", id: "stop-question", method: "confirm", title: "停止询问", message: "取消应当关闭当前询问" });
  await wait(() => evaluate("document.querySelector('.approval')?.textContent.includes('取消应当关闭当前询问')"), "pending question");
  controls.settle = true;
  await evaluate("document.querySelector('.prompt-wrap .send.stop').click()");
  await wait(() => evaluate("!document.querySelector('.approval') && !document.querySelector('.stop-notice')"), "question cancelled and actual settled state received");
  assert.ok(replies.some((reply) => reply.runtimeId === b.runtimeId && reply.id === "stop-question"));
  assert.equal(b.isInTurn(), false);
  assert.equal(b.isRunning(), true, "graceful cancellation keeps the idle worker resumable");
  console.log(`Stop smoke passed: ${feedbackMs.toFixed(1)} ms feedback, ${timeoutMs.toFixed(1)} ms deadline, early acknowledgement stays stopping, force only targets A, drafts and B preserved, pending question cancelled, real settled event closes feedback.`);
}
