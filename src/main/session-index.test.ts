import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeTacodeHome, getTacodeSessionsDir } from "../runtime/home";
import { TacodeStateStore } from "../runtime/state";
import { SessionIndex } from "./session-index";

let root: string;
let index: SessionIndex;
const session = (id: string) => path.join(getTacodeSessionsDir(), `${id}.jsonl`);
const transcript = (id: string) => JSON.stringify({ type: "session", id, cwd: "/fixture", timestamp: "2026-09-13T00:00:00Z" }) + "\n" + JSON.stringify({ type: "message", message: { role: "user", content: `问题 ${id}` } }) + "\n";
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "tacode-session-index-"));
  vi.stubEnv("TACODE_HOME", root);
  await initializeTacodeHome({ deferHistory: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await index?.close();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("shared session index", () => {
  it("coalesces changed paths and reads only the changed transcript among 1000 sessions", async () => {
    await Promise.all(Array.from({ length: 1000 }, (_, i) => fs.writeFile(session(String(i)), transcript(String(i)))));
    const createStore = vi.fn(() => new TacodeStateStore());
    const changed = vi.fn();
    index = new SessionIndex({ createStore, onChanged: changed });
    await index.reconcile();
    const read = vi.spyOn(fs, "readFile");
    const scan = vi.spyOn(fs, "readdir");
    changed.mockClear();
    await fs.appendFile(session("500"), JSON.stringify({ type: "session_info", name: "更新一条" }) + "\n");
    for (let i = 0; i < 30; i++) index.changed(session("500"));
    await index.flush();
    for (let i = 0; i < 30; i++) expect(index.store.list()).toHaveLength(1000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(scan).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledOnce();
    expect(createStore).toHaveBeenCalledOnce();
    expect(index.store.get("500")?.title).toBe("更新一条");
  });

  it("discovers external additions/removals and keeps pinned/archive changes through delayed indexing", async () => {
    const removed = vi.fn();
    index = new SessionIndex({ onChanged: () => {}, onRemoved: removed });
    await fs.writeFile(session("a"), transcript("a"));
    await index.reconcile();
    const row = index.store.get("a")!;
    index.store.setPinned("a", true);
    await fs.appendFile(row.storagePath, JSON.stringify({ type: "session_info", name: "已重命名" }) + "\n");
    const updating = index.store.indexSession(session("a"));
    const archiving = index.store.archive("a");
    await Promise.all([updating, archiving]);
    index.changed(row.sessionPath);
    index.changed(row.storagePath);
    await index.flush();
    await index.reconcile();
    expect(index.store.get("a")).toMatchObject({ title: "已重命名", pinned: true, archived: true });
    expect(index.store.list()).toEqual([]);
    await fs.writeFile(session("external"), transcript("external"));
    await index.reconcile();
    const external = index.store.get("external")!;
    await fs.unlink(external.sessionPath);
    await fs.unlink(external.storagePath);
    await index.reconcile();
    expect(index.store.get("external")).toBeUndefined();
    expect(removed).toHaveBeenLastCalledWith([expect.objectContaining({ id: "external" })]);
  });

  it("uses filesystem notifications for external files and releases watchers on close", async () => {
    const changed = vi.fn();
    index = new SessionIndex({ onChanged: changed, debounceMs: 10 });
    index.startWatching();
    await fs.writeFile(session("external"), transcript("external"));
    // macOS can batch fs.watch notifications for about one second. The default
    // 1000 ms assertion timeout races delivery when the full suite is busy.
    await vi.waitFor(() => expect(index.store.get("external")).toBeDefined(), { timeout: 3000 });
    await index.close();
    const calls = changed.mock.calls.length;
    await fs.writeFile(session("after-close"), transcript("after-close"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(changed).toHaveBeenCalledTimes(calls);
  });
});
