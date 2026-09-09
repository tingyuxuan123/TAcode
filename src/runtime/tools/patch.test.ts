import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyWorkspacePatch, parsePatch } from "./patch";
import { Workspace } from "./workspace";

const roots: string[] = [];

async function workspace(): Promise<{ root: string; ws: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), "tacode-patch-"));
  roots.push(root);
  const ws = new Workspace(root);
  await ws.initialize();
  return { root, ws };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parsePatch", () => {
  it("parses add / update / delete / move actions", () => {
    const actions = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: a.txt",
        "+hello",
        "*** Update File: b.txt",
        "*** Move to: c.txt",
        "@@",
        "-old",
        "+new",
        "*** Delete File: d.txt",
        "*** End Patch",
      ].join("\n"),
    );
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatchObject({ type: "add", path: "a.txt", lines: ["hello"] });
    expect(actions[1]).toMatchObject({ type: "update", path: "b.txt", moveTo: "c.txt" });
    expect(actions[2]).toMatchObject({ type: "delete", path: "d.txt" });
  });

  it("rejects absolute and escaping paths", () => {
    expect(() => parsePatch("*** Begin Patch\n*** Add File: /etc/passwd\n+x\n*** End Patch")).toThrow(
      /workspace-relative/,
    );
    expect(() => parsePatch("*** Begin Patch\n*** Add File: ../x\n+x\n*** End Patch")).toThrow(
      /workspace-relative/,
    );
  });

  it("requires a terminating *** End Patch", () => {
    expect(() => parsePatch("*** Begin Patch\n*** Add File: a.txt\n+x")).toThrow(/End Patch/);
  });
});

describe("applyWorkspacePatch", () => {
  it("adds, updates, moves and deletes files in one pass", async () => {
    const { root, ws } = await workspace();
    await writeFile(join(root, "b.txt"), "old\nkeep\n");

    const result = await applyWorkspacePatch(
      ws,
      [
        "*** Begin Patch",
        "*** Add File: a.txt",
        "+hello",
        "*** Update File: b.txt",
        "*** Move to: c.txt",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    );

    expect(result.files.sort()).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(join(root, "c.txt"), "utf8")).toBe("new\nkeep\n");
    await expect(readFile(join(root, "b.txt"), "utf8")).rejects.toThrow();
  });

  it("applies updates with trimEnd tolerance", async () => {
    const { root, ws } = await workspace();
    await writeFile(join(root, "a.txt"), "alpha   \nbeta\n");

    await applyWorkspacePatch(
      ws,
      ["*** Begin Patch", "*** Update File: a.txt", "@@", "-alpha", "+gamma", "*** End Patch"].join("\n"),
    );

    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("gamma\nbeta\n");
  });

  it("rejects adding an existing file without mutating anything", async () => {
    const { root, ws } = await workspace();
    await writeFile(join(root, "a.txt"), "exists\n");
    await mkdir(join(root, "dir"), { recursive: true });

    await expect(
      applyWorkspacePatch(
        ws,
        ["*** Begin Patch", "*** Add File: a.txt", "+x", "*** End Patch"].join("\n"),
      ),
    ).rejects.toThrow(/Cannot add existing file/);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("exists\n");
  });

  it("reports a missing context instead of writing a wrong file", async () => {
    const { root, ws } = await workspace();
    await writeFile(join(root, "a.txt"), "alpha\n");

    await expect(
      applyWorkspacePatch(
        ws,
        ["*** Begin Patch", "*** Update File: a.txt", "@@", "-nope", "+x", "*** End Patch"].join("\n"),
      ),
    ).rejects.toThrow(/context not found/);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("alpha\n");
  });
});
