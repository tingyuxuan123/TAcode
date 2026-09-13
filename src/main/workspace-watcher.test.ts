import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { watch } from "node:fs";
import { WorkspaceWatchers } from "./workspace-watcher";

vi.mock("node:fs", () => ({ watch: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("batches paths per workspace and releases evicted/closed listeners and pending retries", async () => {
  vi.useFakeTimers();
  const entries: Array<{ change: (event: string, path: string | null) => void; emitter: EventEmitter; close: ReturnType<typeof vi.fn> }> = [];
  vi.mocked(watch).mockImplementation(((_root: string, _options: unknown, change: (event: string, path: string | null) => void) => {
    const emitter = new EventEmitter();
    const close = vi.fn();
    entries.push({ change, emitter, close });
    return Object.assign(emitter, { close });
  }) as unknown as typeof watch);
  const changed = vi.fn();
  const watchers = new WorkspaceWatchers(changed);
  watchers.watch("/a");
  watchers.watch("/b");
  entries[0].change("change", "src/a.ts");
  entries[0].change("change", "src/a.ts");
  entries[0].change("change", ".git/index");
  entries[1].change("change", "src/b.ts");
  await vi.advanceTimersByTimeAsync(200);
  expect(changed.mock.calls).toEqual([["/a", ["src/a.ts"]], ["/b", ["src/b.ts"]]]);
  watchers.watch("/c");
  watchers.watch("/d");
  expect(entries[0].close).toHaveBeenCalledOnce();
  entries[0].change("change", "late.ts");
  entries[0].emitter.emit("error", new Error("late"));
  entries[1].emitter.emit("error", new Error("retry"));
  watchers.close();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(watch).toHaveBeenCalledTimes(4);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  expect(watchers.watch("/a")).toBe(true);
  watchers.close();
});
