import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { watch, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCUMENT_EDIT_BYTES, type FileUpdate } from "../../shared/files";
import { WorkspaceFileIndex } from "../workspace-file-index";
import { FileService } from "./file-service";

let directory: string; let root: string; let other: string; let service: FileService;
const request = (file: string) => ({ projectRoot: root, path: file });
const write = async (file: string, bytes: string | Buffer, target = root) => { const name = path.join(target, file); await fs.mkdir(path.dirname(name), { recursive: true }); await fs.writeFile(name, bytes); };
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-files-")); root = path.join(directory, "a"); other = path.join(directory, "b");
  await fs.mkdir(root); await fs.mkdir(other);
  service = new FileService({ resolveProject: async (value) => { if (value !== root && value !== other) throw new Error("Unopened project"); return value; } });
});
afterEach(async () => { service.close(); await service.idle(); await fs.rm(directory, { recursive: true, force: true }); });

describe("complete project files", () => {
  it("pages every directory entry, rejects stale/cross-scope cursors and browses hidden/ignored subtrees", async () => {
    for (let index = 0; index < 205; index++) await write(`dir/file-${String(index).padStart(3, "0")}.txt`, "x");
    await write(".hidden/deep.txt", "hidden"); await write("node_modules/pkg/entry.js", "generated");
    const first = await service.directory(request("dir"));
    expect(first.entries).toHaveLength(200); expect(first.total).toBe(205);
    const last = await service.directory({ ...request("dir"), cursor: first.cursor });
    expect(last.entries.map((entry) => entry.name)).toEqual(["file-200.txt", "file-201.txt", "file-202.txt", "file-203.txt", "file-204.txt"]);
    await expect(service.directory({ ...request(".hidden"), cursor: first.cursor })).rejects.toMatchObject({ code: "staleCursor" });
    await write("dir/new.txt", "new");
    await expect(service.directory({ ...request("dir"), cursor: first.cursor })).rejects.toMatchObject({ code: "staleCursor" });
    expect((await service.directory(request(".hidden"))).entries[0]?.path).toBe(".hidden/deep.txt");
    expect((await service.search({ ...request("node_modules"), query: "entry" })).entries[0]?.path).toBe("node_modules/pkg/entry.js");
    expect((await service.directory({ ...request(""), includeIgnored: true })).entries.some((entry) => entry.name === ".hidden")).toBe(true);
    await expect(service.directory({ ...request("dir"), limit: 501 })).rejects.toMatchObject({ code: "invalidRequest" });
  });

  it("shares the complete @ index without dropping file 8001 or deep paths", async () => {
    const index = new WorkspaceFileIndex(); service.close();
    service = new FileService({ resolveProject: async () => root, index });
    for (let n = 0; n < 8105; n += 100) await Promise.all(Array.from({ length: Math.min(100, 8105 - n) }, (_, i) => write(`deep/nested/item-${String(n + i).padStart(5, "0")}.txt`, "x")));
    const files = await index.list(root);
    const list = vi.spyOn(index, "list");
    const found = await service.search({ ...request(""), query: "deep/nested/item-08001" });
    expect(found.entries[0]?.path).toBe("deep/nested/item-08001.txt"); expect(list).toHaveBeenCalledOnce();
    expect(await index.list(root)).toBe(files);
    const page = await service.search({ ...request(""), query: "item-" }); expect(page.total).toBe(8105);
    const next = await service.search({ ...request(""), query: "item-", cursor: page.cursor }); expect(next.entries).toHaveLength(200);
    await write("deep/nested/item-new.txt", "new"); index.changed(root, "deep/nested/item-new.txt");
    await expect(service.search({ ...request(""), query: "item-", cursor: page.cursor })).rejects.toMatchObject({ code: "staleCursor" });
  }, 20_000);

  it("keeps missing, empty, binary, invalid UTF-8 and partial text separate", async () => {
    await write("empty", ""); await write("binary", Buffer.from([0, 1, 2])); await write("invalid", Buffer.from([0xff, 0x80]));
    expect(await service.readDocument(request("missing"))).toMatchObject({ status: "missing", content: null, metadata: { writable: false } });
    expect(await service.readDocument(request("empty"))).toMatchObject({ status: "empty", content: "", metadata: { writable: true } });
    expect(await service.readDocument(request("binary"))).toMatchObject({ status: "binary", content: null, metadata: { encoding: "binary", writable: false } });
    expect(await service.readDocument(request("invalid"))).toMatchObject({ status: "binary", content: null, metadata: { encoding: "invalid", writable: false } });
    await write("invalid-leading", Buffer.from([0x80, 0x61, 0x62, 0x63, 0x64]));
    expect(await service.readDocument(request("invalid-leading"))).toMatchObject({ status: "binary", content: null, metadata: { encoding: "invalid" } });
    expect(await service.readDocument({ ...request("invalid-leading"), offset: 1, length: 4 })).toMatchObject({ status: "binary", content: null, metadata: { encoding: "invalid" } });
    await write("large", "a".repeat(DOCUMENT_EDIT_BYTES) + "汉字尾部");
    const first = await service.readDocument({ ...request("large"), offset: DOCUMENT_EDIT_BYTES - 1, length: 4 });
    expect(first.content).toBe("a汉"); expect(first.metadata.nextOffset).toBe(DOCUMENT_EDIT_BYTES + 3); expect(first.status).toBe("truncated");
    const next = await service.readDocument({ ...request("large"), offset: first.metadata.nextOffset, length: 16 });
    expect(next.content).toBe("字尾部"); expect(next.version).toBe(first.version); expect(next.metadata.writable).toBe(false);
    await expect(service.writeDocument({ ...request("large"), expectedVersion: first.version!, content: "partial" })).rejects.toMatchObject({ code: "tooLarge" });
    await expect(service.readDocument({ ...request("large"), offset: 999999999 })).rejects.toMatchObject({ code: "invalidRequest" });
  });

  it("preserves BOM, CRLF and executable permissions through atomic replacement", async () => {
    await write("source", "\uFEFFone\r\ntwo\r\n");
    if (process.platform !== "win32") await fs.chmod(path.join(root, "source"), 0o755);
    const before = await service.readDocument(request("source")); expect(before.content).toBe("one\r\ntwo\r\n");
    const saved = await service.writeDocument({ ...request("source"), content: "new\ntext\n", expectedVersion: before.version! });
    expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe("\uFEFFnew\r\ntext\r\n");
    expect(saved.document.metadata).toMatchObject({ bom: true, lineEnding: "crlf" }); expect(saved.document.version).not.toBe(before.version);
    if (process.platform !== "win32") expect((await fs.stat(path.join(root, "source"))).mode & 0o777).toBe(0o755);
    expect((await fs.readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("refuses same-size external edits, parallel stale writes, read-only and invalid content", async () => {
    await write("source", "old\n"); const before = await service.readDocument(request("source")); await write("source", "new\n");
    await expect(service.writeDocument({ ...request("source"), content: "mine", expectedVersion: before.version! })).rejects.toMatchObject({ code: "conflict" });
    expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe("new\n");
    const current = await service.readDocument(request("source"));
    const results = await Promise.allSettled(["first", "second"].map((content) => service.writeDocument({ ...request("source"), content, expectedVersion: current.version! })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "conflict" } });
    await expect(service.writeDocument({ ...request("source"), content: "\ud800", expectedVersion: current.version! })).rejects.toMatchObject({ code: "invalidEncoding" });
    await expect(service.writeDocument({ ...request("source"), content: "a".repeat(DOCUMENT_EDIT_BYTES + 1), expectedVersion: current.version! })).rejects.toMatchObject({ code: "tooLarge" });
    if (process.platform !== "win32") {
      await fs.chmod(path.join(root, "source"), 0o444); const readOnly = await service.readDocument(request("source"));
      await expect(service.writeDocument({ ...request("source"), content: "mine", expectedVersion: readOnly.version! })).rejects.toMatchObject({ code: "readOnly" });
    }
  });

  it("revalidates version and project authorization after preparing the temporary replacement", async () => {
    await write("source", "old"); const before = await service.readDocument(request("source"));
    let changed = false;
    const result = service.writeDocument({ ...request("source"), content: "mine", expectedVersion: before.version! }, () => {
      if (!changed) { changed = true; return; }
      throw new Error("Owner navigated away");
    });
    await expect(result).rejects.toThrow("Owner navigated away");
    expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe("old");
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    let validations = 0;
    await expect(service.writeDocument({ ...request("source"), content: "mine", expectedVersion: before.version! }, () => {
      if (++validations === 2) writeFileSync(path.join(root, "source"), "external edit during save");
    })).rejects.toMatchObject({ code: "conflict" });
    expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe("external edit during save");
    expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("binds previews to each project and refuses traversal, unopened projects and outside symlinks", async () => {
    await write("same.html", "A"); await write("same.html", "B", other);
    const a = await service.previewUrl(request("same.html")); const b = await service.previewUrl({ projectRoot: other, path: "same.html" });
    expect(new URL(a).host).not.toBe(new URL(b).host);
    expect(service.previews.root(new URL(a).host)).toBe(root); expect(service.previews.root(new URL(b).host)).toBe(other);
    for (const name of ["../b/same.html", "/tmp/outside", "C:\\outside", "x\0y", "dir/../same.html"]) await expect(service.readDocument(request(name))).rejects.toMatchObject({ code: "invalidRequest" });
    await expect(service.readDocument({ projectRoot: directory, path: "b/same.html" })).rejects.toMatchObject({ code: "outsideProject" });
    if (process.platform !== "win32") {
      await fs.symlink(other, path.join(root, "outside"));
      await expect(service.readDocument(request("outside/same.html"))).rejects.toMatchObject({ code: "outsideProject" });
      await expect(service.readDocument(request("outside/not-created"))).rejects.toMatchObject({ code: "outsideProject" });
      await fs.symlink(path.join(root, "same.html"), path.join(root, "inside"));
      expect((await service.readDocument(request("inside"))).metadata.writable).toBe(false);
    }
    expect(() => service.previews.root("workspace")).toThrow(); service.clear(); expect(() => service.previews.root(new URL(a).host)).toThrow();
  });

  it("shares native watchers, sequences only affected project paths and releases all resources", async () => {
    await write("dir/source", "old"); await write("other", "old");
    const updates: FileUpdate[] = [];
    await service.subscriptions.subscribe(1, { ...request("dir/source"), subscriptionId: "document", target: "document" }, (update) => updates.push(update));
    await service.subscriptions.subscribe(1, { ...request("other"), subscriptionId: "unrelated", target: "document" }, (update) => updates.push(update));
    expect(service.subscriptions.stats()).toMatchObject({ roots: 1, subscriptions: 2 });
    await write("dir/source", "new");
    await vi.waitFor(() => expect(updates.some((update) => update.kind === "changed" && update.subscriptionId === "document")).toBe(true), { timeout: 5000 });
    expect(updates.some((update) => update.subscriptionId === "unrelated")).toBe(false);
    const target = updates.filter((update) => update.subscriptionId === "document");
    expect(target.map((update) => update.sequence)).toEqual(target.map((_update, index) => index + 1)); expect(target[0]).toMatchObject(request("dir/source"));
    service.subscriptions.releaseOwner(1); await service.idle(); expect(service.subscriptions.stats()).toEqual({ roots: 0, subscriptions: 0, reads: 0 });
    const count = updates.length; await write("dir/source", "after"); await new Promise((resolve) => setTimeout(resolve, 300)); expect(updates).toHaveLength(count);
  });

  it("uses visible polling fallback and detects parent deletion/recreation", async () => {
    service.close();
    service = new FileService({ resolveProject: async () => root, watch: (() => { throw new Error("watch unavailable"); }) as typeof watch, pollMs: 40 });
    await write("parent/source", "old"); const updates: FileUpdate[] = [];
    expect(await service.subscriptions.subscribe(1, { ...request("parent/source"), subscriptionId: "poll", target: "document" }, (update) => updates.push(update))).toEqual({ mode: "polling" });
    expect(updates[0]).toMatchObject({ kind: "error", mode: "polling" });
    await fs.rm(path.join(root, "parent"), { recursive: true });
    await vi.waitFor(() => expect(updates.some((update) => update.kind === "changed")).toBe(true));
    const count = updates.length; await write("parent/source", "recreated");
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(count));
    service.subscriptions.unsubscribe(1, "poll"); expect(service.subscriptions.stats().roots).toBe(0);
  });

  it("tracks and waits for reads still in flight after close", async () => {
    service.close(); let entered!: () => void; let release!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    service = new FileService({ resolveProject: async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return root; } });
    const result = service.readDocument(request("source")); await held; service.close();
    let idle = false; const closing = service.idle().then(() => { idle = true; });
    await new Promise((resolve) => setTimeout(resolve, 20)); expect(idle).toBe(false);
    release(); await expect(result).rejects.toMatchObject({ code: "cancelled" }); await closing; expect(idle).toBe(true);
  });

  it("polls nested directory changes when native monitoring is unavailable", async () => {
    service.close();
    service = new FileService({ resolveProject: async () => root, watch: (() => { throw new Error("unavailable"); }) as typeof watch, pollMs: 40 });
    await write("dir/nested/source", "before"); const updates: FileUpdate[] = [];
    await service.subscriptions.subscribe(2, { ...request("dir"), subscriptionId: "directory", target: "directory" }, (update) => updates.push(update));
    await vi.waitFor(() => expect(updates.some((update) => update.kind === "changed")).toBe(true));
    const count = updates.length; await write("dir/nested/source", "after");
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(count));
    service.subscriptions.releaseOwner(2); await service.idle(); expect(service.subscriptions.stats()).toEqual({ roots: 0, subscriptions: 0, reads: 0 });
  });
});
