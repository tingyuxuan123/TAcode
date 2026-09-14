import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { FileDocument, FileDraftWriteRequest, FileFailure, FilesApi, ProjectPath } from "../../shared/files";
import { pathWithin, type FileMutation } from "../../shared/files";

export interface FileDocumentState {
  key: string; document?: FileDocument; loading: boolean; error?: FileFailure; mode: "native" | "polling";
  draft?: FileDraftWriteRequest; dirty: boolean; saving: boolean; restored?: boolean;
  saveError?: FileFailure; draftError?: FileFailure; recoveryError?: FileFailure; recoveryLoading?: boolean;
  mutating?: boolean;
}
interface Entry {
  request: ProjectPath; state: FileDocumentState; listeners: Set<() => void>; users: number; serial: number; revision: number;
  checkpointed: number; timer?: ReturnType<typeof setTimeout>; persistence: Promise<void>; refreshAfterSave?: boolean;
  active?: { id: string; sequence: number; off(): void };
}
type DraftApi = Pick<FilesApi, "readDrafts" | "writeDraft" | "removeDraft">;
export const documentKey = (root: string, path: string): string => JSON.stringify([root, path]);
const failure = (error: unknown): FileFailure => ({ code: "failed", message: error instanceof Error ? error.message : String(error) });
export const editableDocument = (document?: FileDocument): boolean => Boolean(document?.version && document.content !== null
  && document.metadata.writable && (document.status === "text" || document.status === "empty"));

