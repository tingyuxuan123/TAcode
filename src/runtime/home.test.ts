import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getTacodeHome, migrateLegacyHome } from "./home";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tacode-home-"));
  roots.push(root);
  return root;
}

/** 一次迁移场景：返回 root 下的旧目录与新目录。 */
async function renameFixture(): Promise<{ legacy: string; home: string }> {
  const root = await tempRoot();
  return { legacy: path.join(root, ".tether"), home: path.join(root, ".tacode") };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("数据目录默认位置", () => {
  it("默认落到 ~/.tacode", () => {
    vi.stubEnv("TACODE_HOME", undefined);
    expect(getTacodeHome()).toBe(path.join(os.homedir(), ".tacode"));
  });

  it("TACODE_HOME 覆盖默认值", () => {
    vi.stubEnv("TACODE_HOME", "/tmp/tacode-explicit");
    expect(getTacodeHome()).toBe("/tmp/tacode-explicit");
  });
});

describe("旧数据目录一次性迁移", () => {
  it("首次启动整目录拷贝，并保留旧目录作为回退", async () => {
    const { legacy, home } = await renameFixture();
    await fsp.mkdir(path.join(legacy, "subagents"), { recursive: true });
    await fsp.writeFile(path.join(legacy, "subagents", "code-reviewer.md"), "name: code-reviewer\n");
    await fsp.writeFile(path.join(legacy, "settings.json"), "{}\n");

    await expect(migrateLegacyHome(home, legacy)).resolves.toBe(true);

    await expect(fsp.readFile(path.join(home, "subagents", "code-reviewer.md"), "utf8")).resolves.toBe(
      "name: code-reviewer\n",
    );
    await expect(fsp.readFile(path.join(home, "settings.json"), "utf8")).resolves.toBe("{}\n");
    // 旧目录只读：内容仍在，可以用它回退。
    await expect(fsp.readFile(path.join(legacy, "settings.json"), "utf8")).resolves.toBe("{}\n");

    const marker = JSON.parse(await fsp.readFile(path.join(home, ".migrated.json"), "utf8")) as {
      from: string;
    };
    expect(marker.from).toBe(legacy);
  });

  it("已有标记时不再重复拷贝", async () => {
    const { legacy, home } = await renameFixture();
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.writeFile(path.join(legacy, "a.md"), "a\n");
    await expect(migrateLegacyHome(home, legacy)).resolves.toBe(true);

    // 迁移后再往旧目录写东西，不应该被搬过来：改名后 TACode 只认新目录。
    await fsp.writeFile(path.join(legacy, "later.md"), "later\n");
    await expect(migrateLegacyHome(home, legacy)).resolves.toBe(false);
    await expect(fsp.access(path.join(home, "later.md"))).rejects.toThrow();
  });

  it("目标里已有的文件不被旧目录覆盖", async () => {
    const { legacy, home } = await renameFixture();
    await fsp.mkdir(path.join(home, "subagents"), { recursive: true });
    await fsp.writeFile(path.join(home, "subagents", "x.md"), "new\n");
    await fsp.mkdir(path.join(legacy, "subagents"), { recursive: true });
    await fsp.writeFile(path.join(legacy, "subagents", "x.md"), "old\n");
    await fsp.writeFile(path.join(legacy, "keep.md"), "keep\n");

    await expect(migrateLegacyHome(home, legacy)).resolves.toBe(true);

    await expect(fsp.readFile(path.join(home, "subagents", "x.md"), "utf8")).resolves.toBe("new\n");
    await expect(fsp.readFile(path.join(home, "keep.md"), "utf8")).resolves.toBe("keep\n");
  });

  it("旧目录不存在或与新目录相同则什么都不做", async () => {
    const { legacy, home } = await renameFixture();
    await expect(migrateLegacyHome(home, legacy)).resolves.toBe(false);
    await expect(fsp.access(home)).rejects.toThrow();

    await fsp.mkdir(home, { recursive: true });
    await expect(migrateLegacyHome(home, home)).resolves.toBe(false);
  });
});
