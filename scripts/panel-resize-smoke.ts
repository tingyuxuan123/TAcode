import type { BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { startPanelResize } from "../src/renderer/panel-resize";

/** Verify the shared resize gesture with native host input crossing a real webview. */
export async function verifyPanelResize(win: BrowserWindow) {
  await win.webContents.executeJavaScript(`(() => {
    const startResize = ${startPanelResize.toString()};
    const panel = document.querySelector('.browser-panel');
    const originalStyle = panel.getAttribute('style');
    const handle = document.createElement('div');
    handle.id = 'smoke-resize';
    Object.assign(handle.style, { position: 'fixed', top: '0', bottom: '0', width: '8px', zIndex: '99999', cursor: 'col-resize', touchAction: 'none' });
    document.body.append(handle);
    const state = window.__resizeSmoke = { width: 440, finishes: 0, active: false };
    let finish;
    const layout = () => {
      Object.assign(panel.style, { position: 'fixed', right: '0', top: '0', width: state.width + 'px', height: '100%' });
      handle.style.left = (innerWidth - state.width - 4) + 'px';
    };
    layout();
    handle.addEventListener('pointerdown', event => {
      const x = event.clientX;
      const width = state.width;
      state.active = true;
      finish = startResize(handle, event, currentX => { state.width = Math.max(220, Math.min(innerWidth - 320, width + x - currentX)); layout(); }, () => { state.finishes++; state.active = false; });
    });
    window.__cleanupResizeSmoke = () => {
      finish?.();
      handle.remove();
      if (originalStyle === null) panel.removeAttribute('style'); else panel.setAttribute('style', originalStyle);
    };
  })()`);
  const read = () => win.webContents.executeJavaScript(`({ ...window.__resizeSmoke, paused: document.documentElement.classList.contains('is-resizing-panel'), guestPointerEvents: getComputedStyle(document.querySelector('webview')).pointerEvents, divider: document.querySelector('#smoke-resize').getBoundingClientRect().x + 4 })`);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 40));
  try {
    const initial = await read();
    const x = Math.round(initial.divider);
    win.webContents.sendInputEvent({ type: "mouseMove", x, y: 300 });
    win.webContents.sendInputEvent({ type: "mouseDown", x, y: 300, button: "left", clickCount: 1 });
    await flush();
    const started = await read();
    assert.equal(started.active, true, "native pointerdown should start the resize");
    assert.equal(started.paused, true);
    assert.equal(started.guestPointerEvents, "none", "webview must not steal pointerup while dragging");
    win.webContents.sendInputEvent({ type: "mouseMove", x: x + 110, y: 300, button: "left", modifiers: ["leftButtonDown"] });
    await flush();
    const dragged = await read();
    assert.equal(dragged.width, initial.width - 110);
    win.webContents.sendInputEvent({ type: "mouseUp", x: x + 110, y: 300, button: "left", clickCount: 1 });
    await flush();
    const released = await read();
    assert.equal(released.finishes, 1);
    assert.equal(released.active, false);
    assert.equal(released.paused, false);
    assert.notEqual(released.guestPointerEvents, "none", "webview interaction must resume after release");
    win.webContents.sendInputEvent({ type: "mouseMove", x: 200, y: 300 });
    win.webContents.sendInputEvent({ type: "mouseMove", x: 850, y: 300 });
    await flush();
    assert.equal((await read()).width, released.width, "unpressed mouse movement must not resize the panel");
    console.log("Panel resize smoke passed: native drag across webview, release, stable width and restored page interaction.");
  } finally {
    await win.webContents.executeJavaScript("window.__cleanupResizeSmoke()");
  }
}

