import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileService } from "./file-service";
let directory: string; let root: string; let other: string; let service: FileService;
const request = (name: string) => ({ projectRoot: root, path: name });
const trash = vi.fn(async (file: string) => { await fs.rename(file, path.join(directory, "trash", path.basename(file))); });
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-file-management-")); root = path.join(directory, "project"); other = path.join(directory, "outside");
  await fs.mkdir(root); await fs.mkdir(other); await fs.mkdir(path.join(directory, "trash")); trash.mockClear();
  service = new FileService({ resolveProject: async (value) => { if (value !== root) throw new Error("Unopened project"); return root; }, trash });
});
afterEach(async () => { service.close(); await service.idle(); await fs.rm(directory, { recursive: true, force: true }); });
describe("real project file management", () => {
  it("supports renaming only the case on the actual filesystem without leaving the old directory entry", async () => {
    await fs.writeFile(path.join(root, "lower.txt"), "preserve"); const target = await service.inspect(request("lower.txt"));
    await service.mutate({ ...request("lower.txt"), operation: "rename", destination: "LOWER.txt", expectedVersion: target.version });
    expect(await fs.readdir(root)).toEqual(["LOWER.txt"]); expect(await fs.readFile(path.join(root, "LOWER.txt"), "utf8")).toBe("preserve");
  });
  it("creates empty files and folders, refreshes shared search and never overwrites an existing entry", async () => {
    const file = process.platform === "win32" ? "目录/a file.txt" : "目录/a file:1.txt";
    await service.search({ ...request(""), query: "" });
    await service.mutate({ ...request("目录"), operation: "createDirectory" });
    await service.mutate({ ...request(file), operation: "createFile" });
    expect(await fs.readFile(path.join(root, file), "utf8")).toBe("");
    expect((await service.search({ ...request(""), query: "a file" })).entries.map((entry) => entry.path)).toEqual([file]);
    await fs.writeFile(path.join(root, file), "retain");
    await expect(service.mutate({ ...request(file), operation: "createFile" })).rejects.toMatchObject({ code: "exists" });
    expect(await fs.readFile(path.join(root, file), "utf8")).toBe("retain");
    await expect(service.mutate({ ...request("missing/child"), operation: "createFile" })).rejects.toMatchObject({ code: "notDirectory" });
    expect(await fs.readdir(root)).toEqual(["目录"]);
  });
  it("moves actual files and directory subtrees, preserving bytes, permissions and notifications", async () => {
    const mutation = vi.fn(); service.close(); service = new FileService({ resolveProject: async () => root, trash, mutation });
    await fs.mkdir(path.join(root, "old")); await fs.writeFile(path.join(root, "old/source"), "\uFEFFtext\r\n"); await fs.chmod(path.join(root, "old/source"), 0o755);
    const target = await service.inspect(request("old"));
    await service.mutate({ ...request("old"), operation: "rename", expectedVersion: target.version, destination: "new" });
    expect(await fs.readFile(path.join(root, "new/source"), "utf8")).toBe("\uFEFFtext\r\n");
    if (process.platform !== "win32") expect((await fs.stat(path.join(root, "new/source"))).mode & 0o777).toBe(0o755);
    expect(mutation).toHaveBeenCalledWith({ ...request("old"), kind: "mutation", operation: "rename", destination: "new" });
    const file = await service.inspect(request("new/source")); await service.mutate({ ...request("new/source"), operation: "rename", destination: "moved", expectedVersion: file.version });
    expect(await fs.readdir(path.join(root, "new"))).toEqual([]); expect(await fs.readFile(path.join(root, "moved"), "utf8")).toBe("\uFEFFtext\r\n");
  });
  it("rejects changed files, changed descendants, existing destinations and stale trash confirmations", async () => {
    await fs.mkdir(path.join(root, "dir")); await fs.writeFile(path.join(root, "dir/source"), "old"); const initial = await service.inspect(request("dir"));
    await fs.writeFile(path.join(root, "dir/source"), "new");
    for (const operation of ["rename", "trash"] as const) await expect(service.mutate({ ...request("dir"), operation, destination: "new-dir", expectedVersion: initial.version })).rejects.toMatchObject({ code: "conflict" });
    expect(trash).not.toHaveBeenCalled();
    const current = await service.inspect(request("dir")); await fs.writeFile(path.join(root, "existing"), "other");
    await expect(service.mutate({ ...request("dir"), operation: "rename", destination: "existing", expectedVersion: current.version })).rejects.toMatchObject({ code: "exists" });
    expect(await fs.readFile(path.join(root, "existing"), "utf8")).toBe("other"); expect(await fs.readFile(path.join(root, "dir/source"), "utf8")).toBe("new");
  });
  it("uses the native trash adapter, preserves contents there, and retains the source on trash failure", async () => {
    await fs.writeFile(path.join(root, "source"), "original"); const first = await service.inspect(request("source"));
    trash.mockRejectedValueOnce(new Error("Trash unavailable"));
    await expect(service.mutate({ ...request("source"), operation: "trash", expectedVersion: first.version })).rejects.toThrow("Trash unavailable");
    expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe("original");
    await service.mutate({ ...request("source"), operation: "trash", expectedVersion: first.version });
    expect(await fs.readFile(path.join(directory, "trash/source"), "utf8")).toBe("original"); await expect(fs.stat(path.join(root, "source"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("checks project, traversal, root, Git metadata, missing versions and parent permissions", async () => {
    for (const name of ["", "../outside/source", "/tmp/source", "C:\\source", ".git/config", "dir/.git", "\ud800"]) await expect(service.mutate({ ...request(name), operation: "createFile" })).rejects.toMatchObject({ code: "invalidRequest" });
    await expect(service.mutate({ projectRoot: other, path: "source", operation: "createFile" })).rejects.toMatchObject({ code: "outsideProject" });
    await fs.writeFile(path.join(root, "source"), "x"); await expect(service.mutate({ ...request("source"), operation: "trash" })).rejects.toMatchObject({ code: "invalidRequest" });
    if (process.platform !== "win32") { await fs.chmod(root, 0o555); await expect(service.mutate({ ...request("new"), operation: "createFile" })).rejects.toMatchObject({ code: "readOnly" }); await fs.chmod(root, 0o755); }
  });
  it("acts on a symlink itself without touching an outside target and refuses operations through it", async () => {
    if (process.platform === "win32") return;
    await fs.writeFile(path.join(other, "source"), "outside"); await fs.symlink(other, path.join(root, "link"));
    await fs.mkdir(path.join(root, ".git")); await fs.symlink(path.join(root, ".git"), path.join(root, "metadata"));
    await expect(service.mutate({ ...request("metadata/config"), operation: "createFile" })).rejects.toMatchObject({ code: "invalidRequest" });
    await expect(service.mutate({ ...request("link/child"), operation: "createFile" })).rejects.toMatchObject({ code: "outsideProject" });
    const target = await service.inspect(request("link")); expect(target.entryKind).toBe("symlink");
    await service.mutate({ ...request("link"), operation: "rename", destination: "renamed", expectedVersion: target.version });
    expect(await fs.readlink(path.join(root, "renamed"))).toBe(other);
    const moved = await service.inspect(request("renamed")); await service.mutate({ ...request("renamed"), operation: "trash", expectedVersion: moved.version });
    expect(await fs.readFile(path.join(other, "source"), "utf8")).toBe("outside");
  });
  it("cleans its reservation on owner cancellation and protects a concurrent destination writer", async () => {
    await fs.mkdir(path.join(root, "source")); const target = await service.inspect(request("source"));
    let checks = 0;
    await expect(service.mutate({ ...request("source"), operation: "rename", destination: "cancelled", expectedVersion: target.version }, () => {
      if (++checks === 3) throw new Error("Owner changed");
    })).rejects.toThrow("Owner changed");
    expect(await fs.readdir(root)).toEqual(["source"]);
    await fs.writeFile(path.join(root, "file"), "source"); const file = await service.inspect(request("file")); checks = 0;
    await expect(service.mutate({ ...request("file"), operation: "rename", destination: "destination", expectedVersion: file.version }, () => {
      if (++checks === 3) writeFileSync(path.join(root, "destination"), "concurrent writer");
    })).rejects.toMatchObject({ code: "conflict" });
    expect(await fs.readFile(path.join(root, "destination"), "utf8")).toBe("concurrent writer"); expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe("source");
  });
  it("queues structural operations with saves, revalidates after waiting and waits on shutdown", async () => {
    await fs.writeFile(path.join(root, "source"), "old"); const document = await service.readDocument(request("source")); const target = await service.inspect(request("source"));
    const saved = service.writeDocument({ ...request("source"), content: "new", expectedVersion: document.version! });
    const moved = service.mutate({ ...request("source"), operation: "rename", destination: "new", expectedVersion: target.version });
    await saved; await expect(moved).rejects.toMatchObject({ code: "conflict" }); expect(await fs.readFile(path.join(root, "source"), "utf8")).toBe("new");
    const result = service.mutate({ ...request("another"), operation: "createFile" }); service.close(); await service.idle(); await expect(result).rejects.toMatchObject({ code: "cancelled" });
  });
});
