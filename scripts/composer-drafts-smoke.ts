import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";

export interface ComposerSmokeControls {
  configured: boolean;
  failStart: boolean;
  failSetup?: boolean;
  prompt: "approval" | "reject" | "accept" | "delay";
  submitted: Array<{ images?: unknown[] }>;
  completePrompt?: (accepted: boolean) => void;
}

export async function testComposerDrafts({ main, evaluate, select, wait, controls, screenshot, stage, failActive }: {
  main: BrowserWindow;
  evaluate<T = unknown>(script: string): Promise<T>;
  select(name: string): Promise<void>;
  wait(condition: () => Promise<unknown>): Promise<void>;
  controls: ComposerSmokeControls;
  screenshot(name: string): Promise<void>;
  stage(name: string): void;
  failActive(): void;
}) {
  const text = () => evaluate<string>("document.querySelector('.prompt-input').textContent");
  const images = () => evaluate<number>("document.querySelectorAll('.prompt-attachment').length");
  const type = async (value: string, replace = false) => {
    await evaluate(`(() => {
      const root = document.querySelector('.prompt-input'); root.focus();
      const range = document.createRange(); range.selectNodeContents(root);
      ${replace ? "" : "range.collapse(false);"}
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    })()`);
    await main.webContents.insertText(value);
  };
  const addTwoImages = async () => {
    await evaluate(`(() => {
      const binary = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/fFQAAAAASUVORK5CYII=');
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const files = new DataTransfer();
      for (const name of ['first.png', 'second.png']) files.items.add(new File([bytes], name, { type: 'image/png' }));
      const input = document.querySelector('.prompt input[type=file]'); input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await wait(async () => (await images()) === 2);
  };
  const send = () => evaluate("document.querySelector('.prompt button[type=submit]').click()");
  const assertDraft = async (expected: string, count = 2) => {
    await wait(async () => (await text()).includes(expected) && (await images()) === count);
  };
  const newThread = async () => {
    await evaluate("Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === '新对话').click()");
    await wait(() => evaluate("document.querySelector('.home-screen') !== null || (!document.querySelector('.session-row[aria-current=page]') && !!document.querySelector('[contenteditable=true]'))"));
  };
  stage("drafts isolated across conversations");
  await select("A");
  await type("A 草稿 @src/App.tsx ", true);
  await addTwoImages();
  await select("B");
  await type("B 的独立草稿", true);
  assert.equal(await images(), 0);
  await select("A");
  await assertDraft("A 草稿");
  stage("persist full draft through renderer restart");
  await wait(() => evaluate("(localStorage.getItem('tacode.composer-drafts.v1') || '').includes('A 草稿')"));
  await wait(() => evaluate(`new Promise(resolve => {
    const req = indexedDB.open('tacode-composer-drafts'); req.onsuccess = () => {
      const db = req.result; const count = db.transaction('images').objectStore('images').count();
      count.onsuccess = () => { resolve(count.result === 2); db.close(); };
    };
  })`));
  main.webContents.reload();
  await wait(() => evaluate("document.querySelectorAll('.home-recent').length >= 2"));
  await evaluate("document.querySelector('.home-recent').click()");
  await select("A");
  await assertDraft("A 草稿");
  await select("B");
  await assertDraft("B 的独立草稿", 0);
  await select("A");
  stage("rejected send restores both images");
  const before = controls.submitted.length;
  await send();
  await wait(async () => controls.submitted.length === before + 1);
  await assertDraft("A 草稿");
  assert.equal(controls.submitted.at(-1)?.images?.length, 2);
  stage("failed send merges later typing");
  controls.prompt = "delay";
  controls.completePrompt = undefined;
  await send();
  await wait(async () => Boolean(controls.completePrompt));
  await type("等待期间的新文字");
  controls.completePrompt!(false);
  await assertDraft("等待期间的新文字");
  await wait(() => evaluate("!!document.querySelector('.prompt-draft-notice') && !document.querySelector('.flow-running-indicator')"));
  assert.match(await text(), /A 草稿/);
  await screenshot("draft-restored.png");
  stage("missing model configuration preserves draft and attachments");
  await newThread();
  await type("缺少配置也不能丢", true);
  await addTwoImages();
  controls.configured = false;
  await send();
  await assertDraft("缺少配置也不能丢");
  await wait(() => evaluate("!!document.querySelector('.modal')"));
  controls.configured = true;
  controls.failStart = true;
  await evaluate("document.querySelector('.modal button[aria-label=关闭]').click()");
  await wait(() => evaluate("!document.querySelector('.modal')"));
  stage("failed worker startup preserves draft and attachments");
  await send();
  await wait(() => evaluate("document.querySelector('.toast')?.textContent.includes('fixture worker startup failed')"));
  await assertDraft("缺少配置也不能丢");
  stage("failed model setup after session creation preserves the rebound draft");
  controls.failStart = false;
  controls.failSetup = true;
  await send();
  await wait(() => evaluate("document.querySelector('.toast')?.textContent.includes('fixture model setup failed')"));
  await assertDraft("缺少配置也不能丢");
  controls.failSetup = false;
  stage("accepted send leaves subsequent draft intact even if the model fails");
  controls.failStart = false;
  controls.completePrompt = undefined;
  await send();
  await wait(async () => Boolean(controls.completePrompt));
  await type("已接受后保留的新草稿");
  controls.completePrompt!(true);
  await wait(() => evaluate("!(document.querySelector('.prompt-draft-notice')?.textContent || '').includes('未发送成功')"));
  failActive();
  await assertDraft("已接受后保留的新草稿", 0);
  assert.equal((await text()).includes("缺少配置也不能丢"), false);
  await screenshot("draft-after-accepted-send.png");
}
