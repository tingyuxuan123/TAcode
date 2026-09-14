import assert from "node:assert/strict";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";

export interface PreviewSmokeControls { reads: number; fail: boolean; hold: boolean; maxBytes?: number; release?: () => void }

/** Real App acceptance for the unified document panel; detailed selection/tab QA has its own native fixture. */
export async function testFilePreview(main: BrowserWindow, project: string, controls: PreviewSmokeControls, screenshot: (name: string) => Promise<void>) {
  const evaluate = <T = unknown>(script: string): Promise<T> => main.webContents.executeJavaScript(script, true);
  const wait = async (condition: () => Promise<unknown>, label: string, timeout = 6000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
    throw new Error(`File document: ${label}`);
  };
  const panel = "document.querySelector('[data-file-path=\"note.txt\"]')";
  const body = `${panel}?.querySelector('.cm-scroller')`;
  const content = Array.from({ length: 500 }, (_, i) => `Unique line ${i} 文件正文`).join("\n");
  await writeFile(path.join(project, "note.txt"), content);
  await wait(() => evaluate("!!document.querySelector('.project-row')"), "project");
  await evaluate("document.querySelector('.project-row').click()");
  await wait(() => evaluate("!!document.querySelector('.prompt-input')"), "composer");
  const openFiles = () => evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }))");
  const openNote = () => evaluate("[...document.querySelectorAll('[data-tree-path=\"note.txt\"]')].find(el=>el.getBoundingClientRect().width>0).click()");
  await openFiles(); await wait(() => evaluate("!!document.querySelector('[data-tree-path=\"note.txt\"]')"), "tree entry"); await openNote();
  await wait(() => evaluate(`${body}?.textContent.includes('Unique line 0')`), "loaded");
  await evaluate(`(()=>{const el=${body};el.scrollTop=900})()`); await wait(() => evaluate(`${body}.scrollTop===900`), "scrolled");
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  const initialTop = await evaluate<number>(`${body}.scrollTop`);
  const before = performance.now(); await writeFile(path.join(project, "note.txt"), content.replaceAll("Unique", "Edited"));
  await wait(() => evaluate(`${body}?.textContent.includes('Edited line')`), "automatic refresh", 2000);
  await wait(() => evaluate(`${body}.scrollTop===${initialTop}`), "settled scroll position", 1500);
  const refreshMs = performance.now() - before; assert.ok(refreshMs < 1100, `refresh took ${refreshMs} ms`); assert.equal(await evaluate(`${body}.scrollTop`), initialTop);
  await screenshot("file-document-refreshed.png");
  const calls = controls.reads; await writeFile(path.join(project, "unrelated.txt"), "unrelated"); await new Promise((resolve) => setTimeout(resolve, 400)); assert.equal(controls.reads, calls);
  await openFiles(); await wait(() => evaluate(`${panel}.dataset.fileActive==='false'`), "hidden");
  const hiddenCalls = controls.reads; await writeFile(path.join(project, "note.txt"), "hidden update"); await new Promise((resolve) => setTimeout(resolve, 400)); assert.equal(controls.reads, hiddenCalls);
  await openNote(); await wait(() => evaluate(`${body}?.textContent.includes('hidden update')`), "activation refresh");
  controls.hold = true; await writeFile(path.join(project, "note.txt"), "stale response"); await wait(async () => !!controls.release, "held read");
  await writeFile(path.join(project, "note.txt"), "latest response"); await wait(() => evaluate(`${body}?.textContent.includes('latest response')`), "latest response");
  controls.release!(); controls.release = undefined; await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"); assert.equal(await evaluate(`${body}.textContent.includes('stale response')`), false);
  await unlink(path.join(project, "note.txt")); await wait(() => evaluate(`${panel}.textContent.includes('文件已删除或不存在')`), "deleted"); assert.equal(await evaluate(`!!${panel}.querySelector('.cm-editor')`), false);
  await writeFile(path.join(project, "note.txt"), ""); await wait(() => evaluate(`${panel}.textContent.includes('这是一个空文件')`), "empty");
  controls.fail = true; await writeFile(path.join(project, "note.txt"), "retry content"); await wait(() => evaluate(`!!${panel}.querySelector('[role=alert]')`), "error");
  controls.fail = false; await evaluate(`${panel}.querySelector('[role=alert] button').click()`); await wait(() => evaluate(`${body}.textContent.includes('retry content')&&!${panel}.querySelector('[role=alert]')`), "retry");
  controls.maxBytes = 4096; await writeFile(path.join(project, "note.txt"), "x".repeat(5000)); await wait(() => evaluate(`${panel}.textContent.includes('文件较大，当前仅显示开头')`), "truncated");
  await evaluate("Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedFilePath=text}}})");
  await evaluate(`${panel}.querySelector('button[aria-label=\"复制文件路径\"]').click()`); assert.equal(await evaluate("window.__copiedFilePath"), "note.txt");
  console.log(`App unified document smoke passed: ${refreshMs.toFixed(1)} ms refresh, scroll, hidden pause/reactivation, stale response, delete/empty/retry/truncated status and copy path.`);
}
