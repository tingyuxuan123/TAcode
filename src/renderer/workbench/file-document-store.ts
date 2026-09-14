import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { FileDocument, FileFailure, FilesApi, ProjectPath } from "../../shared/files";

export interface FileDocumentState { key: string; document?: FileDocument; loading: boolean; error?: FileFailure; mode: "native" | "polling" }
interface Entry { request: ProjectPath; state: FileDocumentState; listeners: Set<() => void>; users: number; serial: number; active?: { id: string; sequence: number; off(): void } }
export const documentKey = (root: string, path: string): string => JSON.stringify([root, path]);

/** Tabs from different sessions share disk content while keeping their own reading position. */
export class FileDocumentStore {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly api: FilesApi, private readonly id: () => string = () => crypto.randomUUID()) {}
  private entry(root: string, path: string): Entry {
    const key = documentKey(root, path); let entry = this.entries.get(key);
    if (!entry) { entry = { request: { projectRoot: root, path }, state: { key, loading: true, mode: "native" }, listeners: new Set(), users: 0, serial: 0 }; this.entries.set(key, entry); }
    return entry;
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
      void this.read(entry);
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
  refresh(root: string, path: string): void { const entry = this.entry(root, path); if (entry.users) void this.read(entry); }
  stats(): { documents: number; subscriptions: number } { return { documents: this.entries.size, subscriptions: [...this.entries.values()].filter((entry) => entry.active).length }; }
  private publish(entry: Entry, state: FileDocumentState): void { entry.state = state; for (const listener of entry.listeners) listener(); }
  private fail(entry: Entry, error: unknown): void { this.publish(entry, { ...entry.state, loading: false, error: { code: "failed", message: error instanceof Error ? error.message : String(error) } }); }
  private async read(entry: Entry): Promise<void> {
    const serial = ++entry.serial;
    this.publish(entry, { ...entry.state, loading: true, error: undefined });
    try {
      const result = await this.api.readDocument(entry.request);
      if (!entry.users || serial !== entry.serial) return;
      this.publish(entry, result.kind === "error" ? { ...entry.state, loading: false, error: result.error } : { ...entry.state, loading: false, error: undefined, document: result });
    } catch (error) { if (entry.users && serial === entry.serial) this.fail(entry, error); }
  }
  private prune(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 24) break;
      if (!entry.users && !entry.listeners.size) this.entries.delete(key);
    }
  }
}
let store: FileDocumentStore | undefined;
export function useFileDocument(root: string, path: string, active: boolean) {
  store ??= new FileDocumentStore(window.harness.files);
  const client = store;
  const subscribe = useCallback((listener: () => void) => client.subscribe(root, path, listener), [client, root, path]);
  const snapshot = useCallback(() => client.snapshot(root, path), [client, root, path]);
  const state = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => active ? client.connect(root, path) : undefined, [client, root, path, active]);
  return { ...state, refresh: () => client.refresh(root, path) };
}