/** Disk versions and unsaved text are shared; session views keep their own position. */
export class FileDocumentStore {
  private readonly entries = new Map<string, Entry>();
  private readonly roots = new Map<string, Promise<void>>();
  private readonly saves = new Map<string, Promise<boolean>>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private readonly locks = new Set<ProjectPath>();
  constructor(private readonly api: FilesApi, private readonly id: () => string = () => crypto.randomUUID(), private readonly drafts?: DraftApi) {}
  subscribeAll = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  version = () => this.revision;
  list(root?: string): FileDocumentState[] { return [...this.entries.values()].filter((entry) => !root || entry.request.projectRoot === root).map((entry) => entry.state); }
  dirty(root?: string, paths?: readonly string[]): ProjectPath[] {
    return [...this.entries.values()].filter((entry) => entry.state.dirty && (!root || entry.request.projectRoot === root) && (!paths || paths.includes(entry.request.path))).map((entry) => entry.request);
  }
  private entry(root: string, path: string): Entry {
    const key = documentKey(root, path); let entry = this.entries.get(key);
    if (!entry) {
      entry = { request: { projectRoot: root, path }, state: { key, loading: true, mode: "native", dirty: false, saving: false, mutating: this.locked(root, path) },
        listeners: new Set(), users: 0, serial: 0, revision: 0, checkpointed: 0, persistence: Promise.resolve() };
      this.entries.set(key, entry);
    }
    return entry;
  }
  loadDrafts(root: string, retry = false): Promise<void> {
    if (!this.drafts) return Promise.resolve();
    const prior = this.roots.get(root); if (prior && !retry) return prior;
    const pending = (async () => {
      const result = await this.drafts!.readDrafts({ projectRoot: root, path: "" });
      if (result.kind === "error") throw new Error(result.error.message);
      for (const draft of result.drafts) {
        const entry = this.entry(root, draft.path);
        if (entry.state.dirty || entry.revision || draft.content === draft.baseContent) continue;
        this.publish(entry, { ...entry.state, draft, dirty: true, restored: true });
      }
    })();
    this.roots.set(root, pending); return pending;
  }
  snapshot = (root: string, path: string): FileDocumentState => this.entry(root, path).state;
  subscribe(root: string, path: string, listener: () => void): () => void {
    const entry = this.entry(root, path); entry.listeners.add(listener); return () => { entry.listeners.delete(listener); this.prune(); };
  }
  connect(root: string, path: string): () => void {
    const entry = this.entry(root, path); entry.users++;
    if (!entry.active) {
      const active = { id: this.id(), sequence: 0, off: () => {} }; entry.active = active;
      active.off = this.api.onUpdate((update) => {
        if (entry.active !== active || update.subscriptionId !== active.id || update.projectRoot !== root || update.path !== path || update.sequence <= active.sequence) return;
        active.sequence = update.sequence;
        if (update.kind === "error") this.publish(entry, { ...entry.state, mode: update.mode ?? entry.state.mode, error: update.error });
        else { if (update.mode) this.publish(entry, { ...entry.state, mode: update.mode }); void this.read(entry); }
      });
      void this.api.subscribe({ ...entry.request, subscriptionId: active.id, target: "document" }).then((result) => {
        if (entry.active !== active) { void this.api.unsubscribe(active.id).catch(() => {}); return; }
        if ("kind" in result) this.publish(entry, { ...entry.state, error: result.error });
        else this.publish(entry, { ...entry.state, mode: result.mode });
      }, (error: unknown) => { if (entry.active === active) this.fail(entry, error); });
      if (this.drafts) {
        this.publish(entry, { ...entry.state, recoveryLoading: true });
        void this.loadDrafts(root).then(() => {
          this.publish(entry, { ...entry.state, recoveryLoading: false, recoveryError: undefined });
          if (entry.active === active) void this.read(entry);
        }, (error) => { this.publish(entry, { ...entry.state, recoveryLoading: false, recoveryError: failure(error) }); if (entry.active === active) void this.read(entry); });
      } else void this.read(entry);
    }
    let closed = false;
    return () => {
      if (closed) return; closed = true;
      if (--entry.users > 0) return;
      const active = entry.active; entry.active = undefined; entry.serial++;
      active?.off(); if (active) void this.api.unsubscribe(active.id).catch(() => {});
      this.prune();
    };
  }
  refresh(root: string, path: string): void {
    const entry = this.entry(root, path); if (!entry.users) return;
    if (entry.state.recoveryError) void this.loadDrafts(root, true).then(() => { this.publish(entry, { ...entry.state, recoveryError: undefined }); return this.read(entry); }).catch((error) => this.publish(entry, { ...entry.state, recoveryError: failure(error) }));
    else void this.read(entry);
  }
  edit(root: string, path: string, content: string): void {
    const entry = this.entry(root, path); const state = entry.state;
    if (this.locked(root, path)) return;
    if (!state.draft && (!editableDocument(state.document) || state.recoveryLoading || state.recoveryError)) return;
    const dirty = content !== state.document?.content;
    const draft = dirty ? { ...(state.draft ?? { ...entry.request, baseContent: state.document!.content!, baseVersion: state.document!.version!, lineEnding: state.document!.metadata.lineEnding }), content } : undefined;
    entry.revision++;
    this.publish(entry, { ...state, draft, dirty, saveError: undefined, restored: false }); this.schedule(entry);
  }
  conflict(root: string, path: string): boolean {
    const state = this.snapshot(root, path); return Boolean(state.draft && state.document && state.document.version !== state.draft.baseVersion);
  }
  save(root: string, path: string, expectedVersion?: string): Promise<boolean> {
    const entry = this.entry(root, path); const prior = this.saves.get(entry.state.key); if (prior) return prior;
    const draft = entry.state.draft; if (!draft) return Promise.resolve(true);
    const editRevision = entry.revision;
    if (!expectedVersion && this.conflict(root, path)) {
      this.publish(entry, { ...entry.state, saveError: { code: "conflict", message: "Document changed on disk" } }); return Promise.resolve(false);
    }
    entry.serial++;
    this.publish(entry, { ...entry.state, saving: true, saveError: undefined });
    const pending = Promise.resolve().then(async () => {
      try {
        const result = await this.api.writeDocument({ ...entry.request, content: draft.content, expectedVersion: expectedVersion ?? draft.baseVersion });
        if (result.kind === "error") {
          this.publish(entry, { ...entry.state, saving: false, saveError: result.error });
          if (result.error.code === "conflict") await this.read(entry, true);
          return false;
        }
        const current = entry.revision === editRevision ? result.document.content : entry.state.draft?.content ?? entry.state.document?.content;
        const remaining = current !== undefined && current !== null && current !== result.document.content ? { ...entry.request, content: current,
          baseContent: result.document.content!, baseVersion: result.document.version!, lineEnding: result.document.metadata.lineEnding } : undefined;
        entry.revision++;
        this.publish(entry, { ...entry.state, document: result.document, draft: remaining, dirty: Boolean(remaining), saving: true, saveError: undefined, restored: false });
        await this.checkpoint(entry);
        this.publish(entry, { ...entry.state, saving: false });
        return true;
      } catch (error) {
        this.publish(entry, { ...entry.state, saving: false, saveError: failure(error) }); return false;
      } finally {
        this.saves.delete(entry.state.key);
        if (entry.refreshAfterSave) { entry.refreshAfterSave = false; if (entry.users) void this.read(entry); }
      }
    });
    this.saves.set(entry.state.key, pending); return pending;
  }
  async discard(root: string, path: string): Promise<void> {
    const entry = this.entry(root, path); if (entry.state.saving) throw new Error("Wait for the active save to finish");
    entry.revision++;
    this.publish(entry, { ...entry.state, draft: undefined, dirty: false, restored: false, saveError: undefined });
    await this.checkpoint(entry); if (entry.users) void this.read(entry);
  }
  async flush(): Promise<void> {
    const results = await Promise.allSettled([...this.entries.values()].filter((entry) => entry.revision !== entry.checkpointed || entry.state.draftError).map((entry) => this.checkpoint(entry)));
    const failed = results.find((result) => result.status === "rejected"); if (failed?.status === "rejected") throw failed.reason;
  }
  trackOperation<T>(pending: Promise<T>): Promise<T> {
    this.operations.add(pending); void pending.catch(() => {}).finally(() => this.operations.delete(pending)); return pending;
  }
  async waitForSaves(): Promise<void> { await Promise.allSettled([...this.saves.values(), ...this.operations]); }
  private locked(root: string, path: string): boolean { return [...this.locks].some((lock) => lock.projectRoot === root && pathWithin(path, lock.path)); }
  lock(root: string, path: string): () => void {
    if ([...this.locks].some((lock) => lock.projectRoot === root && (pathWithin(path, lock.path) || pathWithin(lock.path, path)))) throw new Error("A file operation is already in progress");
    const lock = { projectRoot: root, path }; this.locks.add(lock);
    for (const entry of this.entries.values()) if (entry.request.projectRoot === root && pathWithin(entry.request.path, path)) this.publish(entry, { ...entry.state, mutating: true });
    return () => { this.locks.delete(lock); for (const entry of this.entries.values()) if (entry.request.projectRoot === root && pathWithin(entry.request.path, path)) this.publish(entry, { ...entry.state, mutating: this.locked(root, entry.request.path) }); };
  }
  applyMutation(mutation: FileMutation): void {
    for (const entry of this.entries.values()) if (entry.request.projectRoot === mutation.projectRoot && pathWithin(entry.request.path, mutation.path)) {
      entry.serial++;
      if (entry.users) void this.read(entry);
      else this.publish(entry, { ...entry.state, document: undefined, loading: true });
    }
  }
  hasPendingChanges(): boolean { return this.operations.size > 0 || [...this.entries.values()].some((entry) => entry.state.dirty || entry.state.saving || entry.revision !== entry.checkpointed); }
  stats(): { documents: number; subscriptions: number } { return { documents: this.entries.size, subscriptions: [...this.entries.values()].filter((entry) => entry.active).length }; }
  private schedule(entry: Entry): void {
    clearTimeout(entry.timer); entry.timer = setTimeout(() => { entry.timer = undefined; void this.checkpoint(entry).catch(() => {}); }, 200);
  }
  private checkpoint(entry: Entry): Promise<void> {
    clearTimeout(entry.timer); entry.timer = undefined;
    const work = async () => {
      if (entry.revision === entry.checkpointed && !entry.state.draftError) return;
      const revision = entry.revision; const draft = entry.state.draft;
      try {
        const result = this.drafts ? await (draft ? this.drafts.writeDraft(draft) : this.drafts.removeDraft(entry.request)) : { kind: "checkpointed" as const };
        if (result.kind === "error") throw new Error(result.error.message);
        entry.checkpointed = revision;
        this.publish(entry, { ...entry.state, draftError: undefined });
      } catch (error) { this.publish(entry, { ...entry.state, draftError: failure(error) }); throw error; }
    };
    const pending = entry.persistence.then(work, work); entry.persistence = pending.catch(() => {}); return pending;
  }
  private publish(entry: Entry, state: FileDocumentState): void {
    entry.state = state; this.revision++; for (const listener of entry.listeners) listener(); for (const listener of this.listeners) listener();
  }
  private fail(entry: Entry, error: unknown): void { this.publish(entry, { ...entry.state, loading: false, error: failure(error) }); }
  private async read(entry: Entry, force = false): Promise<void> {
    if (entry.state.saving) { entry.refreshAfterSave = true; return; }
    const serial = ++entry.serial;
    this.publish(entry, { ...entry.state, loading: true, error: undefined });
    try {
      const result = await this.api.readDocument(entry.request);
      if ((!entry.users && !force) || serial !== entry.serial) return;
      if (result.kind === "error") { this.publish(entry, { ...entry.state, loading: false, error: result.error }); return; }
      const matchesDraft = entry.state.draft?.content === result.content;
      if (matchesDraft) { entry.revision++; this.schedule(entry); }
      this.publish(entry, { ...entry.state, loading: false, error: undefined, document: result,
        ...(matchesDraft ? { draft: undefined, dirty: false, restored: false, saveError: undefined } : {}) });
    } catch (error) { if ((entry.users || force) && serial === entry.serial) this.fail(entry, error); }
  }
  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 24) break;
      if (!entry.users && !entry.listeners.size && !entry.state.dirty && !entry.state.saving && entry.checkpointed === entry.revision && !entry.timer) this.entries.delete(key);
    }
  }
}
let store: FileDocumentStore | undefined;
export function fileDocuments(): FileDocumentStore { return store ??= new FileDocumentStore(window.harness.files, undefined, window.harness.files); }
export function useFileDocuments() { const client = fileDocuments(); useSyncExternalStore(client.subscribeAll, client.version); return client; }
export function useFileDirtyKeys(): string {
  const client = fileDocuments();
  return useSyncExternalStore(client.subscribeAll, () => JSON.stringify(client.dirty()));
}
export function useFileDocument(root: string, path: string, active: boolean) {
  const client = fileDocuments();
  const subscribe = useCallback((listener: () => void) => client.subscribe(root, path, listener), [client, root, path]);
  const snapshot = useCallback(() => client.snapshot(root, path), [client, root, path]);
  const state = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => active ? client.connect(root, path) : undefined, [client, root, path, active]);
  return { ...state, refresh: () => client.refresh(root, path), edit: (content: string) => client.edit(root, path, content),
    save: (version?: string) => client.save(root, path, version), discard: () => client.discard(root, path), conflict: client.conflict(root, path) };
}
