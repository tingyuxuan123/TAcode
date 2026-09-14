import { EventEmitter } from "node:events";
import os from "node:os";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => unknown>() }));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) } }));
import { parseGitSubscribeRequest, registerGitIpc } from "./git-ipc";
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; handlers.clear(); });

describe("Git IPC boundary", () => {
  it("requires an explicit absolute project, known comparison and bounded safe identifiers", () => {
    const valid = { projectRoot: os.tmpdir(), subscriptionId: "subscription-1", query: { kind: "commit", commit: "HEAD~1" } };
    expect(parseGitSubscribeRequest(valid)).toEqual(valid);
    for (const bad of [undefined, [], { ...valid, projectRoot: undefined }, { ...valid, projectRoot: "." }, { ...valid, subscriptionId: "has\nnewline" },
      { ...valid, query: { kind: "lastTurn" } }, { ...valid, query: { kind: "branch", base: "x\0y" } }, { ...valid, query: { kind: "commit", commit: "a".repeat(1025) } }]) {
      expect(() => parseGitSubscribeRequest(bad)).toThrow();
    }
  });

  it("rejects browser guests/subframes and cancels pending work on main-frame navigation", async () => {
    const emitter = new EventEmitter(); const mainFrame = {};
    const host = Object.assign(emitter, { id: 5, mainFrame, send: vi.fn(), isDestroyed: () => false }) as unknown as WebContents;
    let allow!: (project: string) => void;
    const registration = registerGitIpc({ host: () => host, resolveProject: () => new Promise((resolve) => { allow = resolve; }) });
    dispose = registration.dispose;
    const request = { projectRoot: os.tmpdir(), subscriptionId: "sub", query: { kind: "unstaged" } };
    const subscribe = handlers.get("git:subscribe")!;
    expect(() => subscribe({ sender: {}, senderFrame: {} }, request)).toThrow("main frame");
    expect(() => subscribe({ sender: host, senderFrame: {} }, request)).toThrow("main frame");
    const event = { sender: host, senderFrame: mainFrame } as IpcMainInvokeEvent;
    const pending = subscribe(event, request);
    expect(registration.service.stats().subscriptions).toBe(1);
    emitter.emit("did-start-navigation", {}, "file:///reload", false, true);
    allow(os.tmpdir()); await pending;
    expect(registration.service.stats()).toEqual({ projects: 0, subscriptions: 0, reads: 0 });
    expect(host.send).not.toHaveBeenCalled();
    dispose(); expect(emitter.listenerCount("did-start-navigation")).toBe(0);
  });
});
