import { describe, expect, it, vi } from "vitest";
import type { GitApi, GitReviewUpdate } from "../../shared/git";
import { GitReviewStore, gitReviewStateKey } from "./git-review-store";

function fixture() {
  let serial = 0;
  const listeners = new Set<(update: GitReviewUpdate) => void>();
  const api: GitApi = { subscribe: vi.fn(async () => {}), unsubscribe: vi.fn(async () => {}), refresh: vi.fn(async () => {}),
    onUpdate: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const store = new GitReviewStore(api, () => `subscription-${++serial}`);
  const emit = (id: number, project: string, sequence: number, extra: Partial<GitReviewUpdate> = {}) => {
    const update: GitReviewUpdate = { subscriptionId: `subscription-${id}`, projectRoot: project, query: { kind: "unstaged" }, sequence, loading: false, watchMode: "native",
      result: { kind: "notRepository", projectRoot: project }, ...extra };
    for (const listener of listeners) listener(update);
  };
  return { store, api, listeners, emit };
}

describe("Git review response isolation", () => {
  it("rejects old subscriptions, wrong projects/scopes and out-of-order updates", () => {
    const { store, api, emit } = fixture();
    store.connect("/project-a", { kind: "unstaged" });
    emit(1, "/project-a", 1);
    expect(store.getSnapshot().result).toEqual({ kind: "notRepository", projectRoot: "/project-a" });
    const stopB = store.connect("/project-b", { kind: "unstaged" });
    expect(store.getSnapshot().result).toBeUndefined();
    emit(1, "/project-a", 100);
    emit(2, "/project-a", 101);
    emit(2, "/project-b", 102, { query: { kind: "staged" } });
    expect(store.getSnapshot().result).toBeUndefined();
    emit(2, "/project-b", 10, { result: { kind: "missingGit", projectRoot: "/project-b" } });
    emit(2, "/project-b", 9);
    expect(store.getSnapshot().result?.kind).toBe("missingGit");
    stopB();
    expect(api.unsubscribe).toHaveBeenCalledWith("subscription-1");
    expect(api.unsubscribe).toHaveBeenCalledWith("subscription-2");
  });

  it("keeps a same-scope snapshot while refreshing but clears it on a scope change", () => {
    const { store, emit } = fixture();
    store.connect("/a", { kind: "unstaged" });
    emit(1, "/a", 1);
    const result = store.getSnapshot().result;
    emit(1, "/a", 2, { loading: true, result: undefined });
    expect(store.getSnapshot()).toMatchObject({ loading: true, result });
    store.disconnect();
    store.connect("/a", { kind: "unstaged" });
    expect(store.getSnapshot().result).toBe(result);
    store.connect("/a", { kind: "staged" });
    expect(store.getSnapshot()).toEqual({ key: gitReviewStateKey("/a", { kind: "staged" }), loading: true, result: undefined, watchMode: "native" });
  });

  it("unsubscribes while subscribe is pending and ignores its late rejection", async () => {
    const { store, api, listeners } = fixture();
    let reject!: (error: Error) => void;
    vi.mocked(api.subscribe).mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const stop = store.connect("/a", { kind: "unstaged" });
    stop();
    expect(listeners.size).toBe(0);
    expect(api.unsubscribe).toHaveBeenCalledWith("subscription-1");
    store.connect("/b", { kind: "staged" });
    reject(new Error("old request failed"));
    await Promise.resolve();
    expect(store.getSnapshot().key).toBe(gitReviewStateKey("/b", { kind: "staged" }));
    expect(store.getSnapshot().result).toBeUndefined();
  });

  it("does not let an old effect cleanup disconnect the new subscription", () => {
    const { store, api, listeners } = fixture();
    const oldCleanup = store.connect("/a", { kind: "unstaged" });
    store.connect("/b", { kind: "staged" });
    oldCleanup(); store.refresh();
    expect(listeners.size).toBe(1);
    expect(api.refresh).toHaveBeenCalledWith("subscription-2");
  });
});
