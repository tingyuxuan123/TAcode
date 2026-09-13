import type { BrowserWindow } from "electron";
import assert from "node:assert/strict";

/** Test the production SidebarNav, AccountMenu and Chat together, using native input. */
export async function verifySidebar(win: BrowserWindow): Promise<Buffer> {
  const evaluate = (script: string) => win.webContents.executeJavaScript(script);
  const read = () => evaluate(`(() => {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return null;
    return {
      width: sidebar.getBoundingClientRect().width,
      available: document.querySelector('.chat-body').clientWidth,
      panel: document.querySelector('.inspect-shell').getBoundingClientRect().width,
      stored: localStorage.getItem('tacode.sidebarCollapsed'),
      projectsVisible: getComputedStyle(document.querySelector('.thread-list')).display !== 'none',
      guest: document.querySelector('webview')?.getWebContentsId(),
      resizing: document.documentElement.classList.contains('is-resizing-panel'),
      action: document.querySelector('[role=status]')?.textContent,
      rename: document.querySelector('.session-rename')?.value,
      focus: document.activeElement?.className
    };
  })()`);
  const wait = async (predicate: (state: any) => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const state = await read();
      if (state && await predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Sidebar did not settle: ${JSON.stringify(await read())}`);
  };
  const click = async (selector: string, button: "left" | "right" = "left") => {
    const point = await evaluate(`(async () => {const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest',behavior:'instant'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: "mouseMove", ...point });
    win.webContents.sendInputEvent({ type: "mouseDown", button, clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: "mouseUp", button, clickCount: 1, ...point });
  };
  const initial = await wait((state) => state.width === 252 && !!state.guest);
  await evaluate("window.__sidebarSession = document.querySelector('[data-fixture-session]')");
  await click(".sidebar-toggle");
  const collapsed = await wait((state) => state.width === 56 && state.available === initial.available + 196);
  assert.equal(collapsed.stored, "true");
  assert.equal(collapsed.projectsVisible, true);
  assert(await evaluate("document.querySelectorAll('.project-row').length===2 && document.querySelectorAll('.project .session-row').length===4"));
  assert(await evaluate("Array.from(document.querySelectorAll('.project-row, .session-row')).every(el=>el.getBoundingClientRect().width>=28&&el.title&&el.getAttribute('aria-label')&&getComputedStyle(el.querySelector('.sidebar-short-label')).display!=='none')"));
  assert.equal(collapsed.guest, initial.guest);
  assert(await evaluate("Array.from(document.querySelectorAll('.sidebar-primary button, .sidebar-toggle, .sidebar .account')).every(el=>el.getBoundingClientRect().width>=28&&!!el.getAttribute('aria-label'))"));
  if (process.platform === "darwin") {
    assert(await evaluate("document.querySelector('.sidebar-toggle').getBoundingClientRect().top >= 30"), "toggle must stay below traffic lights");
    assert(await evaluate("document.querySelector('.chat-title').getBoundingClientRect().left >= 88"), "chat title must clear traffic lights");
  }

  // Compact projects and sessions remain directly selectable without expanding the sidebar.
  await click('.project-row[aria-label="TAcode"]');
  await wait(async (state) => state.width === 56 && (await evaluate("document.querySelector('[role=status]').textContent")) === "已切换项目：TAcode");
  assert(await evaluate("document.querySelector('.project-head.active .project-row').getAttribute('aria-label')==='TAcode'"));
  win.setSize(1440, 360);
  await wait(async () => await evaluate("document.querySelector('.thread-list').scrollHeight > document.querySelector('.thread-list').clientHeight"));
  await click('.session-row[aria-label="文档整理"]');
  await wait(async (state) => state.width === 56 && (await evaluate("document.querySelector('[role=status]').textContent")) === "已切换会话：文档整理");
  assert(await evaluate("document.querySelector('.thread-list').scrollTop>0 && document.querySelector('.session-row[aria-current=page]').getAttribute('aria-label')==='文档整理'"));
  win.setSize(1440, 620);
  await wait(async () => await evaluate("innerHeight>=600"));

  // Existing context-menu rename stays usable even though the rail itself is only 56px wide.
  await click('.session-row[aria-label="文档整理"]', "right");
  await wait(async () => await evaluate("!!document.querySelector('.session-menu')"));
  await click(".session-menu > button:nth-of-type(2)");
  await wait(async () => await evaluate("document.activeElement===document.querySelector('.session-rename') && document.querySelector('.session-rename')?.getBoundingClientRect().width>=200"));
  win.webContents.selectAll();
  await wait(async () => await evaluate("(() => {const input=document.querySelector('.session-rename');return input.selectionStart===0 && input.selectionEnd===input.value.length})()"));
  await win.webContents.insertText("文档更新");
  await wait(async () => await evaluate("document.querySelector('.session-rename')?.value==='文档更新'"));
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await wait(async () => (await evaluate("document.querySelector('[role=status]').textContent")) === "已重命名：文档更新");
  assert(await evaluate("document.querySelector('.session-row[aria-current=page]').getAttribute('aria-label')==='文档更新'"));

  await click('.sidebar-primary [aria-label="新对话"]');
  await wait(async () => (await evaluate("document.querySelector('[role=status]').textContent")) === "已新建对话");
  await click('.sidebar-primary [aria-label="项目"]');
  await wait(async () => (await evaluate("document.querySelector('[role=status]').textContent")) === "已打开项目");
  await click(".sidebar .account");
  await wait(async () => await evaluate("!!document.querySelector('.account-menu')"));
  await click(".account-menu > button");
  await wait(async () => (await evaluate("document.querySelector('[role=status]').textContent")) === "已打开设置");

  // The released sidebar space can be assigned to the browser using the real divider.
  const point = await evaluate("(() => {const r=document.querySelector('.inspect-resize').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+120)}})()");
  win.webContents.sendInputEvent({ type: "mouseMove", ...point });
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
  await wait((state) => state.resizing);
  win.webContents.sendInputEvent({ type: "mouseMove", x: 100, y: point.y, button: "left", modifiers: ["leftButtonDown"] });
  const widened = await wait((state) => state.panel === state.available - 320);
  assert(widened.panel > 1000);
  win.webContents.sendInputEvent({ type: "mouseUp", x: 100, y: point.y, button: "left", clickCount: 1 });
  await wait((state) => !state.resizing);

  await click(".sidebar-toggle");
  await wait((state) => state.width === 252 && state.projectsVisible && state.panel === state.available - 320);
  assert(await evaluate("window.__sidebarSession === document.querySelector('[data-fixture-session]')"), "folding must preserve project/session nodes");
  await click(".sidebar-toggle");
  const restored = await wait((state) => state.width === 56 && state.panel === widened.panel);
  assert.equal(restored.guest, initial.guest, "folding must not recreate the browser guest");
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const screenshot = (await win.webContents.capturePage()).toPNG();
  await new Promise<void>((resolve) => { win.webContents.once("did-finish-load", resolve); win.webContents.reload(); });
  await wait((state) => state.width === 56 && state.stored === "true" && state.panel === widened.panel);
  console.log(`Sidebar smoke passed: compact project/session switching, labels and scrolling, context rename, icon actions, preserved nodes/guest, ${widened.panel}px browser and persisted collapse.`);
  return screenshot;
}
