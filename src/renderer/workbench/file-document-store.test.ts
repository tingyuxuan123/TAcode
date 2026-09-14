import { describe, expect, it, vi } from "vitest";
import type { DocumentWriteRequest, DocumentWriteResult, FileDocument, FileDraft, FileDraftWriteRequest, FilesApi, FileUpdate, ProjectPath } from "../../shared/files";
import { FileDocumentStore } from "./file-document-store";

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function document(request: ProjectPath, content: string): FileDocument {
  return { ...request, kind: "document", status: "text", content, version: content, metadata: { size: content.length, readBytes: content.length, mode: 420, bom: false, lineEnding: "lf", writable: true, encoding: "utf8", offset: 0 } };
}
function fixture(persist = false) {
  const listeners = new Set<(update: FileUpdate) => void>(); let id = 0;
  const api = { readDocument: vi.fn(async (request: ProjectPath) => document(request, request.projectRoot)), writeDocument: vi.fn(async (request: DocumentWriteRequest): Promise<DocumentWriteResult> => ({ kind: "saved", document: document(request, request.content) })),
    subscribe: vi.fn(async () => ({ mode: "native" as const })), unsubscribe: vi.fn(async (_id: string) => {}),
    onUpdate: (listener: (update: FileUpdate) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
  const saved = new Map<string, FileDraft>();
  const draftApi = { readDrafts: vi.fn(async ({ projectRoot }: ProjectPath) => ({ kind: "drafts" as const, drafts: [...saved.values()].filter((draft) => draft.projectRoot === projectRoot) })),
    writeDraft: vi.fn(async (draft: FileDraftWriteRequest) => { saved.set(JSON.stringify([draft.projectRoot, draft.path]), { ...draft, updatedAt: Date.now() }); return { kind: "checkpointed" as const }; }),
    removeDraft: vi.fn(async (request: ProjectPath) => { saved.delete(JSON.stringify([request.projectRoot, request.path])); return { kind: "checkpointed" as const }; }) };
  const store = new FileDocumentStore(api as unknown as FilesApi, () => `subscription-${++id}`, persist ? draftApi : undefined);
  const send = (sequence: number, extra: Partial<FileUpdate> = {}) => { for (const listener of listeners) listener({ projectRoot: "/a", path: "same.txt", subscriptionId: "subscription-1", sequence, kind: "changed", ...extra }); };
  return { api, store, listeners, send, draftApi, saved };
}
describe("project disk documents", () => {
  it("waits for a pending structural/external operation before leaving even with no dirty files", async () => {
    const { store } = fixture(); const operation = deferred<void>(); store.trackOperation(operation.promise);
    expect(store.hasPendingChanges()).toBe(true); let ready = false; const pending = store.waitForSaves().then(() => { ready = true; });
    await tick(); expect(ready).toBe(false); operation.resolve(); await pending; await tick(); expect(store.hasPendingChanges()).toBe(false);
  });
  it("locks a subtree across session views and newly opened documents, retaining dirty text until the operation ends", async () => {
    const { store } = fixture(true); const close = store.connect("/a", "dir/same.txt"); await vi.waitFor(() => expect(store.snapshot("/a", "dir/same.txt").loading).toBe(false));
    store.edit("/a", "dir/same.txt", "retain"); const unlock = store.lock("/a", "dir");
    expect(store.snapshot("/a", "dir/same.txt").mutating).toBe(true); expect(store.snapshot("/a", "dir/new.txt").mutating).toBe(true);
    store.edit("/a", "dir/same.txt", "blocked"); expect(store.snapshot("/a", "dir/same.txt").draft?.content).toBe("retain");
    expect(() => store.lock("/a", "dir/same.txt")).toThrow("already in progress");
    expect(store.snapshot("/b", "dir/same.txt").mutating).toBe(false); expect(store.snapshot("/a", "dirish/same.txt").mutating).toBe(false);
    unlock(); store.edit("/a", "dir/same.txt", "allowed"); expect(store.snapshot("/a", "dir/same.txt").draft?.content).toBe("allowed");
    await store.flush(); close();
  });
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
  it("keeps dirty text and its original base across external updates and saves an explicitly chosen version", async () => {
    const { store, api, send } = fixture(); const close = store.connect("/a", "same.txt"); await tick();
    store.edit("/a", "same.txt", "local"); api.readDocument.mockResolvedValue(document({ projectRoot: "/a", path: "same.txt" }, "external")); send(1); await tick();
    expect(store.snapshot("/a", "same.txt")).toMatchObject({ document: { content: "external" }, draft: { content: "local", baseContent: "/a", baseVersion: "/a" }, dirty: true });
    expect(await store.save("/a", "same.txt")).toBe(false); expect(api.writeDocument).not.toHaveBeenCalled();
    expect(await store.save("/a", "same.txt", "external")).toBe(true); expect(api.writeDocument).toHaveBeenCalledWith({ projectRoot: "/a", path: "same.txt", content: "local", expectedVersion: "external" });
    expect(store.snapshot("/a", "same.txt").dirty).toBe(false); close();
  });
  it("coalesces a pending save and retains newer edits using the saved disk version as their base", async () => {
    const { store, api, send } = fixture(true); await store.loadDrafts("/a"); const close = store.connect("/a", "same.txt"); await vi.waitFor(() => expect(store.snapshot("/a", "same.txt").loading).toBe(false));
    const write = deferred<DocumentWriteResult>(); api.writeDocument.mockImplementationOnce(() => write.promise); store.edit("/a", "same.txt", "submitted");
    const save = store.save("/a", "same.txt"); expect(store.save("/a", "same.txt")).toBe(save); await tick();
    store.edit("/a", "same.txt", "newer input"); send(1); expect(api.readDocument).toHaveBeenCalledTimes(1);
    api.readDocument.mockResolvedValue(document({ projectRoot: "/a", path: "same.txt" }, "submitted"));
    write.resolve({ kind: "saved", document: document({ projectRoot: "/a", path: "same.txt" }, "submitted") }); expect(await save).toBe(true); await tick();
    expect(store.snapshot("/a", "same.txt")).toMatchObject({ draft: { content: "newer input", baseContent: "submitted", baseVersion: "submitted" }, dirty: true, saving: false });
    await store.flush(); close();
  });
  it("retains failed saves, writes exact recovery text, and restores it in another store instance", async () => {
    const { store, api, draftApi, saved } = fixture(true); await store.loadDrafts("/a"); const close = store.connect("/a", "same.txt"); await vi.waitFor(() => expect(store.snapshot("/a", "same.txt").loading).toBe(false));
    store.edit("/a", "same.txt", "未保存\r\n文字"); api.writeDocument.mockRejectedValueOnce(new Error("permission denied"));
    expect(await store.save("/a", "same.txt")).toBe(false); expect(store.snapshot("/a", "same.txt").draft?.content).toBe("未保存\r\n文字");
    await store.flush(); expect(saved.size).toBe(1); close();
    const reopened = new FileDocumentStore(api as unknown as FilesApi, () => "reopened", draftApi); await reopened.loadDrafts("/a");
    expect(reopened.snapshot("/a", "same.txt")).toMatchObject({ dirty: true, restored: true, draft: { content: "未保存\r\n文字", baseVersion: "/a" } });
    await reopened.discard("/a", "same.txt"); expect(saved.size).toBe(0);
  });
  it("retains undo to the old disk baseline while a save is pending", async () => {
    const { store, api, saved } = fixture(true); await store.loadDrafts("/a"); const close = store.connect("/a", "same.txt");
    await vi.waitFor(() => expect(store.snapshot("/a", "same.txt").loading).toBe(false));
    const write = deferred<DocumentWriteResult>(); api.writeDocument.mockImplementationOnce(() => write.promise);
    store.edit("/a", "same.txt", "submitted"); const save = store.save("/a", "same.txt"); await tick();
    store.edit("/a", "same.txt", "/a"); expect(store.snapshot("/a", "same.txt").dirty).toBe(false);
    write.resolve({ kind: "saved", document: document({ projectRoot: "/a", path: "same.txt" }, "submitted") });
    expect(await save).toBe(true);
    expect(store.snapshot("/a", "same.txt")).toMatchObject({ document: { content: "submitted" }, draft: { content: "/a", baseContent: "submitted", baseVersion: "submitted" }, dirty: true });
    expect([...saved.values()][0]?.content).toBe("/a"); await store.discard("/a", "same.txt"); close();
  });
  it("never deletes recovery records after a failed restore and reports failed checkpoints", async () => {
    const { store, draftApi } = fixture(true); draftApi.readDrafts.mockRejectedValueOnce(new Error("damaged recovery"));
    const close = store.connect("/a", "same.txt"); await vi.waitFor(() => expect(store.snapshot("/a", "same.txt").recoveryError).toBeDefined());
    store.edit("/a", "same.txt", "should be blocked"); await store.flush(); expect(draftApi.removeDraft).not.toHaveBeenCalled(); expect(store.snapshot("/a", "same.txt").dirty).toBe(false);
    store.refresh("/a", "same.txt"); await vi.waitFor(() => expect(store.snapshot("/a", "same.txt").recoveryError).toBeUndefined());
    store.edit("/a", "same.txt", "protected text"); draftApi.writeDraft.mockRejectedValueOnce(new Error("disk full")); await expect(store.flush()).rejects.toThrow("disk full");
    expect(store.snapshot("/a", "same.txt")).toMatchObject({ dirty: true, draft: { content: "protected text" }, draftError: { message: "disk full" } });
    await store.flush(); close();
  });
});
