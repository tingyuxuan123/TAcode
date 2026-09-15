import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import type { IpcMainInvokeEvent, WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => unknown>() }));
vi.mock("electron", () => ({ ipcMain: { handle: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler), removeHandler: (name: string) => handlers.delete(name) } }));
import { parseGitCommitInfoRequest, parseGitCommitRequest, parseGitMutationRequest, parseGitSubscribeRequest, registerGitIpc } from "./git-ipc";
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
    expect(parseGitSubscribeRequest({ ...valid, query: { kind: "turn", snapshotId: "a".repeat(64) } }))
      .toEqual({ ...valid, query: { kind: "turn", snapshotId: "a".repeat(64) } });
    for (const bad of [{ ...valid, query: { kind: "turn", snapshotId: "HEAD" } }, { ...valid, query: { kind: "turn" } }, { ...valid, query: { kind: "turn", snapshotId: "a".repeat(63) } }])
      expect(() => parseGitSubscribeRequest(bad)).toThrow();
  });

  it("serves the last-turn scope only to the main frame and reports a disabled service instead of live content", async () => {
    const emitter = new EventEmitter(); const mainFrame = {};
    const host = Object.assign(emitter, { id: 7, mainFrame, send: vi.fn(), isDestroyed: () => false }) as unknown as WebContents;
    const registration = registerGitIpc({ host: () => host, recoveryRoot: path.join(os.tmpdir(), "tacode-git-ipc-unused"), resolveProject: async (project) => project });
    dispose = registration.dispose;
    const turn = handlers.get("git:turn-snapshot")!;
    expect(() => turn({ sender: {}, senderFrame: {} }, os.tmpdir())).toThrow("main frame");
    const event = { sender: host, senderFrame: mainFrame } as IpcMainInvokeEvent;
    expect(() => turn(event, ".")).toThrow();
    await expect(turn(event, os.tmpdir())).resolves.toMatchObject({ kind: "failed", projectRoot: os.tmpdir() });
  });

  it("rejects browser guests/subframes and cancels pending work on main-frame navigation", async () => {    const emitter = new EventEmitter(); const mainFrame = {};
    const host = Object.assign(emitter, { id: 5, mainFrame, send: vi.fn(), isDestroyed: () => false }) as unknown as WebContents;
    let allow!: (project: string) => void;
    const registration = registerGitIpc({ host: () => host, recoveryRoot: path.join(os.tmpdir(), "tacode-git-ipc-unused"), resolveProject: () => new Promise((resolve) => { allow = resolve; }) });
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

  it("accepts only snapshot identifiers and known operation targets, never renderer patches or paths", () => {
    const request = { subscriptionId: "sub", snapshotId: "a".repeat(64), action: "stage", target: { kind: "hunks", fileId: "b".repeat(64), hunkIds: ["c".repeat(64)] } };
    expect(parseGitMutationRequest(request)).toEqual(request);
    for (const bad of [{ ...request, action: "reset" }, { ...request, snapshotId: "HEAD" }, { ...request, target: { kind: "file", path: "../secret" } },
      { ...request, target: { ...request.target, hunkIds: [] } }, { ...request, target: { ...request.target, hunkIds: Array(1001).fill("c".repeat(64)) } }]) expect(() => parseGitMutationRequest(bad)).toThrow();
  });

  it("accepts bounded commit actions and rejects unsafe push targets", () => {
    const valid = { subscriptionId: "sub", snapshotId: "a".repeat(64), action: "commitAndPush", message: "publish", target: { remote: "origin", branch: "main" } };
    expect(parseGitCommitRequest(valid)).toEqual(valid);
    expect(parseGitCommitInfoRequest({ subscriptionId: "sub", snapshotId: "a".repeat(64) })).toEqual({ subscriptionId: "sub", snapshotId: "a".repeat(64) });
    for (const bad of [
      { ...valid, action: "amend" },
      { ...valid, message: "\0unsafe" },
      { ...valid, target: { remote: "origin", branch: "" } },
      { ...valid, target: { remote: "origin", branch: "../outside" } },
      { ...valid, snapshotId: "HEAD" },
      { ...valid, action: "push", message: "x".repeat(10_001) },
    ]) expect(() => parseGitCommitRequest(bad)).toThrow();
  });
});
