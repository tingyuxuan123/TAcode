import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserWindow } from "electron";

export function createLargeFixture() {
  const now = 1789280000000;
  const messages = Array.from({ length: 4000 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `历史 ${i}，完整保留第 ${Math.floor(i / 2) + 1} 轮记录。` }], timestamp: now + i, stopReason: "stop" }));
  const paragraph = "这是一段用于固定回放的回答。**检查内容**保持完整，输入和阅读可以继续。\n\n";
  const answer = paragraph.repeat(Math.ceil(100 * 1024 / Buffer.byteLength(paragraph))) + "回答末尾标记";
  const code = Array.from({ length: 2400 }, (_, i) => `export const item${i} = "完整代码 ${i}";`).join("\n");
  const line = "// " + "file-content ".repeat(39) + "\n";
  const tail = "\n// LARGE_FILE_END";
  const file = line.repeat(Math.ceil(4 * 1024 * 1024 / line.length)).slice(0, 4 * 1024 * 1024 - tail.length) + tail;
  return { now, messages, answer, code, file };
}

export async function testLargeContent(main: BrowserWindow, project: string, fixture: ReturnType<typeof createLargeFixture>, emit: (event: Record<string, unknown>) => void, select: (name: string) => Promise<void>, screenshot: (name: string) => Promise<void>) {
  const evaluate = <T = unknown>(code: string): Promise<T> => main.webContents.executeJavaScript(code, true);
  const wait = async (code: string, label: string, timeout = 30_000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await evaluate(code)) return; await new Promise((resolve) => setTimeout(resolve, 30)); }
    throw new Error(`Large content: ${label}`);
  };
  await writeFile(path.join(project, "large.ts"), fixture.file);
  await wait("!!document.querySelector('.project-row')", "project");
  await evaluate("document.querySelector('.project-row').click()");
  await select("B");
  await evaluate(`(() => {
    window.__large = { marks: [{ phase: 'history', time: performance.now() }], longTasks: [], errors: [] };
    window.__largeObserver = new PerformanceObserver(list => window.__large.longTasks.push(...list.getEntries().map(e => ({ phase: window.__large.marks.findLast(mark => mark.time <= e.startTime)?.phase ?? 'history', ms: e.duration }))));
    window.__largeObserver.observe({ type: 'longtask' });
    window.addEventListener('error', e => window.__large.errors.push(e.message));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__largeCopied = text; } } });
  })()`);
  const phases: Record<string, number> = {};
  emit({ type: "agent_start" });
  let began = performance.now();
  await select("A");
  phases.history = performance.now() - began;
  assert.ok(await evaluate<number>("document.querySelectorAll('.conversation .message-item').length") < 100, "history must stay virtualized");
  await evaluate("window.__large.marks.push({ phase: 'stream', time: performance.now() }); document.querySelector('.prompt-input').focus()");
  const timestamp = fixture.now + 5001;
  emit({ type: "message_start", message: { role: "user", content: "开始长内容回放", timestamp: timestamp - 1 } });
  began = performance.now();
  const inputs: number[] = [];
  for (let i = 1; i <= 40; i++) {
    emit({ type: "message_update", message: { role: "assistant", content: fixture.answer.slice(0, Math.ceil(fixture.answer.length * i / 40)), timestamp } });
    if (i % 5 === 0) {
      const start = performance.now();
      await main.webContents.insertText("测");
      await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
      inputs.push(performance.now() - start);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await wait("document.querySelector('.conversation').textContent.includes('回答末尾标记')", "stream complete");
  phases.stream = performance.now() - began;
  await evaluate("window.__large.marks.push({ phase: 'final', time: performance.now() })");
  began = performance.now();
  emit({ type: "message_end", message: { role: "assistant", content: fixture.answer, timestamp, stopReason: "stop" } });
  emit({ type: "agent_settled" });
  await wait("!document.querySelector('.send.stop')", "settled");
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  phases.final = performance.now() - began;
  const answerBody = "Array.from(document.querySelectorAll('.conversation .markdown')).find(el => el.textContent.includes('回答末尾标记'))";
  const paragraphs = fixture.answer.split("这是一段用于固定回放的回答").length - 1;
  assert.equal(await evaluate(`(${answerBody}.textContent.match(/这是一段用于固定回放的回答/g) || []).length`), paragraphs);
  await evaluate(`${answerBody}.closest('.turn').querySelector('.bubble-action[aria-label=复制]').click()`);
  const copiedAnswer = await evaluate<string>("window.__largeCopied");
  assert.equal(copiedAnswer.split("这是一段用于固定回放的回答").length - 1, paragraphs);
  assert.ok(copiedAnswer.endsWith("回答末尾标记"));
  await evaluate("window.__large.marks.push({ phase: 'code', time: performance.now() })");
  began = performance.now();
  emit({ type: "agent_start" });
  emit({ type: "message_start", message: { role: "user", content: "长代码回放", timestamp: timestamp + 1 } });
  emit({ type: "message_end", message: { role: "assistant", content: `\`\`\`typescript\n${fixture.code}\n\`\`\``, timestamp: timestamp + 2, stopReason: "stop" } });
  emit({ type: "agent_settled" });
  await wait("document.querySelector('.conversation').textContent.includes('item2399')", "long code");
  phases.code = performance.now() - began;
  await evaluate("Array.from(document.querySelectorAll('.code-block-copy')).at(-1).click()");
  assert.equal(await evaluate("window.__largeCopied"), fixture.code);
  await evaluate("window.__large.marks.push({ phase: 'file', time: performance.now() }); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true }))");
  await wait("!!document.querySelector('.files-entry[title=\"large.ts\"]')", "file entry");
  began = performance.now();
  await evaluate("document.querySelector('.files-entry[title=\"large.ts\"]').click()");
  await wait("document.querySelector('[data-preview-path=\"large.ts\"]')?.textContent.includes('LARGE_FILE_END')", "4 MiB file");
  phases.file = performance.now() - began;
  await evaluate("new Promise(resolve => setTimeout(resolve, 250))");
  const fileNodes = await evaluate<number>("document.querySelector('[data-preview-path=\"large.ts\"]').querySelectorAll('*').length");
  if (process.env.TACODE_ACTIVITY_BASELINE !== "1") assert.ok(fileNodes < 100, "large file DOM should stay bounded");
  const searchStart = performance.now();
  const found = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => { main.webContents.removeListener("found-in-page", onFound); resolve(0); }, 15_000);
    const onFound = (_event: unknown, result: { finalUpdate: boolean; matches: number }) => { if (result.finalUpdate) { clearTimeout(timer); main.webContents.removeListener("found-in-page", onFound); resolve(result.matches); } };
    main.webContents.on("found-in-page", onFound);
    main.webContents.findInPage("LARGE_FILE_END");
  });
  assert.ok(found > 0, "native search must find full file tail");
  phases.fileSearch = performance.now() - searchStart;
  main.webContents.stopFindInPage("keepSelection");
  await evaluate("document.querySelector('[data-preview-path=\"large.ts\"] button[aria-label=复制]').click()");
  assert.equal(await evaluate("window.__largeCopied"), fixture.file);
  await screenshot("large-content.png");
  const report = await evaluate<{ longTasks: Array<{ phase: string; ms: number }>; errors: string[] }>("window.__largeObserver.disconnect(); window.__large");
  const { longTasks, errors } = report;
  const measurement = { baseline: process.env.TACODE_ACTIVITY_BASELINE === "1", historyTurns: 2000, answerBytes: Buffer.byteLength(fixture.answer), codeBytes: Buffer.byteLength(fixture.code), fileBytes: Buffer.byteLength(fixture.file), phases, inputSamplesMs: inputs, fileNodes, longTasks, errors };
  if (process.env.TACODE_LARGE_REPORT) await writeFile(process.env.TACODE_LARGE_REPORT, JSON.stringify(measurement, null, 2) + "\n");
  if (process.env.TACODE_RESIZE_DIAGNOSTIC === "1") console.log("RESIZE_TRACE " + JSON.stringify(await evaluate("window.__resizeWarnings")));
  console.log("LARGE_RESULT " + JSON.stringify(measurement));
}
