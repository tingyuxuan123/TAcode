import { webContents, type BrowserWindow } from "electron";
import assert from "node:assert/strict";

/** Verify the production Chat header using native clicks in the frameless title-bar area. */
export async function verifyWorkbenchHeader(win: BrowserWindow, formerTabHeight: number, options: { titleOnly?: boolean } = {}): Promise<void> {
  const evaluate = (script: string) => win.webContents.executeJavaScript(script);
  const wait = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error("Top header did not settle");
  };
  const click = async (selector: string) => {
    const point = await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest',inline:'nearest'});const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: "mouseMove", ...point });
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  };
  await wait(async () => await evaluate("!!document.querySelector('.inspect-header-tabs .inspect-tab') && !!document.querySelector('webview')?.getWebContentsId()"));
  const initial = await evaluate(`(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
    return { header:rect('.chat-bar'), heading:rect('.inspect-heading'), shell:rect('.inspect-shell'), tabs:rect('.inspect-tabs'), toolbar:rect('.browser-toolbar'), guest:rect('webview'), guestId:document.querySelector('webview').getWebContentsId(), height:innerHeight };
  })()`);
  assert.equal(await evaluate("document.querySelectorAll('[role=tablist]').length"), 1);
  assert.equal(await evaluate("document.querySelectorAll('.inspect-shell .inspect-tabs').length"), 0);
  assert.equal(initial.heading.x, initial.shell.x, "header must line up with the panel below it");
  assert.equal(initial.heading.width, initial.shell.width);
  assert.equal(initial.tabs.y, initial.header.y);
  assert.equal(initial.tabs.bottom, initial.header.bottom);
  assert.equal(initial.toolbar.y, initial.header.bottom, "address bar must directly follow the window header");
  assert.equal(initial.guest.bottom, initial.height);
  assert.equal(initial.guest.height, initial.height - initial.header.height - initial.toolbar.height);
  assert(formerTabHeight > 0, "standalone panel supplies the previous extra tab-row height");
  assert(await evaluate("getComputedStyle(document.querySelector('.inspect-tab-list')).webkitAppRegion==='no-drag' && getComputedStyle(document.querySelector('.inspect-tab-add')).webkitAppRegion==='no-drag'"));
  const verifyTitle = async () => {
    const title = await evaluate(`(() => {
      const node=document.querySelector('.chat-title'), rect=node.getBoundingClientRect(), heading=node.parentElement.getBoundingClientRect();
      return { width:rect.width, right:rect.right, headingRight:heading.right, overflow:getComputedStyle(node).textOverflow, clipped:node.scrollWidth>node.clientWidth, text:node.textContent, tooltip:node.title };
    })()`);
    assert(title.width > 0 && title.width <= 320, "conversation title must have a compact maximum width");
    assert(title.right <= title.headingRight, "title must shrink with the chat heading");
    assert.equal(title.overflow, "ellipsis");
    assert(title.clipped, "long first messages must be visually truncated");
    assert.equal(title.tooltip, title.text, "the full title must remain available on hover");
  };
  await verifyTitle();
  if (options.titleOnly) {
    win.setSize(900, 620);
    await wait(async () => await evaluate("innerWidth===900"));
    await verifyTitle();
    win.setSize(1440, 620);
    await wait(async () => await evaluate("innerWidth===1440"));
    console.log("Conversation title passed: 320px maximum width, ellipsis, full tooltip and responsive layout at 1440px and 900px.");
    return;
  }

  const guest = webContents.fromId(initial.guestId)!;
  await guest.executeJavaScript("document.querySelector('input').value='顶部标签切换后保留'");
  const position = win.getPosition();
  await click('.inspect-tab:first-child');
  await wait(async () => (await evaluate("document.querySelector('.inspect-tab.active .inspect-tab-label').textContent")) === "审查");
  await click('.inspect-tab:nth-child(2)');
  await wait(async () => (await evaluate("document.querySelector('.inspect-tab.active .inspect-tab-label').textContent")) === "页面甲");

  // Closing inspect makes the '+' open its anchored menu; both it and its items
  // must still receive native clicks after being moved into the draggable header.
  await click('.inspect-tab:first-child .inspect-tab-close');
  await wait(async () => (await evaluate("document.querySelectorAll('.inspect-tab').length")) === 1);
  await click('.inspect-tab-add');
  await wait(async () => await evaluate("!!document.querySelector('.panel-add-menu')"));
  await click('.panel-add-item:first-child');
  await wait(async () => (await evaluate("document.querySelectorAll('.inspect-tab').length")) === 2);
  await click('.inspect-tab:first-child');
  await click('.inspect-tab-add');
  await wait(async () => (await evaluate("document.querySelectorAll('.inspect-tab').length")) === 3);
  await click('.inspect-tab.active .inspect-tab-close');
  await wait(async () => (await evaluate("document.querySelectorAll('.inspect-tab').length")) === 2);
  await click('.inspect-tab:first-child');

  await click('.inspect-toggle');
  await wait(async () => await evaluate("getComputedStyle(document.querySelector('.inspect-shell')).display==='none' && document.querySelector('.inspect-header-tabs').getBoundingClientRect().width===0"));
  await click('.inspect-toggle');
  await wait(async () => await evaluate("document.querySelector('.inspect-header-tabs').getBoundingClientRect().width>0 && document.querySelector('webview').getBoundingClientRect().height>0"));
  assert.deepEqual(win.getPosition(), position, "clicking tabs and controls must not drag the window");
  assert.equal(await evaluate("document.querySelector('webview').getWebContentsId()"), initial.guestId);
  assert.equal(await guest.executeJavaScript("document.querySelector('input').value"), "顶部标签切换后保留");

  await guest.executeJavaScript("document.title='上移到标题栏后仍保留完整提示的超长网页标题 · 多页面测试'");
  await wait(async () => await evaluate("document.querySelector('.inspect-tab.active').title.includes('超长网页标题')"));
  win.setSize(900, 620);
  await wait(async () => await evaluate("innerWidth===900"));
  await verifyTitle();
  assert(await evaluate("(() => {const add=document.querySelector('.inspect-tab-add').getBoundingClientRect(), toggle=document.querySelector('.inspect-toggle').getBoundingClientRect(), list=document.querySelector('.inspect-tab-list');return add.width===28&&add.right<=toggle.left&&list.scrollWidth>list.clientWidth})()"));
  win.setSize(1440, 620);
  await guest.executeJavaScript("document.title='页面甲'");
  await wait(async () => await evaluate("innerWidth===1440 && document.querySelector('.inspect-tab.active .inspect-tab-label').textContent==='页面甲'"));
  console.log(`Top header passed: aligned tabs, ${formerTabHeight}px extra content height, native switch/close/add menu, panel toggle, long titles and preserved guest/input.`);
}
