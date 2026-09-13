import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";
import type { ComposerSmokeControls } from "./composer-drafts-smoke";

/** Chromium 的可信 composition 事件；Windows/macOS 的原生键码差异另由 ime.test.ts 覆盖。 */
export async function testImeInput({ main, evaluate, wait, stage, controls, renames }: {
  main: BrowserWindow;
  evaluate<T = unknown>(script: string): Promise<T>;
  wait(condition: () => Promise<unknown>): Promise<void>;
  stage(value: string): void;
  controls: ComposerSmokeControls;
  renames: string[];
}) {
  main.webContents.debugger.attach("1.3");
  const cdp = (method: string, params?: object) => main.webContents.debugger.sendCommand(method, params);
  const key = async (key: string, code = 13, modifiers = 0) => {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: code, modifiers,
      ...(key === "Enter" && code === 13 ? { text: "\r", unmodifiedText: "\r" } : {}) });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code, modifiers });
  };
  const type = async (text: string) => {
    await evaluate("(() => { const el = document.querySelector('.prompt-input'); el.focus(); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()");
    await cdp("Input.insertText", { text });
  };
  const compose = async (text: string) => cdp("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  const commit = async (text: string) => {
    await cdp("Input.insertText", { text });
    await evaluate("new Promise(resolve => setTimeout(resolve, 40))");
  };
  try {
    stage("IME confirming a file query");
    await type("@");
    await wait(() => evaluate("document.querySelectorAll('.slash-menu.files button').length > 0"));
    stage("composing the file name");
    await compose("中文");
    await key("Enter", 229);
    assert.equal(await evaluate("document.querySelector('.prompt-input').textContent.includes('@src/')"), false);
    assert.equal(controls.submitted.length, 0);
    await commit("中文");
    await wait(() => evaluate("document.querySelector('.prompt-input').textContent.includes('中文')"));
    stage("selecting the file after composition");
    await key("Enter");
    await wait(() => evaluate("document.querySelector('.prompt-input').textContent === '@src/中文.ts '"));
    assert.equal(controls.submitted.length, 0);

    stage("IME confirming a slash query");
    await type("/");
    await wait(() => evaluate("!!document.querySelector('.slash-menu:not(.files)')"));
    await compose("中文");
    await key("Enter", 229);
    assert.equal(controls.submitted.length, 0);
    await commit("中文");
    const before = await evaluate<string>("document.querySelector('.prompt-input').textContent");
    await key("Escape", 27);
    await wait(() => evaluate("!document.querySelector('.slash-menu')"));
    assert.equal(await evaluate("document.querySelector('.prompt-input').textContent"), before);

    stage("ordinary Enter and Shift+Enter");
    await type("第一行");
    await key("Enter", 13, 8);
    await cdp("Input.insertText", { text: "第二行" });
    assert.equal(controls.submitted.length, 0);
    assert.match(await evaluate<string>("document.querySelector('.prompt-input').innerText"), /第一行\s+第二行/);
    await key("Enter");
    await wait(async () => controls.submitted.length === 1);
    await wait(() => evaluate("!!document.querySelector('.prompt-draft-notice')"));

    stage("IME session rename confirmation");
    await evaluate("document.querySelector('.session-row[aria-current=page]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 250 }))");
    await wait(() => evaluate("!!document.querySelector('.session-menu')"));
    await evaluate("Array.from(document.querySelectorAll('.session-menu button')).find(el => el.textContent.includes('重命名')).click()");
    await wait(() => evaluate("document.activeElement === document.querySelector('.session-rename')"));
    await compose("中文标题");
    await key("Enter", 229);
    assert.equal(renames.length, 0);
    assert.equal(await evaluate("!!document.querySelector('.session-rename')"), true);
    await commit("中文标题");
    await key("Enter");
    await wait(async () => renames.length === 1);
    assert.equal(renames[0], "中文标题");
    await wait(() => evaluate("!document.querySelector('.session-rename')"));
  } catch (error) {
    console.error("IME fixture state:", await evaluate("({ input: document.querySelector('.prompt-input')?.outerHTML, rename: document.querySelector('.session-rename')?.outerHTML, menu: document.querySelector('.slash-menu')?.textContent })"));
    throw error;
  } finally { main.webContents.debugger.detach(); }
}
