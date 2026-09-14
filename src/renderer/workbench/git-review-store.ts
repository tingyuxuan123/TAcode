import { gitReviewQueryKey, type GitApi, type GitReviewQuery, type GitReviewResult, type GitSubscribeRequest, type GitWatchMode } from "../../shared/git";

export interface GitReviewState {
  key: string;
  loading: boolean;
  result?: GitReviewResult;
  watchMode: GitWatchMode;
}
export const gitReviewStateKey = (projectRoot: string, query: GitReviewQuery) => JSON.stringify([projectRoot, gitReviewQueryKey(query)]);

/** The same cancellation rules are used by React and exercised without a DOM. */
export class GitReviewStore {
  private state: GitReviewState = { key: "", loading: false, watchMode: "native" };
  private readonly listeners = new Set<() => void>();
  private active?: { request: GitSubscribeRequest; off(): void; sequence: number };
  constructor(private readonly api: GitApi, private readonly id: () => string = () => crypto.randomUUID()) {}
  getSnapshot = (): GitReviewState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(state: GitReviewState): void { this.state = state; for (const listener of this.listeners) listener(); }

  connect(projectRoot: string, query: GitReviewQuery): () => void {
    this.disconnect();
    const request: GitSubscribeRequest = { subscriptionId: this.id(), projectRoot, query };
    const key = gitReviewStateKey(projectRoot, query);
    this.publish({ key, loading: true, watchMode: "native", result: key === this.state.key ? this.state.result : undefined });
    const active = { request, off: () => {}, sequence: 0 };
    this.active = active;
    active.off = this.api.onUpdate((update) => {
      if (this.active !== active || update.subscriptionId !== request.subscriptionId || update.projectRoot !== projectRoot
        || gitReviewQueryKey(update.query) !== gitReviewQueryKey(query) || update.sequence <= active.sequence) return;
      active.sequence = update.sequence;
      this.publish({ key, loading: update.loading, result: update.result ?? this.state.result, watchMode: update.watchMode });
    });
    void this.api.subscribe(request).catch((error) => {
      if (this.active === active) this.publish({ key, loading: false, watchMode: "native", result: { kind: "error", error: { code: "failed", message: String(error) } } });
    });
    return () => { if (this.active === active) this.disconnect(); };
  }

  disconnect(): void {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.off();
    void this.api.unsubscribe(active.request.subscriptionId).catch(() => undefined);
  }
  refresh = (): void => {
    const active = this.active;
    if (!active) return;
    this.publish({ ...this.state, loading: true });
    void this.api.refresh(active.request.subscriptionId).catch((error) => {
      if (this.active === active) this.publish({ ...this.state, loading: false, result: { kind: "error", error: { code: "failed", message: String(error) } } });
    });
  };
}
