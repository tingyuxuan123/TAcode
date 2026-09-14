import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileDrafts } from "./file-drafts";
import { ProjectFilePaths } from "./file-path";
let directory: string; let root: string; let storage: string; let drafts: FileDrafts;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const request = (file = "source.ts") => ({ projectRoot: root, path: file, content: "unsaved\r\n", baseContent: "original\r\n", baseVersion: "a".repeat(64), lineEnding: "crlf" as const });
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-file-drafts-")); root = path.join(directory, "project"); storage = path.join(directory, "recovery");
  await fs.mkdir(root); drafts = new FileDrafts(storage, new ProjectFilePaths(async (value) => { if (value !== root) throw new Error("Unknown project"); return root; }));
});
afterEach(async () => { await drafts.idle(); await fs.rm(directory, { recursive: true, force: true }); });
describe("durable file recovery", () => {
  it("recovers exact text/base versions after a new service instance without writing repository files", async () => {
    await drafts.write(request(), () => {});
    const reopened = new FileDrafts(storage, new ProjectFilePaths(async () => root));
    expect(await reopened.list({ projectRoot: root, path: "" })).toEqual([expect.objectContaining(request())]);
    expect(await fs.readdir(root)).toEqual([]);
    const stat = await fs.stat(path.join(storage, hash(root), `${hash("source.ts")}.json`));
    if (process.platform !== "win32") expect(stat.mode & 0o777).toBe(0o600);
  });
  it("serializes checkpoints and explicit deletion, with project/path isolation", async () => {
    const writes = [drafts.write(request(), () => {}), drafts.write({ ...request(), content: "latest" }, () => {}), drafts.remove(request(), () => {})];
    await Promise.all(writes); expect(await drafts.list({ projectRoot: root, path: "" })).toEqual([]);
    await drafts.write(request("literal:1"), () => {}); expect((await drafts.list({ projectRoot: root, path: "" }))[0]?.path).toBe("literal:1");
    await expect(drafts.write({ ...request(), projectRoot: directory }, () => {})).rejects.toMatchObject({ code: "outsideProject" });
    await expect(async () => drafts.write(request("../escape"), () => {})).rejects.toMatchObject({ code: "invalidRequest" });
  });
  it("retains the previous record when authorization or atomic publication fails", async () => {
    await drafts.write(request(), () => {});
    let checks = 0;
    await expect(drafts.write({ ...request(), content: "replacement" }, () => { if (++checks === 2) throw new Error("Owner navigated"); })).rejects.toThrow("Owner navigated");
    expect((await drafts.list({ projectRoot: root, path: "" }))[0]?.content).toBe("unsaved\r\n");
    expect((await fs.readdir(path.join(storage, hash(root)))).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
  it("rejects full recovery storage without evicting existing records", async () => {
    await drafts.write(request(), () => {});
    const large = path.join(storage, hash(root), `${"b".repeat(64)}.json`);
    await fs.writeFile(large, "retained"); await fs.truncate(large, 128 * 1024 * 1024);
    await expect(drafts.write(request("another.ts"), () => {})).rejects.toMatchObject({ code: "tooLarge" });
    expect((await fs.stat(large)).size).toBe(128 * 1024 * 1024);
    expect(JSON.parse(await fs.readFile(path.join(storage, hash(root), `${hash("source.ts")}.json`), "utf8")).content).toBe("unsaved\r\n");
  });
  it("reports damaged records without deleting them or overwriting drafts", async () => {
    await drafts.write(request(), () => {});
    const file = path.join(storage, hash(root), `${hash("source.ts")}.json`); await fs.writeFile(file, "{broken");
    await expect(drafts.list({ projectRoot: root, path: "" })).rejects.toThrow(); expect(await fs.readFile(file, "utf8")).toBe("{broken");
    await expect(async () => drafts.write({ ...request(), content: "\ud800" }, () => {})).rejects.toMatchObject({ code: "invalidEncoding" });
  });
});
