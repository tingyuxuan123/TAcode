import { randomUUID } from "node:crypto";
import { ipcMain, type BrowserWindow, type IpcMainEvent, type WebContents } from "electron";

/** Window close and application quit both wait for the renderer's durable checkpoint. */
export class WindowCloseGuard {
  private ready = false;
  private allowed = false;
  private pending?: { id: string; promise: Promise<boolean>; resolve(allow: boolean): void };
  private readonly contents: WebContents;
  constructor(private readonly window: BrowserWindow) {
    this.contents = window.webContents;
    ipcMain.on("window:close-guard-ready", this.onReady);
    ipcMain.on("window:close-answer", this.onAnswer);
    window.on("close", this.onClose);
    this.contents.on("did-start-navigation", this.onNavigation);
    this.contents.on("render-process-gone", this.onGone);
    window.once("closed", this.dispose);
  }
  private authorized(event: IpcMainEvent) { return event.sender === this.contents && event.senderFrame === event.sender.mainFrame; }
  private onReady = (event: IpcMainEvent, ready: unknown) => { if (this.authorized(event) && typeof ready === "boolean") this.ready = ready; };
  private onAnswer = (event: IpcMainEvent, id: unknown, allow: unknown) => {
    if (!this.authorized(event) || id !== this.pending?.id || typeof allow !== "boolean") return;
    const pending = this.pending; this.pending = undefined; pending?.resolve(allow);
  };
  private onNavigation = (_event: Electron.Event, _url: string, inPlace: boolean, main: boolean) => {
    if (main && !inPlace) { this.ready = false; this.cancel(); }
  };
  private onGone = () => { this.ready = false; this.cancel(); };
  private cancel() { const pending = this.pending; this.pending = undefined; pending?.resolve(false); }
  request(action: "close" | "quit"): Promise<boolean> {
    if (!this.ready || this.window.isDestroyed()) return Promise.resolve(true);
    if (this.pending) return this.pending.promise;
    let resolve!: (allow: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    const id = randomUUID(); this.pending = { id, promise, resolve };
    this.contents.send("window:close-request", { id, action }); return promise;
  }
  private onClose = (event: Electron.Event) => {
    if (this.allowed || !this.ready) return;
    event.preventDefault();
    void this.request("close").then((allow) => { if (allow && !this.window.isDestroyed()) { this.allowed = true; this.window.close(); } });
  };
  dispose = () => {
    this.cancel();
    ipcMain.removeListener("window:close-guard-ready", this.onReady); ipcMain.removeListener("window:close-answer", this.onAnswer);
    this.window.removeListener("close", this.onClose); this.contents.removeListener("did-start-navigation", this.onNavigation); this.contents.removeListener("render-process-gone", this.onGone);
  };
}
