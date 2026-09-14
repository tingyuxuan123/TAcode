import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";
import type { SessionSummary } from "../src/shared/types";

export async function seedSearchHistory(sessions: SessionSummary[]) {
  for (const session of sessions.slice(0, 2)) {
    const count = session.id === "A" ? 2020 : 2;
    await writeFile(session.path, Array.from({ length: count }, (_, i) => JSON.stringify({
      type: "message", id: `m-${i}`, parentId: i ? `m-${i - 1}` : null,
      message: { role: i % 2 ? "assistant" : "user", timestamp: 1789280000000 + i, content: session.id === "A" && [4, 5, 1805].includes(i) ? `中文结论 位于 ${i}，历史正文完整。` : `${session.id} 历史 ${i}`, stopReason: "stop" },
    })).join("\n") + "\n");
  }
}

export async function testSearch(main: BrowserWindow, controls: { failEarlier: boolean }, screenshot: (name: string) => Promise<void>) {
  const evaluate = <T = unknown>(code: string): Promise<T> => main.webContents.executeJavaScript(code, true);
  const wait = async (code: string, label: string) => {
    const until = Date.now() + 12_000;
    while (Date.now() < until) { if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error(`Search: ${label}`);
  };
  const fill = async (selector: string, text: string) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus(); document.querySelector(${JSON.stringify(selector)}).select()`);
    await main.webContents.insertText(text);
  };
  await wait("!!document.querySelector('.sidebar-search input')", "sidebar search");
  await fill(".sidebar-search input", "会话 A");
  await wait("document.querySelectorAll('.session-row').length === 2", "matching same-name sessions across projects");
  assert.equal(await evaluate("document.querySelectorAll('.session-search-context').length"), 2);
  await screenshot("session-search.png");
  await fill(".sidebar-search input", "副项目");
  await wait("document.querySelectorAll('.session-row').length === 1 && document.querySelector('.session-row').title.includes('B.jsonl')", "project path filtering");
  await fill(".sidebar-search input", "会话 A");
  await wait("document.querySelectorAll('.session-row').length === 2", "title results restored");
  await evaluate("Array.from(document.querySelectorAll('.session-row')).find(el => el.title.includes('A.jsonl')).click()");
  await wait("!!document.querySelector('.conversation .user') && !document.querySelector('.session-loading')", "history opens without provider");
  assert.equal(await evaluate("document.querySelector('.conversation').textContent.includes('中文结论')"), false);
  await evaluate("document.querySelector('.chat-find-trigger').click()");
  await fill(".conversation-find input", "中文结论");
  await wait("!!document.querySelector('.conversation-find [role=alert]')", "failed earlier page distinguished from empty results");
  assert.equal(await evaluate("document.querySelector('.conversation-find').textContent.includes('完整历史中没有匹配')"), false);
  controls.failEarlier = false;
  await evaluate("document.querySelector('.conversation-find [role=alert] button').click()");
  await wait("document.querySelector('.conversation-find [role=status]')?.textContent.includes('1 / 3') && !document.querySelector('.conversation-find [role=alert]')", "complete paged search");
  await wait("document.querySelector('.message-item[data-find-match]')?.textContent.includes('位于 4')", "offscreen user match mounted");
  await evaluate("document.querySelector('.conversation-find button[aria-label=下一条匹配消息]').click()");
  await wait("document.querySelector('.message-item[data-find-match]')?.textContent.includes('位于 5')", "assistant match");
  await evaluate("document.querySelector('.conversation-find button[aria-label=下一条匹配消息]').click()");
  await wait("document.querySelector('.message-item[data-find-match]')?.textContent.includes('位于 1805')", "distant match");
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.ok(await evaluate("document.querySelector('.message-item[data-find-match]')?.textContent.includes('位于 1805')"), "previous navigation must not pull the new match back");
  assert.ok(await evaluate<number>("document.querySelectorAll('.conversation .message-item').length") < 100);
  await screenshot("conversation-find.png");
  await evaluate("document.querySelector('.conversation-find input').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', isComposing:true, bubbles:true}))");
  assert.match(await evaluate<string>("document.querySelector('.conversation-find [role=status]').textContent"), /3 \/ 3/);
  await evaluate("document.querySelector('.conversation-find input').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
  await wait("!document.querySelector('.conversation-find') && document.activeElement.classList.contains('chat-find-trigger')", "close returns focus");
  await fill(".sidebar-search input", "会话 S");
  const filter = (value: string) => evaluate(`document.querySelector('.sidebar-search select').value = ${JSON.stringify(value)}; document.querySelector('.sidebar-search select').dispatchEvent(new Event('change', {bubbles:true}))`);
  await filter("waiting");
  await wait("document.querySelectorAll('.session-row').length === 1 && document.querySelector('.session-row').textContent.includes('S1')", "pending status filter");
  await filter("failed");
  await wait("document.querySelectorAll('.session-row').length === 1 && document.querySelector('.session-row').textContent.includes('S2')", "failed status filter");
  await filter("running");
  await wait("document.querySelectorAll('.session-row').length === 2", "running status filter");
  console.log("Search smoke passed: 1000 sessions, title/project filtering and same-name context, complete paged history without workers, read failure/retry, offscreen user/assistant navigation, rapid next target, IME and focus return.");
}
