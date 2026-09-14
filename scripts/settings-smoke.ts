import assert from "node:assert/strict";
import type { BrowserWindow } from "electron";
import type { ProviderRecord } from "../src/shared/types";

export function settingsFixture() {
  return {
    provider: { id: "fixture", name: "测试服务", vendorKey: "custom", baseUrl: "https://fixture.invalid/v1", apiStyle: "chat_completions", models: [{ id: "fixture-model", contextWindow: 32000, maxTokens: 4000 }], defaultModelId: "fixture-model", isEnabled: true, createdAt: "2026-09-14", updatedAt: "2026-09-14" } as ProviderRecord,
    vision: { profiles: [{ id: "vision", name: "测试视觉", url: "https://fixture.invalid/v1", model: "fixture-model", apiKey: "fixture-only" }], activeProfileId: "vision" },
    updates: 0, visionSaves: 0, subagentSaves: 0, failSave: false,
  };
}

export async function testSettings(main: BrowserWindow, fixture: ReturnType<typeof settingsFixture>, screenshot: (name: string) => Promise<void>) {
  const evaluate = <T = unknown>(code: string): Promise<T> => main.webContents.executeJavaScript(code, true);
  const wait = async (code: string, label: string) => {
    const until = Date.now() + 10_000;
    while (Date.now() < until) { if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error(`Settings: ${label}; ${await evaluate("JSON.stringify({focus:document.activeElement?.outerHTML,dialogs:[...document.querySelectorAll('[role=dialog]')].map(n=>n.textContent.slice(0,160))})")}`);
  };
  const click = (selector: string) => evaluate(`(() => { const node=document.querySelector(${JSON.stringify(selector)}); node.focus(); node.click(); })()`);
  const fill = async (selector: string, value: string) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus(); document.querySelector(${JSON.stringify(selector)}).select()`);
    await main.webContents.insertText(value);
  };
  const key = async (keyCode: string, modifiers: string[] = []) => {
    main.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    main.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
    await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
  };
  const open = async () => {
    await click(".account");
    await wait("!!document.querySelector('.account-menu button')", "account menu");
    await click(".account-menu button");
    await wait("!!document.querySelector('.settings .provider-row')", "settings loaded");
  };
  const edit = async () => {
    await click('.provider-action[title="编辑"]');
    await wait("document.activeElement?.matches('.provider-dialog input[data-dialog-autofocus]')", "provider initial focus");
  };
  const prompt = () => wait("!!document.querySelector('.confirm-modal')", "unsaved confirmation");
  const pane = async (label: string) => {
    await evaluate(`Array.from(document.querySelectorAll('.settings-nav-item')).find(n => n.textContent === ${JSON.stringify(label)}).click()`);
  };
  await wait("!!document.querySelector('.account')", "settings entry");
  const inertState = "Array.from(document.querySelectorAll('[inert]')).map(n => n.tagName + ':' + n.className).sort()";
  const initialInert = await evaluate<string[]>(inertState);
  await open();
  await key("Escape");
  await wait("!document.querySelector('.settings') && document.activeElement.matches('.account')", "pristine close and opener focus");
  await open();
  await edit();
  assert.ok(await evaluate("document.querySelector('.settings-nav').inert"), "parent settings cannot receive focus");
  for (let i = 0; i < 32; i++) {
    await key("Tab");
    assert.ok(await evaluate("document.querySelector('.provider-dialog').contains(document.activeElement)"), "Tab stays in editor");
  }
  await key("Tab", ["shift"]);
  assert.ok(await evaluate("document.querySelector('.provider-dialog').contains(document.activeElement)"));
  await click(".provider-service-trigger");
  await key("Escape");
  assert.ok(await evaluate("!document.querySelector('.provider-service-menu') && !!document.querySelector('.provider-dialog') && !document.querySelector('.confirm-modal')"));
  await fill(".provider-dialog input[data-dialog-autofocus]", "未保存名称");
  await fill('.provider-dialog input[placeholder="https://api.example.com/v1"]', "https://changed.invalid/v1");
  await click(".provider-model-row");
  await fill(".provider-model-limits input", "64000");
  await fill(".provider-custom-model input", "输入法模型");
  await evaluate("(() => { const n=document.activeElement; n.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})); n.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true})); n.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})); n.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true})); })()");
  assert.equal(await evaluate("document.querySelectorAll('.provider-model-row').length"), 1, "composing Enter must not add a model");
  main.webContents.sendInputEvent({ type: "mouseDown", x: 5, y: 5, button: "left", clickCount: 1 });
  main.webContents.sendInputEvent({ type: "mouseUp", x: 5, y: 5, button: "left", clickCount: 1 });
  await prompt();
  assert.equal(await evaluate("document.querySelectorAll('[role=dialog]').length"), 3);
  assert.ok(await evaluate("document.activeElement.textContent === '继续编辑'"));
  for (let i = 0; i < 5; i++) { await key("Tab"); assert.ok(await evaluate("document.querySelector('.confirm-modal').contains(document.activeElement)")); }
  await screenshot("unsaved-settings.png");
  await key("Escape");
  await wait("!document.querySelector('.confirm-modal') && !!document.querySelector('.provider-dialog')", "Escape only dismisses top confirmation");
  assert.equal(fixture.updates, 0);
  await key("Escape");
  await prompt();
  await click(".confirm-modal .danger");
  await wait("!document.querySelector('.provider-dialog') && !!document.querySelector('.settings')", "discard keeps parent settings");
  await wait("document.activeElement.matches('.provider-action[title=编辑]')", "editor returns focus to edit button");
  assert.equal(await evaluate("Object.values(localStorage).some(v => v.includes('64000'))"), false, "discarded model parameters not cached");
  await edit();
  assert.equal(await evaluate("document.querySelector('.provider-dialog input[data-dialog-autofocus]').value"), "测试服务");
  await fill(".provider-dialog input[data-dialog-autofocus]", "保存后的名称");
  await key("Escape"); await prompt();
  fixture.failSave = true;
  await click(".confirm-modal .primary");
  await wait("!!document.querySelector('.provider-dialog .provider-error') && !document.querySelector('.confirm-modal')", "failed save keeps form");
  assert.equal(await evaluate("document.querySelector('.provider-dialog input[data-dialog-autofocus]').value"), "保存后的名称");
  fixture.failSave = false;
  await click(".provider-dialog-head .primary");
  await wait("!document.querySelector('.provider-dialog') && document.querySelector('.provider-row-title').textContent.includes('保存后的名称')", "retry saves once");
  assert.equal(fixture.updates, 1);
  await pane("图片识别");
  await wait("!!document.querySelector('.custom-api-form input')", "vision form");
  await fill(".custom-api-form input", "未保存视觉名称");
  await key("Escape"); await prompt();
  await click(".confirm-modal [data-dialog-autofocus]");
  assert.equal(await evaluate("document.querySelector('.custom-api-form input').value"), "未保存视觉名称");
  await pane("AI 服务");
  await edit();
  await key("Escape");
  await wait("!document.querySelector('.provider-dialog') && !document.querySelector('.confirm-modal')", "pristine child closes without discarding parent vision draft");
  await pane("图片识别");
  await click(".custom-api-form input");
  await key("Enter");
  assert.equal(fixture.visionSaves, 0, "input Enter must not implicitly submit settings");
  await evaluate("document.querySelector('.settings-foot button[type=submit]').focus(); document.activeElement.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))");
  await key("Enter");
  assert.equal(fixture.visionSaves, 0, "native Enter during composition must not activate Save");
  await evaluate("document.activeElement.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))");
  await key("Enter");
  assert.equal(fixture.visionSaves, 0, "post-composition Enter must not activate Save");
  await key("Escape"); await prompt();
  await click(".confirm-modal .primary");
  await wait("!document.querySelector('.settings')", "save parent through confirmation");
  assert.equal(fixture.visionSaves, 1);
  assert.equal(fixture.vision.profiles[0].name, "未保存视觉名称");
  await open();
  await pane("子代理");
  await wait("!!document.querySelector('.settings-pane .pane-head .primary')", "subagents pane");
  await click(".settings-pane .pane-head .primary");
  await wait("document.activeElement?.matches('.subagent-sheet input[data-dialog-autofocus]')", "subagent initial focus");
  await fill(".subagent-sheet input[data-dialog-autofocus]", "draft-agent");
  await key("Escape"); await prompt();
  await key("Escape");
  assert.ok(await evaluate("!!document.querySelector('.subagent-sheet') && !!document.querySelector('.settings') && !document.querySelector('.confirm-modal')"));
  await key("Escape"); await prompt();
  await click(".confirm-modal .danger");
  await wait("!document.querySelector('.subagent-sheet') && !!document.querySelector('.settings')", "subagent discard keeps settings");
  await key("Escape");
  await wait("!document.querySelector('.settings') && document.activeElement.matches('.account')", "all dialogs release focus");
  assert.deepEqual(await evaluate(inertState), initialInert, "restore background's original inert state");
  assert.equal(fixture.subagentSaves, 0);
  console.log("Settings smoke passed: dirty provider/vision/subagent protection, discard cache isolation, failed save/retry, nested Escape, Tab trap, opener focus, IME and implicit-submit guard.");
}
