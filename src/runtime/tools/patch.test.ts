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

  it("容忍前导空行与指令行尾随空白", () => {
    const actions = parsePatch("\n\n*** Begin Patch  \n*** Add File: a.txt\n+x\n*** End Patch \n");
    expect(actions).toHaveLength(1);
  });

  it("End Patch 缺失时报出解析到哪一行", () => {
    expect(() => parsePatch("*** Begin Patch\n*** Add File: a.txt\n+x")).toThrow(
      /parsed 1 file action\(s\); input ended after line 3, last line: \+x/,
    );
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

  it("定位失败时给出最近似行号与首个差异行", async () => {
    const { root, ws } = await workspace();
    await writeFile(join(root, "a.txt"), "alpha\nbeta\ngamma\n");

    await expect(
      applyWorkspacePatch(
        ws,
        [
          "*** Begin Patch",
          "*** Update File: a.txt",
          "@@",
          " alpha",
          "-BETA",
          "+beta",
          "*** End Patch",
        ].join("\n"),
      ),
    ).rejects.toThrow(/matches 1\/2 of the hunk lines[\s\S]*first difference at line 2[\s\S]*expected \(4 chars\): BETA[\s\S]*actual   \(4 chars\): beta/);
  });

  it("没有任何行相等时给出字符重合度最高的一行", async () => {
    const { root, ws } = await workspace();
    await writeFile(join(root, "a.txt"), "hello wirld\n");

    await expect(
      applyWorkspacePatch(
        ws,
        [
          "*** Begin Patch",
          "*** Update File: a.txt",
          "@@",
          "-hello world",
          "+hello there",
          "*** End Patch",
        ].join("\n"),
      ),
    ).rejects.toThrow(/closest is line 1[\s\S]*character overlap[\s\S]*expected \(11 chars\)/);
  });
});
