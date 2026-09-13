import { describe, expect, it, vi } from "vitest";
import { SessionListLoader } from "./session-list-loader";

describe("session list requests", () => {
  it("rejects a pre-mutation response and combines concurrent refresh requests", async () => {
    let resolve!: (rows: string[]) => void;
    const load = vi.fn(() => new Promise<string[]>((done) => { resolve = done; }));
    const apply = vi.fn();
    const loader = new SessionListLoader(load, apply);
    const job = loader.refresh();
    loader.invalidate();
    for (let i = 0; i < 30; i++) void loader.refresh();
    resolve(["old title / unpinned / unarchived"]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(apply).not.toHaveBeenCalled();
    resolve(["renamed and pinned"]);
    await job;
    expect(apply).toHaveBeenCalledExactlyOnceWith(["renamed and pinned"]);
  });

  it("allows retry after a failed request", async () => {
    const load = vi.fn(async () => ["restored"]).mockRejectedValueOnce(new Error("offline"));
    const apply = vi.fn();
    const loader = new SessionListLoader(load, apply);
    await expect(loader.refresh()).rejects.toThrow("offline");
    await loader.refresh();
    expect(apply).toHaveBeenCalledExactlyOnceWith(["restored"]);
  });
});
