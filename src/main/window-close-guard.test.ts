import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
const { ipc } = vi.hoisted(() => ({ ipc: { on: vi.fn(), removeListener: vi.fn() } }));
vi.mock("electron", () => ({ ipcMain: ipc }));
import { WindowCloseGuard } from "./window-close-guard";
let guard: WindowCloseGuard | undefined;
afterEach(() => { guard?.dispose(); ipc.on.mockClear(); ipc.removeListener.mockClear(); });
function fixture() {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, send: vi.fn() });
  const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, close: vi.fn() });
  guard = new WindowCloseGuard(win as unknown as BrowserWindow);
  const ready = ipc.on.mock.calls.find(([channel]) => channel === "window:close-guard-ready")![1];
  const answer = ipc.on.mock.calls.find(([channel]) => channel === "window:close-answer")![1];
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainEvent;
  ready(event, true); return { win, contents, ready, answer, event, guard };
}
describe("main window close coordination", () => {
  it("cancels a native close and accepts exactly the current main-frame response", async () => {
    const { win, contents, answer, event } = fixture(); const preventDefault = vi.fn(); win.emit("close", { preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce(); expect(win.close).not.toHaveBeenCalled();
    const { id } = contents.send.mock.calls[0]![1];
    answer({ sender: {}, senderFrame: {} }, id, true); answer(event, "foreign", true); expect(win.close).not.toHaveBeenCalled();
    answer(event, id, false); await Promise.resolve(); expect(win.close).not.toHaveBeenCalled();
    win.emit("close", { preventDefault }); const next = contents.send.mock.calls[1]![1]; answer(event, next.id, true); await Promise.resolve();
    expect(win.close).toHaveBeenCalledOnce();
  });
  it("coalesces quit requests and cancels pending decisions after navigation or renderer failure", async () => {
    const { guard, contents, answer, event } = fixture(); const quit = guard.request("quit"); expect(guard.request("quit")).toBe(quit);
    expect(contents.send).toHaveBeenCalledOnce(); const { id } = contents.send.mock.calls[0]![1];
    contents.emit("did-start-navigation", {}, "file:///reload", false, true); expect(await quit).toBe(false);
    answer(event, id, true); expect(await guard.request("quit")).toBe(true);
  });
  it("disposes after Electron makes the closed window's webContents getter unavailable", () => {
    const { win, contents } = fixture();
    Object.defineProperty(win, "webContents", { get: () => { throw new Error("Object has been destroyed"); } });
    expect(() => win.emit("closed")).not.toThrow();
    expect(contents.listenerCount("did-start-navigation")).toBe(0);
  });
});
