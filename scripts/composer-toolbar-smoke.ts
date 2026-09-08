import type { BrowserWindow } from "electron";
import assert from "node:assert/strict";

export async function verifyComposerToolbar(win: BrowserWindow): Promise<{ icons: Buffer; menu: Buffer }> {
  let stage = "wide toolbar";
  const evaluate = (script: string) => win.webContents.executeJavaScript(script).catch((error) => { throw new Error(`${stage}: ${script.slice(0, 300)}\n${error}`); });
  const wait = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Composer did not settle (${stage}): ${JSON.stringify(await evaluate("({width:innerWidth,mode:document.querySelector('.prompt-wrap .prompt-bar')?.dataset.mode,action:document.querySelector('[data-composer-action]')?.textContent,popovers:Array.from(document.querySelectorAll('.picker-panel'),el=>el.className)})"))}`);
  };
  const click = async (selector: string) => {
    const point = await evaluate(`(async () => {const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest',behavior:'instant'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: "mouseMove", ...point });
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  };
  const mode = (value: string) => wait(async () => (await evaluate("document.querySelector('.prompt-wrap .prompt-bar')?.dataset.mode")) === value);
  const oneRow = async () => {
    assert(await evaluate(`(() => {
      const bar=document.querySelector('.prompt-wrap .prompt-bar'), r=bar.getBoundingClientRect();
      const buttons=Array.from(bar.querySelectorAll(':scope > .send, :scope > .prompt-more, .prompt-toolbar-controls > button, .prompt-toolbar-controls > div > button')).filter(el=>el.getBoundingClientRect().width>0);
      return r.height===32 && buttons.every(el=>{const b=el.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right+1&&Math.abs((b.top+b.bottom-r.top-r.bottom)/2)<=1});
    })()`), "toolbar must remain within one row with a visible send/stop button");
  };
  const popupInside = (selector: string) => evaluate(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`);
  await mode("full");
  await oneRow();
  await wait(async () => await evaluate("document.querySelector('.prompt-input').textContent==='缩放后保留这条输入'"));
  await evaluate("window.__composerEditor=document.querySelector('.prompt-input')");

  win.setSize(420, 620);
  await mode("icons");
  await oneRow();
  assert(await evaluate("Array.from(document.querySelectorAll('.prompt-wrap .toolbar-label')).every(el=>getComputedStyle(el).display==='none')"));
  assert(await evaluate("Array.from(document.querySelectorAll('.prompt-wrap .prompt-toolbar-controls > button, .prompt-wrap .prompt-toolbar-controls > div > button')).every(el=>el.getAttribute('aria-label')&&el.title)"));
  const icons = (await win.webContents.capturePage()).toPNG();
  stage = "open model in icons";
  await click('.prompt-wrap .model-combo > button');
  await wait(async () => await evaluate("!!document.querySelector('.model-picker-panel')"));
  stage = "choose long model";
  await click('.model-picker-item:last-child');
  await wait(async () => (await evaluate("document.querySelector('[data-composer-action]').textContent")).startsWith("模型：这是"));
  await oneRow();

  stage = "overflow width";
  win.setSize(260, 620);
  await mode("overflow");
  await oneRow();
  stage = "open overflow controls";
  await click('.prompt-more');
  await wait(async () => await evaluate("document.querySelector('.prompt-more').getAttribute('aria-expanded')==='true' && !document.querySelector('.prompt-wrap .prompt-toolbar-controls').hidden"));
  assert(await popupInside('.prompt-wrap .prompt-toolbar-controls'));
  assert.equal(await evaluate("document.querySelectorAll('.prompt-wrap .prompt-toolbar-controls > button, .prompt-wrap .prompt-toolbar-controls > div > button').length"), 5);
  const menu = (await win.webContents.capturePage()).toPNG();

  // Clicking the upload entry reaches the native file input without showing an OS picker in this fixture.
  await evaluate("document.querySelector('.prompt-wrap input[type=file]').addEventListener('click',event=>{event.preventDefault();window.__uploadOpened=true})");
  await click('.prompt-wrap .prompt-attach');
  await wait(async () => await evaluate("window.__uploadOpened===true"));
  stage = "choose model from overflow";
  await click('.prompt-wrap .model-combo > button');
  await wait(async () => await evaluate("!!document.querySelector('.model-picker-panel')"));
  assert(await popupInside('.model-picker-panel'));
  assert(await evaluate("document.querySelector('.prompt-more').getAttribute('aria-expanded')==='true'"));
  await click('.model-picker-item:first-of-type');
  await wait(async () => (await evaluate("document.querySelector('[data-composer-action]').textContent")) === "模型：glm-5.3-flash");
  stage = "choose effort from overflow";
  await click('.prompt-wrap .effort-trigger');
  await wait(async () => await evaluate("!!document.querySelector('.effort-picker-panel')"));
  assert(await popupInside('.effort-picker-panel'));
  await click('.effort-picker-labels > button:first-child');
  await wait(async () => (await evaluate("document.querySelector('[data-composer-action]').textContent")) === "思考：off");
  stage = "choose permission from overflow";
  await click('.prompt-wrap .permission-trigger');
  await wait(async () => await evaluate("!!document.querySelector('.permission-menu')"));
  assert(await popupInside('.permission-menu'));
  await click('.permission-item:first-child');
  await wait(async () => (await evaluate("document.querySelector('[data-composer-action]').textContent")) === "权限：plan");
  stage = "context from overflow";
  await click('.prompt-wrap .stats-toggle');
  await wait(async () => await evaluate("!!document.querySelector('.context-popover')"));
  assert(await popupInside('.context-popover'));
  await click('.context-compact-btn');
  await wait(async () => (await evaluate("document.querySelector('[data-composer-action]').textContent")) === "已请求压缩");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await wait(async () => await evaluate("!document.querySelector('.context-popover')"));
  assert(await evaluate("document.querySelector('.prompt-more').getAttribute('aria-expanded')==='true'"));
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await wait(async () => await evaluate("document.querySelector('.prompt-wrap .prompt-toolbar-controls').hidden"));
  await oneRow();
  const draft = await evaluate("({same:window.__composerEditor===document.querySelector('.prompt-input'),text:document.querySelector('.prompt-input').textContent,html:document.querySelector('.prompt-input').innerHTML})");
  assert(draft.same && draft.text === "缩放后保留这条输入", JSON.stringify(draft));
  await click('.prompt-wrap .send');
  await wait(async () => await evaluate("!!document.querySelector('.send.stop')"));
  assert.equal(await evaluate("document.querySelector('[data-composer-action]').textContent"), "发送：缩放后保留这条输入");
  await oneRow();
  await click('.prompt-wrap .send.stop');
  await wait(async () => (await evaluate("document.querySelector('[data-composer-action]').textContent")) === "已停止");
  win.setSize(900, 620);
  await mode("full");
  await oneRow();
  assert(await evaluate("!document.querySelector('.prompt-more') && getComputedStyle(document.querySelector('.prompt-wrap .model-combo .toolbar-label')).display!=='none'"));
  await evaluate("document.documentElement.style.setProperty('--ui-font-scale','1.5')");
  await wait(async () => await evaluate("document.querySelector('.prompt-wrap .prompt-bar').scrollWidth <= document.querySelector('.prompt-wrap .prompt-bar').clientWidth"));
  await oneRow();
  console.log("Composer toolbar passed: full → icons → overflow, all five controls, bounded nested popovers, draft preservation, send/stop, Escape and wide/font-size recovery.");
  return { icons, menu };
}