/** Exercise the actual Chat layout, its stored width and ResizeObserver. */
export async function verifyAdaptivePanelWidth(win: BrowserWindow): Promise<Buffer> {
  const read = () => win.webContents.executeJavaScript(`(() => {
    const body = document.querySelector('.chat-body');
    const panel = document.querySelector('.inspect-shell');
    if (!body || !panel) return null;
    const divider = document.querySelector('.inspect-resize').getBoundingClientRect();
    return {
      available: body.clientWidth, panel: panel.getBoundingClientRect().width,
      chat: document.querySelector('.chat-main').getBoundingClientRect().width,
      bodyX: body.getBoundingClientRect().x, dividerX: divider.x + divider.width / 2,
      dividerY: divider.y + 120, stored: Number(localStorage.getItem('tether.inspectWidth')),
      sidebar: document.querySelector('.sidebar').getBoundingClientRect().width,
      collapsed: document.querySelector('.sidebar').classList.contains('is-collapsed'),
      manualCollapsed: localStorage.getItem('tether.sidebarCollapsed'),
      resizing: document.documentElement.classList.contains('is-resizing-panel'),
      guest: document.querySelector('webview')?.getWebContentsId()
    };
  })()`);
  const wait = async (predicate: (state: any) => boolean) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const state = await read();
      if (state && predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Adaptive width did not settle: ${JSON.stringify(await read())}`);
  };
  const initial = await wait((state) => !!state.guest && state.available > 1000 && state.sidebar === 252);
  const x = Math.round(initial.dividerX);
  const y = Math.round(initial.dividerY);
  const targetX = Math.round(initial.bodyX + 80);
  const comfortableX = Math.round(initial.bodyX + 440);
  const crowdedX = Math.round(initial.bodyX + 400);
  win.webContents.sendInputEvent({ type: "mouseMove", x, y });
  win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  await wait((state) => state.resizing);
  win.webContents.sendInputEvent({ type: "mouseMove", x: comfortableX, y, button: "left", modifiers: ["leftButtonDown"] });
  const comfortable = await wait((state) => state.chat === 440);
  assert.equal(comfortable.sidebar, 252, "roomy chat must not collapse the sidebar");
  await win.webContents.executeJavaScript(`(() => {
    window.__sidebarFrames = [];
    window.__recordSidebar = true;
    const sample = () => {
      if (!window.__recordSidebar) return;
      window.__sidebarFrames.push(document.querySelector('.sidebar').getBoundingClientRect().width);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })()`);
  win.webContents.sendInputEvent({ type: "mouseMove", x: crowdedX, y, button: "left", modifiers: ["leftButtonDown"] });
  const automatic = await wait((state) => state.sidebar === 56 && state.chat === 596);
  assert.equal(automatic.panel, initial.available - 400, "released sidebar space belongs to chat while the pointer is stationary");
  assert.equal(automatic.manualCollapsed, "false", "automatic collapse must not overwrite the manual preference");
  const animation = await win.webContents.executeJavaScript(`(() => {
    window.__recordSidebar = false;
    const style = getComputedStyle(document.querySelector('.sidebar'));
    return { frames: window.__sidebarFrames, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, duration: style.transitionDuration, timing: style.transitionTimingFunction };
  })()`);
  if (!animation.reduced) {
    assert.equal(animation.duration, "0.18s");
    assert.equal(animation.timing, "linear");
    assert(animation.frames.some((width: number) => width > 56 && width < 252), "collapse must render intermediate widths");
    assert(animation.frames.every((width: number, index: number, frames: number[]) => index === 0 || width <= frames[index - 1]), "collapse must not reverse direction during the gesture");
  }
  win.webContents.sendInputEvent({ type: "mouseMove", x: comfortableX, y, button: "left", modifiers: ["leftButtonDown"] });
  await wait((state) => state.chat === 636 && state.sidebar === 56);
  win.webContents.sendInputEvent({ type: "mouseMove", x: targetX, y, button: "left", modifiers: ["leftButtonDown"] });
  const expanded = await wait((state) => state.sidebar === 56 && state.panel === state.available - 320);
  assert(expanded.panel > 1000, "automatic collapse must release space for wider web pages");
  assert.equal(expanded.chat, 320);
  win.webContents.sendInputEvent({ type: "mouseUp", x: targetX, y, button: "left", clickCount: 1 });
  await wait((state) => !state.resizing && state.stored === expanded.panel);
  win.webContents.sendInputEvent({ type: "mouseMove", x: x + 50, y });
  assert.equal((await read()).panel, expanded.panel, "released pointer must not keep resizing");

  win.setSize(900, 620);
  const narrow = await wait((state) => state.available < initial.available && state.panel === state.available - 320);
  assert.equal(narrow.chat, 320);
  assert.equal(narrow.stored, expanded.panel, "a narrow window must not overwrite the user's preferred width");
  win.setSize(1440, 620);
  const restored = await wait((state) => state.panel === expanded.panel);
  assert.equal(restored.guest, initial.guest, "resizing must not recreate the browser guest");
  await win.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const screenshot = (await win.webContents.capturePage()).toPNG();
  // A manual expansion stays open until the next growing gesture. Releasing during
  // the next collapse must freeze the browser width even while the sidebar animates.
  const toggle = await win.webContents.executeJavaScript("(() => {const r=document.querySelector('.sidebar-toggle').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
  win.webContents.sendInputEvent({ type: "mouseMove", ...toggle });
  win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...toggle });
  win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...toggle });
  const manual = await wait((state) => state.sidebar === 252 && state.panel === state.available - 320);
  const fastX = Math.round(manual.dividerX);
  win.webContents.sendInputEvent({ type: "mouseMove", x: fastX, y });
  win.webContents.sendInputEvent({ type: "mouseDown", x: fastX, y, button: "left", clickCount: 1 });
  await wait((state) => state.resizing);
  win.webContents.sendInputEvent({ type: "mouseMove", x: fastX - 200, y, button: "left", modifiers: ["leftButtonDown"] });
  win.webContents.sendInputEvent({ type: "mouseUp", x: fastX - 200, y, button: "left", clickCount: 1 });
  const released = await wait((state) => !state.resizing && state.collapsed && state.stored === state.panel);
  const settled = await wait((state) => state.sidebar === 56);
  assert.equal(settled.panel, released.panel, "after release only chat may grow with the remaining sidebar animation");
  assert.equal(settled.guest, initial.guest);
  await new Promise<void>((resolve) => { win.webContents.once("did-finish-load", resolve); win.webContents.reload(); });
  await wait((state) => state.sidebar === 252 && state.stored === released.panel && state.panel === Math.min(released.panel, state.available - 320));
  console.log(`Adaptive panel width passed: automatic sidebar collapse at 420px, linear animation, no oscillation, ${expanded.panel}px browser, release during animation, preserved guest and manual preference.`);
  return screenshot;
}
