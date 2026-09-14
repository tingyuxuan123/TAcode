import { describe, expect, it, vi } from "vitest";
import type { FileDocument, FilesApi, FileUpdate, ProjectPath } from "../../shared/files";
import { FileDocumentStore } from "./file-document-store";

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function document(request: ProjectPath, content: string): FileDocument {
  return { ...request, kind: "document", status: "text", content, version: content, metadata: { size: content.length, readBytes: content.length, mode: 420, bom: false, lineEnding: "lf", writable: true, encoding: "utf8", offset: 0 } };
}
function fixture() {
  const listeners = new Set<(update: FileUpdate) => void>(); let id = 0;
  const api = { readDocument: vi.fn(async (request: ProjectPath) => document(request, request.projectRoot)), subscribe: vi.fn(async () => ({ mode: "native" as const })), unsubscribe: vi.fn(async (_id: string) => {}),
    onUpdate: (listener: (update: FileUpdate) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const store = new FileDocumentStore(api as unknown as FilesApi, () => `subscription-${++id}`);
  const send = (sequence: number, extra: Partial<FileUpdate> = {}) => { for (const listener of listeners) listener({ projectRoot: "/a", path: "same.txt", subscriptionId: "subscription-1", sequence, kind: "changed", ...extra }); };
  return { api, store, listeners, send };
}
describe("project disk documents", () => {
  it("shares one read and native subscription across two session views, releasing only after both leave", async () => {
    const { api, store, listeners } = fixture(); const first = store.connect("/a", "same.txt"); const second = store.connect("/a", "same.txt"); await tick();
    expect(api.readDocument).toHaveBeenCalledTimes(1); expect(api.subscribe).toHaveBeenCalledTimes(1); expect(store.snapshot("/a", "same.txt").document?.content).toBe("/a");
    first(); first(); expect(api.unsubscribe).not.toHaveBeenCalled(); expect(listeners.size).toBe(1);
    second(); expect(api.unsubscribe).toHaveBeenCalledTimes(1); expect(listeners.size).toBe(0); expect(store.stats().subscriptions).toBe(0);
  });
  it("isolates identical paths in different projects", async () => {
    const { store, api } = fixture(); const a = store.connect("/a", "same.txt"); const b = store.connect("/b", "same.txt"); await tick();
    expect(api.subscribe).toHaveBeenCalledTimes(2); expect(store.snapshot("/a", "same.txt").document?.content).toBe("/a"); expect(store.snapshot("/b", "same.txt").document?.content).toBe("/b"); a(); b();
  });
  it("rejects foreign events, duplicate sequences and older read completions", async () => {
    const { store, api, send } = fixture(); const old = deferred<FileDocument>(); const newer = deferred<FileDocument>();
    api.readDocument.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => newer.promise);
    const close = store.connect("/a", "same.txt");
    send(100, { projectRoot: "/b" }); send(100, { path: "other.txt" }); send(100, { subscriptionId: "foreign" }); expect(api.readDocument).toHaveBeenCalledTimes(1);
    send(2); send(2); send(1); expect(api.readDocument).toHaveBeenCalledTimes(2);
    newer.resolve(document({ projectRoot: "/a", path: "same.txt" }, "new")); await tick(); old.resolve(document({ projectRoot: "/a", path: "same.txt" }, "old")); await tick();
    expect(store.snapshot("/a", "same.txt").document?.content).toBe("new"); close();
  });
  it("cleans a late subscription and ignores reads after disconnect/reconnect", async () => {
    const { store, api, listeners } = fixture(); const subscription = deferred<{ mode: "native" }>(); const read = deferred<FileDocument>();
    api.subscribe.mockImplementationOnce(() => subscription.promise); api.readDocument.mockImplementationOnce(() => read.promise);
    const close = store.connect("/a", "same.txt"); close(); const again = store.connect("/a", "same.txt"); await tick();
    subscription.resolve({ mode: "native" }); read.resolve(document({ projectRoot: "/a", path: "same.txt" }, "late")); await tick();
    expect(api.unsubscribe.mock.calls.map(([id]) => id)).toEqual(["subscription-1", "subscription-1"]); expect(store.snapshot("/a", "same.txt").document?.content).toBe("/a");
    again(); expect(listeners.size).toBe(0);
  });
  it("keeps accepted content on a read failure and revalidates cached documents when activated", async () => {
    const { store, api, send } = fixture(); const close = store.connect("/a", "same.txt"); await tick();
    api.readDocument.mockRejectedValueOnce(new Error("read failure")); send(1); await tick();
    expect(store.snapshot("/a", "same.txt")).toMatchObject({ loading: false, error: { message: "read failure" }, document: { content: "/a" } });
    close(); const again = store.connect("/a", "same.txt"); await tick(); expect(store.snapshot("/a", "same.txt").error).toBeUndefined(); again();
  });
});
