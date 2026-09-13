import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readWorkspacePreview } from "./workspace-preview";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), "tacode-preview-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it("distinguishes empty, deleted and binary files without putting status messages in content", async () => {
  const file = path.join(root, "sample");
  expect(await readWorkspacePreview(file, "sample")).toMatchObject({ status: "missing", content: "" });
  await fs.writeFile(file, "");
  expect(await readWorkspacePreview(file, "sample")).toMatchObject({ status: "ready", content: "", truncated: false });
  await fs.writeFile(file, Buffer.from([65, 0, 66]));
  expect(await readWorkspacePreview(file, "sample")).toMatchObject({ status: "binary", content: "", binary: true });
});

it("reads a bounded prefix without splitting UTF-8 or adding truncation copy to the body", async () => {
  const file = path.join(root, "sample");
  await fs.writeFile(file, "头部内容");
  expect(await readWorkspacePreview(file, "sample", 7)).toMatchObject({ content: "头部", truncated: true, size: 12 });
  const before = await readWorkspacePreview(file, "sample");
  await fs.writeFile(file, "同长修改");
  const after = await readWorkspacePreview(file, "sample");
  expect(after.content).toBe("同长修改");
  expect(after.version).not.toBe(before.version);
});

it("reports read errors so the caller can retry, and closes the handle on invalid file types", async () => {
  const file = path.join(root, "sample");
  await fs.writeFile(file, "retried");
  vi.spyOn(fs, "open").mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
  await expect(readWorkspacePreview(file, "sample")).rejects.toThrow("permission denied");
  expect((await readWorkspacePreview(file, "sample")).content).toBe("retried");
  await expect(readWorkspacePreview(root, ".")).rejects.toThrow("普通文件");
});
