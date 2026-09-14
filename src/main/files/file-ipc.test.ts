import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) } }));
import { registerFileIpc } from "./file-ipc";
let root: string; let registration: ReturnType<typeof registerFileIpc>; let host: WebContents; let event: IpcMainInvokeEvent;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-file-ipc-")); await fs.writeFile(path.join(root, "source"), "old");
  host = Object.assign(new EventEmitter(), { id: 9, mainFrame: {}, send: vi.fn(), isDestroyed: () => false }) as unknown as WebContents;
  event = { sender: host, senderFrame: host.mainFrame } as IpcMainInvokeEvent;
  registration = registerFileIpc({ host: () => host, resolveProject: async (value) => { if (value !== root) throw new Error("Unopened project"); return root; } });
});
afterEach(async () => { registration.dispose(); await registration.idle(); handlers.clear(); await fs.rm(root, { recursive: true, force: true }); });
const invoke = (channel: string, raw: unknown, owner = event) => handlers.get(channel)!(owner, raw);
const request = () => ({ projectRoot: root, path: "source" });

describe("production files IPC", () => {
  it("authenticates and validates structural/open requests and emits only real successful mutations", async () => {
    for (const channel of ["files:inspect", "files:mutate", "files:location", "files:editors", "files:open", "files:reveal"]) expect(await invoke(channel, request(), { sender: host, senderFrame: {} } as IpcMainInvokeEvent)).toMatchObject({ error: { code: "outsideProject" } });
    for (const raw of [{ ...request(), operation: "delete" }, { ...request(), operation: "rename", destination: 1 }, { ...request(), operation: "trash", expectedVersion: [] }]) expect(await invoke("files:mutate", raw)).toMatchObject({ error: { code: "invalidRequest" } });
    for (const raw of [{ ...request(), editor: "other" }, { ...request(), editor: "vscode", line: "1" }, { ...request(), editor: "system", column: 0 }]) expect(await invoke("files:open", raw)).toMatchObject({ error: { code: "invalidRequest" } });
    const target = await invoke("files:inspect", request());
    expect(await invoke("files:mutate", { ...request(), operation: "rename", destination: "moved", expectedVersion: target.version })).toMatchObject({ kind: "mutation", path: "source", destination: "moved" });
    expect(host.send).toHaveBeenCalledWith("files:mutation", { ...request(), kind: "mutation", operation: "rename", destination: "moved" });
    expect(await invoke("files:location", { ...request(), path: "moved" })).toMatchObject({ absolutePath: path.join(root, "moved") });
    expect(await fs.readFile(path.join(root, "moved"), "utf8")).toBe("old");
  });
  it("requires the workbench main frame and validates every request as structured failures", async () => {
    for (const owner of [{ sender: {}, senderFrame: {} }, { sender: host, senderFrame: {} }]) expect(await invoke("files:read-document", request(), owner as IpcMainInvokeEvent)).toMatchObject({ kind: "error", error: { code: "outsideProject" } });
    for (const raw of [undefined, [], { path: "source" }, { ...request(), projectRoot: "." }, { ...request(), path: "../secret" }, { ...request(), offset: "1" }, { ...request(), length: -1 }]) expect(await invoke("files:read-document", raw)).toMatchObject({ kind: "error", error: { code: "invalidRequest" } });
    for (const raw of [{ ...request(), limit: 501 }, { ...request(), cursor: 100 }, { ...request(), includeIgnored: "true" }]) expect(await invoke("files:directory", raw)).toMatchObject({ kind: "error", error: { code: "invalidRequest" } });
    expect(await invoke("files:search", { ...request(), query: [] })).toMatchObject({ error: { code: "invalidRequest" } });
    expect(await invoke("files:write-document", { ...request(), content: "mine" })).toMatchObject({ error: { code: "invalidRequest" } });
    expect(await invoke("files:subscribe", { ...request(), subscriptionId: "sub", target: "anything" })).toMatchObject({ error: { code: "invalidRequest" } });
    expect(await invoke("files:unsubscribe", "bad\nidentifier")).toMatchObject({ error: { code: "invalidRequest" } });
  });

  it("reads and atomically writes the real document with disk versions", async () => {
    const document = await invoke("files:read-document", request()); expect(document).toMatchObject({ kind: "document", content: "old" });
    const saved = await invoke("files:write-document", { ...request(), expectedVersion: document.version, content: "saved" });
    expect(saved).toMatchObject({ kind: "saved", document: { content: "saved" } }); expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe("saved");
    expect(await invoke("files:write-document", { ...request(), expectedVersion: document.version, content: "stale" })).toMatchObject({ kind: "error", error: { code: "conflict" } });
  });

  it("cancels pending subscriptions and writes during main-frame navigation, and removes all listeners on disposal", async () => {
    const document = await invoke("files:read-document", request());
    let release!: () => void; let entered!: () => void; const held = new Promise<void>((resolve) => { entered = resolve; });
    registration.dispose();
    let block = false;
    registration = registerFileIpc({ host: () => host, resolveProject: async () => {
      if (block) { block = false; entered(); await new Promise<void>((resolve) => { release = resolve; }); } return root;
    } });
    block = true;
    const subscription = invoke("files:subscribe", { ...request(), subscriptionId: "pending", target: "document" }); await held;
    (host as unknown as EventEmitter).emit("did-start-navigation", {}, "file:///reload", false, true); release();
    expect(await subscription).toMatchObject({ kind: "error", error: { code: "cancelled" } });
    expect(registration.service.subscriptions.stats()).toEqual({ roots: 0, subscriptions: 0, reads: 0 }); expect(host.send).not.toHaveBeenCalled();
    block = true; const write = invoke("files:write-document", { ...request(), expectedVersion: document.version, content: "mine" });
    await vi.waitFor(() => expect(block).toBe(false));
    (host as unknown as EventEmitter).emit("did-start-navigation", {}, "file:///reload", false, true); release();
    expect(await write).toMatchObject({ kind: "error", error: { code: "cancelled" } }); expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe("old");
    registration.dispose(); expect((host as unknown as EventEmitter).listenerCount("did-start-navigation")).toBe(0); expect(handlers.size).toBe(0);
  });
});
