import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceFileIndex } from "./workspace-file-index";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), "tacode-file-index-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it("indexes the 201st sibling and files beyond 8000, then applies known file changes without rescanning", async () => {
  await fs.mkdir(path.join(root, "bulk"));
  await fs.mkdir(path.join(root, "src", "renderer"), { recursive: true });
  await fs.mkdir(path.join(root, ".pi", "skills", "demo"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "renderer", "App.tsx"), "app");
  await fs.writeFile(path.join(root, ".pi", "skills", "demo", "SKILL.md"), "skill");
  for (let offset = 0; offset < 8100; offset += 200) {
    await Promise.all(Array.from({ length: Math.min(200, 8100 - offset) }, (_, i) => fs.writeFile(path.join(root, "bulk", `${String(offset + i).padStart(5, "0")}.ts`), "")));
  }
  const index = new WorkspaceFileIndex();
  const scan = vi.spyOn(fs, "opendir");
  const first = index.list(root);
  expect(index.list(root)).toBe(first);
  const paths = await first;
  expect(paths).toContain("bulk/00200.ts");
  expect(paths).toContain("bulk/08099.ts");
  expect(paths).toContain("src/renderer/App.tsx");
  expect(paths).toContain(".pi/skills/demo/SKILL.md");
  scan.mockClear();
  await fs.unlink(path.join(root, "bulk", "08099.ts"));
  index.changed(root, "bulk/08099.ts");
  await fs.writeFile(path.join(root, "new.ts"), "new");
  index.changed(root, "new.ts");
  const next = await index.list(root);
  expect(next).not.toContain("bulk/08099.ts");
  expect(next).toContain("new.ts");
  expect(scan).not.toHaveBeenCalled();
});

it("updates renamed directory subtrees and reports read failures instead of an empty result", async () => {
  const index = new WorkspaceFileIndex();
  await fs.mkdir(path.join(root, "old"));
  await fs.writeFile(path.join(root, "old", "file.ts"), "");
  await index.list(root);
  await fs.rename(path.join(root, "old"), path.join(root, "next"));
  index.changed(root, "old");
  index.changed(root, "next");
  expect(await index.list(root)).toEqual(["next/", "next/file.ts"]);
  vi.spyOn(fs, "opendir").mockRejectedValueOnce(new Error("permission denied"));
  await expect(index.list(root, true)).rejects.toThrow("permission denied");
  expect(await index.list(root)).toContain("next/file.ts");
});
