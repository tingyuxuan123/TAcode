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
      finish = startResize(handle, event, currentX => { state.width = Math.max(220, Math.min(480, width + x - currentX)); layout(); }, () => { state.finishes++; state.active = false; });
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
