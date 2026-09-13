import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { getTacodeArchivedSessionsDir, getTacodeSessionsDir } from "../runtime/home";
import { TacodeStateStore, type TacodeThread } from "../runtime/state";

/** 主进程共用连接。已知转录按路径合批，目录核对只负责遗漏/外部变化。 */
export class SessionIndex {
  private connection?: TacodeStateStore;
  private dirty = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private reconciliation?: Promise<void>;
  private flushing?: Promise<void>;
  private watchers: FSWatcher[] = [];
  private interval?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly options: {
    onChanged(): void;
    onRemoved?(threads: TacodeThread[]): void;
    onError?(error: unknown): void;
    createStore?(): TacodeStateStore;
    debounceMs?: number;
    reconcileMs?: number;
  }) {}

  get store(): TacodeStateStore {
    if (this.closed) throw new Error("Session index is closed");
    return this.connection ??= this.options.createStore?.() ?? new TacodeStateStore();
  }

  changed(file?: string): void {
    if (this.closed) return;
    if (file) this.dirty.add(path.resolve(file));
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error) => this.options.onError?.(error));
    }, this.options.debounceMs ?? 200);
  }

  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.flushing) return this.flushing.then(() => this.dirty.size ? this.flush() : undefined);
    const files = [...this.dirty];
    this.dirty.clear();
    const store = this.store;
    this.flushing = (async () => {
      for (const file of files) {
        const previous = store.findBySessionPath(file);
        const next = await store.indexSession(file);
        if (previous && !next && !store.get(previous.id)) this.options.onRemoved?.([previous]);
      }
      if (!this.closed) this.options.onChanged();
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.reconciliation) {
      const store = this.store;
      const before = store.list({ includeArchived: true });
      this.reconciliation = store.refresh().then(() => {
        if (this.closed) return;
        const present = new Set(store.list({ includeArchived: true }).map((row) => row.id));
        this.options.onRemoved?.(before.filter((row) => !present.has(row.id)));
        this.options.onChanged();
      }).finally(() => { this.reconciliation = undefined; });
    }
    return this.reconciliation;
  }

  startWatching(): void {
    if (this.closed || this.interval) return;
    const report = (error: unknown) => this.options.onError?.(error);
    for (const directory of [getTacodeSessionsDir(), getTacodeArchivedSessionsDir()]) {
      try {
        const watcher = watch(directory, { recursive: true, persistent: false }, (_event, name) => {
          if (name?.endsWith(".jsonl")) this.changed(path.join(directory, name));
        });
        watcher.on("error", report);
        this.watchers.push(watcher);
      } catch (error) { report(error); }
    }
    // 网络盘/平台 watcher 丢失通知时仍能最终发现外部新增和删除。
    this.interval = setInterval(() => { void this.reconcile().catch(report); }, this.options.reconcileMs ?? 60_000);
    this.interval.unref();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    for (const watcher of this.watchers) watcher.close();
    await Promise.allSettled([this.flushing, this.reconciliation]);
    await this.connection?.idle();
    this.connection?.close();
    this.dirty.clear();
  }
}
