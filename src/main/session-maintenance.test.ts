import { describe, expect, it, vi } from "vitest";
import { SessionMaintenance } from "./session-maintenance";

function store() {
  return { indexSession: vi.fn(async () => undefined), refresh: vi.fn(async () => {}), close: vi.fn() };
}

describe("background history maintenance", () => {
  it("coalesces starts, publishes indexed batches, and closes the connection", async () => {
    let finish!: () => void;
    const state = store();
    const status = vi.fn();
    const changed = vi.fn();
    const maintenance = new SessionMaintenance({ onStatus: status, onChanged: changed, createStore: () => state, maintain: async (options) => {
      await options.onSession?.({ runtimePath: "/a.jsonl", storagePath: "/2026/a.jsonl" }, { completed: 1, total: 1 });
      await new Promise<void>((resolve) => { finish = resolve; });
    } });
    const job = maintenance.run();
    expect(maintenance.run()).toBe(job);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(maintenance.snapshot().state).toBe("running");
    expect(state.indexSession).toHaveBeenCalledWith("/a.jsonl");
    finish();
    await job;
    expect(maintenance.ready).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("keeps failed work retryable and cancellation never performs deletion reconciliation", async () => {
    const state = store();
    const maintain = vi.fn(async (): Promise<void> => { throw new Error("disk busy"); });
    const maintenance = new SessionMaintenance({ onStatus: () => {}, onChanged: () => {}, createStore: () => state, maintain });
    await maintenance.run();
    expect(maintenance.snapshot()).toMatchObject({ state: "failed", error: "disk busy" });
    maintain.mockImplementationOnce(async () => {});
    await maintenance.run();
    expect(maintenance.ready).toBe(true);
    expect(state.close).toHaveBeenCalledTimes(2);
    const abortedStore = store();
    const aborted = new SessionMaintenance({ onStatus: () => {}, onChanged: () => {}, createStore: () => abortedStore, maintain: async ({ signal }) => {
      await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    } });
    void aborted.run();
    await aborted.cancel();
    expect(aborted.snapshot().state).toBe("pending");
    expect(abortedStore.refresh).not.toHaveBeenCalled();
    expect(abortedStore.close).toHaveBeenCalledOnce();
  });
});
