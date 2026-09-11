import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "./workspace";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tacode-workspace-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Workspace", () => {
  it("resolves workspace-relative paths", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "a.txt"), "x");
    const ws = new Workspace(root);
    await expect(ws.resolve("a.txt")).resolves.toBe(join(root, "a.txt"));
    expect(ws.relative(join(root, "a.txt"))).toBe("a.txt");
  });

  it("rejects lexical escapes", async () => {
    const root = await makeRoot();
    const ws = new Workspace(root);
    await ws.initialize();
    await expect(ws.resolve("../outside.txt")).rejects.toThrow(/escapes workspace/);
    await expect(ws.resolve("/etc/passwd")).rejects.toThrow(/escapes workspace/);
  });

  it("越界报错带上 workspace root 与相对路径提示", async () => {
    const root = await makeRoot();
    const ws = new Workspace(root);
    await ws.initialize();
    let message = "";
    try {
      await ws.resolve("/Users/somebody/other-repo/src/api/login/index.ts");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(`workspace root: ${root}`);
    expect(message).toContain("workspace-relative path");
    expect(message).toContain("open that directory as the project");
  });

  it("rejects symlinks pointing outside the workspace", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    const ws = new Workspace(root);
    await ws.initialize();
    await expect(ws.resolve("link.txt")).rejects.toThrow(/outside workspace/);
  });

  it("allows missing files only when explicitly requested", async () => {
    const root = await makeRoot();
    const ws = new Workspace(root);
    await ws.initialize();
    await expect(ws.resolve("nested/new.txt")).rejects.toThrow();
    await expect(ws.resolve("nested/new.txt", true)).resolves.toBe(join(root, "nested/new.txt"));
  });
});
