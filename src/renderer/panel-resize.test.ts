import { describe, expect, it, vi } from "vitest";
import { startPanelResize } from "./panel-resize";

function fixture() {
  const win = new EventTarget();
  const classes = new Set<string>();
  const doc = Object.assign(new EventTarget(), {
    defaultView: win, hidden: false,
    body: { style: { cursor: "crosshair", userSelect: "text" } },
    documentElement: { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name), contains: (name: string) => classes.has(name) } },
  });
  let captured = false;
  const handle = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    setPointerCapture: vi.fn(() => { captured = true; }),
    hasPointerCapture: () => captured,
    releasePointerCapture: vi.fn(() => { captured = false; }),
  });
  const move = vi.fn();
  const finish = vi.fn();
  const start = (overrides = {}) => startPanelResize(handle as unknown as HTMLElement, { pointerId: 7, button: 0, isPrimary: true, clientX: 500, preventDefault: vi.fn(), ...overrides }, move, finish);
  const pointer = (type: string, fields: Record<string, unknown> = {}, target: EventTarget = win) => {
    target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { pointerId: 7, buttons: 1, clientX: 400, ...fields }));
  };
  return { win, doc, handle, move, finish, start, pointer, classes };
}

describe("panel divider gesture", () => {
  it("stops resizing on release and restores the previous cursor/selection", () => {
    const f = fixture();
    f.start();
    expect(f.handle.setPointerCapture).toHaveBeenCalledWith(7);
    expect(f.classes.has("is-resizing-panel")).toBe(true);
    f.pointer("pointermove");
    expect(f.move).toHaveBeenCalledWith(400);
    f.pointer("pointerup", { buttons: 0 });
    f.pointer("pointermove", { clientX: 300 });
    expect(f.move).toHaveBeenCalledTimes(1);
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(f.classes.has("is-resizing-panel")).toBe(false);
    expect(f.doc.body.style).toEqual({ cursor: "crosshair", userSelect: "text" });
    expect(f.handle.releasePointerCapture).toHaveBeenCalledWith(7);
  });
  it("ends without changing width if pointerup was swallowed by a guest", () => {
    const f = fixture();
    f.start();
    f.pointer("pointermove");
    f.pointer("pointermove", { buttons: 0, clientX: 100 });
    f.pointer("pointermove", { buttons: 0, clientX: 900 });
    expect(f.move.mock.calls).toEqual([[400]]);
    expect(f.finish).toHaveBeenCalledTimes(1);
  });
  it.each(["pointercancel", "lostpointercapture", "blur", "hidden"])("ends on %s", (event) => {
    const f = fixture();
    f.start();
    if (event === "lostpointercapture") f.pointer(event, {}, f.handle);
    else if (event === "hidden") { f.doc.hidden = true; f.doc.dispatchEvent(new Event("visibilitychange")); }
    else if (event === "blur") f.win.dispatchEvent(new Event("blur"));
    else f.pointer(event);
    f.pointer("pointermove");
    expect(f.move).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(f.classes.size).toBe(0);
  });
  it("ignores other pointers and performs unmount cleanup only once", () => {
    const f = fixture();
    const dispose = f.start();
    f.pointer("pointermove", { pointerId: 8 });
    f.pointer("pointerup", { pointerId: 8 });
    expect(f.finish).not.toHaveBeenCalled();
    f.pointer("pointermove");
    expect(f.move).toHaveBeenCalledTimes(1);
    dispose();
    dispose();
    f.pointer("pointermove");
    f.win.dispatchEvent(new Event("blur"));
    expect(f.move).toHaveBeenCalledTimes(1);
    expect(f.finish).toHaveBeenCalledTimes(1);
  });
  it("ignores right-click and secondary touch", () => {
    const f = fixture();
    f.start({ button: 2 });
    f.start({ isPrimary: false });
    f.pointer("pointermove");
    expect(f.move).not.toHaveBeenCalled();
    expect(f.handle.setPointerCapture).not.toHaveBeenCalled();
  });
  it("still detects release if native pointer capture is unavailable", () => {
    const f = fixture();
    f.handle.setPointerCapture.mockImplementation(() => { throw new Error("capture unavailable"); });
    f.start();
    f.pointer("pointermove", { buttons: 0 });
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(f.move).not.toHaveBeenCalled();
  });
});
