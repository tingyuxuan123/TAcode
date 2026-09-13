import { useCallback, useSyncExternalStore } from "react";
import type { DesktopApi } from "../shared/types";

export interface WorkspaceFilesSnapshot { entries: string[]; loading: boolean; error?: string }
const EMPTY: WorkspaceFilesSnapshot = { entries: [], loading: false };
interface Entry { snapshot: WorkspaceFilesSnapshot; listeners: Set<() => void>; job?: Promise<void>; again: boolean; force: boolean }

/** 文件面板与所有输入框共享一次 IPC 请求、一个变更订阅和同一份路径数组。 */
export class WorkspaceFilesClient {
  private roots = new Map<string, Entry>();
  private off?: () => void;
  constructor(private readonly api: Pick<DesktopApi["workspace"], "list" | "onChanged">) {}
  private entry(root: string): Entry {
    let entry = this.roots.get(root);
    if (!entry) { entry = { snapshot: { entries: [], loading: true }, listeners: new Set(), again: false, force: false }; this.roots.set(root, entry); }
    return entry;
  }
  snapshot(root: string): WorkspaceFilesSnapshot { return this.entry(root).snapshot; }
  subscribe(root: string, listener: () => void): () => void {
    const entry = this.entry(root);
    entry.listeners.add(listener);
    this.off ??= this.api.onChanged((changed) => { if (this.roots.get(changed)?.listeners.size) void this.refresh(changed); });
    if (!entry.job && entry.snapshot.loading) void this.refresh(root);
    return () => {
      entry.listeners.delete(listener);
      if (![...this.roots.values()].some((item) => item.listeners.size)) { this.off?.(); this.off = undefined; }
      // 不保留无人使用的路径数组；主进程已负责有界缓存。
      if (!entry.listeners.size) this.roots.delete(root);
    };
  }
  refresh(root: string, force = false): Promise<void> {
    const entry = this.entry(root);
    entry.force ||= force;
    if (entry.job) { entry.again = true; return entry.job; }
    entry.job = (async () => {
      do {
        entry.again = false;
        const refresh = entry.force;
        entry.force = false;
        entry.snapshot = { ...entry.snapshot, loading: true, error: undefined };
        for (const listener of entry.listeners) listener();
        try { entry.snapshot = { entries: await this.api.list(root, refresh), loading: false }; }
        catch (error) { entry.snapshot = { ...entry.snapshot, loading: false, error: error instanceof Error ? error.message : String(error) }; }
        for (const listener of entry.listeners) listener();
      } while (entry.again);
    })().finally(() => { entry.job = undefined; });
    return entry.job;
  }
}

let client: WorkspaceFilesClient | undefined;
export function useWorkspaceFiles(root?: string) {
  client ??= new WorkspaceFilesClient(window.harness.workspace);
  const store = client;
  const subscribe = useCallback((listener: () => void) => root ? store.subscribe(root, listener) : () => {}, [root, store]);
  const snapshot = useCallback(() => root ? store.snapshot(root) : EMPTY, [root, store]);
  const state = useSyncExternalStore(subscribe, snapshot);
  const refresh = useCallback(() => root ? store.refresh(root, true) : Promise.resolve(), [root, store]);
  return { ...state, refresh };
}
