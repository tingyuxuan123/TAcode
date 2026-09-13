import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";

export interface PreviewSmokeControls { reads: number; fail: boolean; hold: boolean; maxBytes?: number; release?: () => void }

export async function testFilePreview(main: BrowserWindow, project: string, controls: PreviewSmokeControls, screenshot: (name: string) => Promise<void>) {
  const evaluate = <T = unknown>(script: string): Promise<T> => main.webContents.executeJavaScript(script, true);
  const wait = async (condition: () => Promise<unknown>, label: string, timeout = 6000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
    throw new Error(`File preview: ${label}`);
  };
  const content = Array.from({ length: 500 }, (_, i) => `Unique line ${i} 预览正文`).join("\n");
  await writeFile(path.join(project, "note.txt"), content);
  const body = "document.querySelector('[data-preview-path=\"note.txt\"] .file-panel-body')";
  const panel = "document.querySelector('[data-preview-path=\"note.txt\"]')";
  await wait(() => evaluate("!!document.querySelector('.project-row')"), "project");
  await evaluate("document.querySelector('.project-row').click()");
  await wait(() => evaluate("!!document.querySelector('.prompt-input')"), "composer");
  const openFiles = () => evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }))");
  await openFiles();
  await wait(() => evaluate("!!document.querySelector('.files-entry[title=\"note.txt\"]')"), "file entry");
  await evaluate("document.querySelector('.files-entry[title=\"note.txt\"]').click()");
  await wait(() => evaluate(`${body}?.textContent.includes('Unique line 499')`), "loaded");
  await evaluate(`(() => { const el = ${body}; const range = document.createRange(); range.selectNodeContents(el.querySelectorAll('.code-line > span')[120]); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); el.scrollTop = 900; })()`);
  const selected = await evaluate("getSelection().toString()");
  const before = performance.now();
  await writeFile(path.join(project, "note.txt"), `updated\n${content}`);
  await wait(() => evaluate(`${body}?.textContent.includes('updated')`), "automatic refresh", 1500);
  const refreshMs = performance.now() - before;
  assert.ok(refreshMs < 1100, `refresh took ${refreshMs} ms`);
  assert.equal(await evaluate(`${body}.scrollTop`), 900);
  assert.equal(await evaluate("getSelection().toString()"), selected);
  await screenshot("file-preview-refreshed.png");
  const calls = controls.reads;
  await writeFile(path.join(project, "unrelated.txt"), "unrelated");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(controls.reads, calls);

  await openFiles();
  await wait(() => evaluate(`${panel}.closest('.child-session-host').style.display === 'none'`), "hidden");
  const hiddenCalls = controls.reads;
  await writeFile(path.join(project, "note.txt"), "hidden update");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(controls.reads, hiddenCalls);
  await evaluate("document.querySelector('.files-entry[title=\"note.txt\"]').click()");
  await wait(() => evaluate(`${body}?.textContent.includes('hidden update')`), "activation refresh");

  controls.hold = true;
  await writeFile(path.join(project, "note.txt"), "stale response");
  await wait(async () => !!controls.release, "held read");
  await writeFile(path.join(project, "note.txt"), "latest response");
  await wait(() => evaluate(`${body}?.textContent.includes('latest response')`), "latest response");
  controls.release!();
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert.equal(await evaluate(`${body}.textContent.includes('stale response')`), false);

  await unlink(path.join(project, "note.txt"));
  await wait(() => evaluate(`${panel}.textContent.includes('文件已删除或不存在')`), "deleted status");
  assert.equal(await evaluate(`${body}.textContent`), "");
  await writeFile(path.join(project, "note.txt"), "");
  await wait(() => evaluate(`${panel}.textContent.includes('这是一个空文件')`), "empty status");
  controls.fail = true;
  await writeFile(path.join(project, "note.txt"), "retry content");
  await wait(() => evaluate(`!!${panel}.querySelector('[role=alert]')`), "error status");
  controls.fail = false;
  await evaluate(`${panel}.querySelector('[role=alert] button').click()`);
  await wait(() => evaluate(`${body}.textContent.includes('retry content') && !${panel}.querySelector('[role=alert]')`), "retry");

  const large = "x".repeat(5000);
  controls.maxBytes = 4096;
  await writeFile(path.join(project, "note.txt"), large);
  await wait(() => evaluate(`${panel}.textContent.includes('文件较大，仅显示开头')`), "truncation status");
  await evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copiedPreview = text; } } })");
  await evaluate(`${panel}.querySelector('button[aria-label=复制]').click()`);
  assert.equal(await evaluate("window.__copiedPreview"), large.slice(0, 4096));
  console.log(`File preview smoke passed: ${refreshMs.toFixed(1)} ms saved-file refresh, scroll/selection, hidden activation, stale response, delete/empty/retry, body-only truncated copy.`);
}
