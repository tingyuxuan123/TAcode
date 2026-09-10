import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_SUBAGENTS,
  deleteUserSubagent,
  getSubagentsDir,
  loadEnabledSubagents,
  loadSubagents,
  readUserSubagent,
  saveUserSubagent,
  setSubagentEnabled,
} from "./subagents";

const roots: string[] = [];

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tacode-subagents-"));
  roots.push(root);
  vi.stubEnv("TETHER_HOME", root);
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const document = (name: string, description = "Do the thing"): string =>
  `---\nname: ${name}\ndescription: ${description}\ntools: [read_file]\n---\n\nReport only facts.\n`;

describe("subagent definitions", () => {
  it("无用户目录时返回内置定义且默认启用", async () => {
    await tempHome();
    const { subagents, warnings } = await loadSubagents();
    expect(warnings).toEqual([]);
    expect(subagents.map((item) => item.name)).toEqual(BUILTIN_SUBAGENTS.map((item) => item.name));
    expect(subagents.every((item) => item.enabled)).toBe(true);
  });

  it("保存的用户定义按名覆盖内置并持久化", async () => {
    await tempHome();
    await saveUserSubagent(document("explorer", "User explorer"));
    const { subagents } = await loadSubagents();
    const explorer = subagents.find((item) => item.name === "explorer");
    expect(explorer?.description).toBe("User explorer");
    expect(explorer?.source).toBe("user");
    await expect(readUserSubagent("explorer")).resolves.toContain("User explorer");
  });

  it("启用状态单独持久化，不影响文档", async () => {
    await tempHome();
    await saveUserSubagent(document("helper"));
    await expect(setSubagentEnabled("helper", false)).resolves.toBe(true);
    expect((await loadEnabledSubagents()).map((item) => item.name)).not.toContain("helper");
    expect(await readUserSubagent("helper")).toContain("helper");

    await setSubagentEnabled("helper", true);
    expect((await loadEnabledSubagents()).map((item) => item.name)).toContain("helper");
  });

  it("未知名称的启停返回 false", async () => {
    await tempHome();
    await expect(setSubagentEnabled("missing", false)).resolves.toBe(false);
  });

  it("坏文档只产生告警，不影响其它定义", async () => {
    const home = await tempHome();
    await mkdir(getSubagentsDir(), { recursive: true });
    await writeFile(join(getSubagentsDir(), "broken.md"), "---\nname: broken\n---\n", "utf8");
    await writeFile(join(getSubagentsDir(), "good.md"), document("good"), "utf8");
    const { subagents, warnings } = await loadSubagents();
    expect(subagents.map((item) => item.name)).toContain("good");
    expect(subagents.map((item) => item.name)).not.toContain("broken");
    expect(warnings.join(" ")).toContain("description");
    expect(home).toBeTruthy();
  });

  it("删除用户定义后回落到内置", async () => {
    await tempHome();
    await saveUserSubagent(document("explorer", "User explorer"));
    await expect(deleteUserSubagent("explorer")).resolves.toBe(true);
    const { subagents } = await loadSubagents();
    expect(subagents.find((item) => item.name === "explorer")?.source).toBe("builtin");
  });

  it("保存非法文档时报错", async () => {
    await tempHome();
    await expect(saveUserSubagent("---\nname: bad\n---\n")).rejects.toThrow();
  });

  it("状态文件写入 JSON 且可回读", async () => {
    await tempHome();
    await setSubagentEnabled("explorer", false);
    const raw = await readFile(join(getSubagentsDir(), "..", "subagents.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ disabled: ["explorer"] });
  });
});
