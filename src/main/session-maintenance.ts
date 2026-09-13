import { maintainTacodeHome, type HomeMaintenanceOptions } from "../runtime/home";
import { TacodeStateStore } from "../runtime/state";
import type { SessionMaintenanceStatus } from "../shared/types";

/** 窗口出现后逐个整理并索引；重试共用一个任务，进度不阻塞现有列表。 */
export class SessionMaintenance {
  private state: SessionMaintenanceStatus = { state: "pending", completed: 0, total: 0, version: 0 };
  private version = 0;
  private job?: Promise<void>;
  private controller?: AbortController;

  constructor(private readonly options: {
    onStatus(status: SessionMaintenanceStatus): void;
    onChanged(): void;
    maintain?(options: HomeMaintenanceOptions): Promise<void>;
    createStore?(): Pick<TacodeStateStore, "indexSession" | "refresh" | "close">;
  }) {}

  snapshot(): SessionMaintenanceStatus { return { ...this.state }; }
  get ready(): boolean { return this.state.state === "ready"; }

  run(): Promise<void> {
    if (this.job) return this.job;
    if (this.ready) return Promise.resolve();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.publish({ state: "running", completed: 0, total: 0 });
    this.job = this.work(signal).finally(() => { this.job = undefined; this.controller = undefined; });
    return this.job;
  }

  async cancel(): Promise<void> {
    this.controller?.abort();
    await this.job;
  }

  private async work(signal: AbortSignal): Promise<void> {
    let store: Pick<TacodeStateStore, "indexSession" | "refresh" | "close"> | undefined;
    let lastPublish = 0;
    try {
      store = this.options.createStore?.() ?? new TacodeStateStore();
      await (this.options.maintain ?? maintainTacodeHome)({ signal, onSession: async (session, progress) => {
        await store!.indexSession(session.runtimePath);
        this.state = { state: "running", ...progress, version: ++this.version };
        if (Date.now() - lastPublish >= 200 || progress.completed === progress.total) {
          lastPublish = Date.now();
          this.options.onStatus(this.snapshot());
          this.options.onChanged();
        }
      } });
      signal.throwIfAborted();
      await store.refresh({ signal });
      this.publish({ ...this.state, state: "ready" });
      this.options.onChanged();
    } catch (error) {
      this.publish({ ...this.state, state: signal.aborted ? "pending" : "failed", error: signal.aborted ? undefined : String(error instanceof Error ? error.message : error) });
    } finally {
      store?.close();
    }
  }

  private publish(status: SessionMaintenanceStatus): void {
    this.state = { ...status, version: ++this.version };
    this.options.onStatus(this.snapshot());
  }
}
