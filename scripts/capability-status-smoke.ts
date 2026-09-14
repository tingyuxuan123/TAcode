import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";
import type { AgentHost } from "../src/main/agent-host";
import type { AgentManager } from "../src/main/agent-manager";

export interface CapabilitySmokeControls {
  trusted: boolean;
  children: boolean;
  hold: boolean;
  release?: () => void;
  mcpError: string;
}

export async function testCapabilityStatus(main: BrowserWindow, manager: AgentManager, first: AgentHost, second: AgentHost,
  controls: CapabilitySmokeControls, starts: Map<string, number>, emit: (host: AgentHost, event: Record<string, unknown>) => void,
  select: (name: string) => Promise<void>, screenshot: (name: string) => Promise<void>) {
  const evaluate = <T = unknown>(code: string): Promise<T> => main.webContents.executeJavaScript(code, true);
  const wait = async (code: string, label: string) => {
    const until = Date.now() + 10_000;
    while (Date.now() < until) { if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error(`Capability status: ${label}; ${await evaluate("Array.from(document.querySelectorAll('.cap-runtime')).map(n => n.textContent).join('|')")}`);
  };
  const fill = async (text: string) => {
    await evaluate("document.querySelector('[contenteditable=true]').focus()");
    await main.webContents.insertText(text);
  };
  const visibleStatus = "Array.from(document.querySelectorAll('.cap-runtime')).find(n => n.getBoundingClientRect().width)";
  await select("A");
  await fill("A 的未发送草稿");
  const conversation = await evaluate<string>("document.querySelector('.conversation').textContent");
  await evaluate("document.querySelector('[aria-label=\"Skills / MCP\"]').click()");
  await wait(`${visibleStatus}?.dataset.state === 'loaded' && !!document.querySelector('.cap-trust')`, "untrusted running session state");
  emit(first, { type: "agent_start" });
  await evaluate("document.querySelector('.cap-trust button').click()");
  await wait("!!document.querySelector('.confirm-modal')", "trust confirmation");
  await evaluate("document.querySelector('.confirm-modal .primary').click()");
  await wait(`${visibleStatus}?.dataset.state === 'restart-required'`, "trust saved but not yet loaded");
  assert.equal(starts.get(first.runtimeId), 1);
  assert.equal(starts.get(second.runtimeId), 1);
  await evaluate(`${visibleStatus}.querySelector('button').click()`);
  await wait(`${visibleStatus}?.dataset.state === 'scheduled'`, "running task defers reload");
  controls.children = true;
  emit(first, { type: "agent_settled" });
  assert.equal(starts.get(first.runtimeId), 1);
  await screenshot("capabilities-scheduled.png");
  controls.hold = true;
  controls.children = false;
  manager.flushScheduledCapabilities(first.runtimeId);
  await wait(`${visibleStatus}?.dataset.state === 'reloading'`, "reload visible");
  assert.equal(await evaluate("document.querySelector('[contenteditable=true]').textContent"), "A 的未发送草稿");
  assert.equal(await evaluate("document.querySelector('.conversation').textContent"), conversation);
  await evaluate("Array.from(document.querySelectorAll('.project-row')).find(n => n.textContent.includes('other-project') && n.getAttribute('aria-expanded') !== 'true')?.click()");
  await select("B");
  await fill("B 的独立草稿");
  assert.ok(controls.release, "reload reached held startup");
  controls.release();
  await wait("document.querySelector('[contenteditable=true]').textContent === 'B 的独立草稿'", "other project draft stays intact");
  assert.equal(starts.get(second.runtimeId), 1);
  await select("A");
  await wait(`${visibleStatus}?.dataset.state === 'loaded' && ${visibleStatus}?.textContent.includes('1 个 Skills') && ${visibleStatus}?.textContent.includes('1 个 MCP')`, "actual session capability report");
  assert.equal(await evaluate("document.querySelector('[contenteditable=true]').textContent"), "A 的未发送草稿");
  assert.equal(starts.get(first.runtimeId), 2);
  await screenshot("capabilities-loaded.png");
  controls.mcpError = "fixture MCP connection failed";
  await first.readCapabilities(true);
  main.webContents.send("capabilities:runtime-changed", first.runtimeId);
  await wait(`${visibleStatus}?.textContent.includes('部分 MCP 连接失败')`, "partial failure is not reported as all tools ready");
  await evaluate(`${visibleStatus}.querySelector('summary').click()`);
  assert.ok(await evaluate(`${visibleStatus}.textContent.includes('fixture MCP connection failed')`));
  console.log("Capability status smoke passed: trust saved/restart required, running/child deferral, reload progress, actual loaded counts and MCP errors, session/project switch preserves both drafts and the other worker.");
}
