import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadSkillsFromDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { SkillsManager } from "./skills-manager";

const document = (name: string, description = "测试技能"): string => `---\nname: ${name}\ndescription: ${description}\nversion: 1.2.3\ngroup: 开发\n---\n\n# ${name}\nRead the project first.\n`;

describe("Skills 管理与 Pi 加载", () => {
  let root: string;
  let project: string;
  let home: string;
  let manager: SkillsManager;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "tacode-skill-manager-"));
    project = path.join(root, "project"); home = path.join(root, "runtime-home");
    await fsp.mkdir(project); await fsp.mkdir(home);
    vi.stubEnv("TACODE_HOME", home);
    manager = new SkillsManager(path.join(root, "user-home"));
  });
  afterEach(async () => { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }); });

  it("新建、分组元数据、编辑与启停都反映在 Pi 的实际加载结果", async () => {
    const skill = await manager.create(document("review"), "project", project);
    expect(skill).toMatchObject({ name: "review", group: "开发", version: "1.2.3", enabled: true, scope: "project" });
    const activePath = path.join(project, ".agents/skills");
    const loaded = () => loadSkillsFromDir({ dir: activePath, source: "project" }).skills.map((item) => item.name);
    expect(loaded()).toEqual(["review"]);
    const disabled = await manager.setEnabled(skill.id, false, project);
    expect(disabled.id).toBe(skill.id);
    expect(disabled.path).toContain("skills-inactive");
    expect(loaded()).toEqual([]);
    expect((await manager.list(project)).skills).toHaveLength(1);
    await manager.save(skill.id, document("review", "更新后的描述"), document("review"), project);
    await manager.setEnabled(skill.id, true, project);
    expect(loaded()).toEqual(["review"]);
    expect((await manager.read(skill.id, project)).skill.description).toBe("更新后的描述");
    expect((await manager.list(project)).projectTrusted).toBe(false);
    new ProjectTrustStore(home).set(project, true);
    expect((await manager.list(project)).projectTrusted).toBe(true);
  });

  it("项目与全局同名技能互不覆盖；切换项目不会读写原项目", async () => {
    const first = await manager.create(document("same"), "project", project);
    const global = await manager.create(document("same", "global"), "user", project);
    const other = path.join(root, "other"); await fsp.mkdir(other);
    expect((await manager.list(other)).skills.map((item) => item.id)).toEqual([global.id]);
    await expect(manager.read(first.id, other)).rejects.toThrow();
    await expect(manager.create(document("same"), "project", project)).rejects.toThrow("同名");
    expect((await manager.read(first.id, project)).skill.description).toBe("测试技能");
  });

  it("导入完整目录、保留脚本，重复导入跳过且删除走可恢复回调", async () => {
    const source = path.join(root, "source");
    await fsp.mkdir(path.join(source, "scripts"), { recursive: true });
    await fsp.writeFile(path.join(source, "SKILL.md"), document("imported"));
    await fsp.writeFile(path.join(source, "scripts/run.py"), "print('ok')\n");
    expect(await manager.importDirectory(source, "project", project)).toEqual({ imported: ["imported"], skipped: [], errors: [] });
    expect(await manager.importDirectory(source, "project", project)).toEqual({ imported: [], skipped: ["imported"], errors: [] });
    const skill = (await manager.list(project)).skills[0];
    expect((await manager.read(skill.id, project)).files).toEqual(["scripts/run.py"]);
    await manager.saveFile(skill.id, "scripts/run.py", "print('edited')\n", "print('ok')\n", project);
    expect(await manager.readFile(skill.id, "scripts/run.py", project)).toBe("print('edited')\n");
    const trash = path.join(root, "trash");
    await manager.remove(skill.id, (directory) => fsp.rename(directory, trash), project);
    expect((await manager.list(project)).skills).toEqual([]);
    expect(await fsp.readFile(path.join(trash, "SKILL.md"), "utf8")).toBe(document("imported"));
  });

  it("拒绝路径穿越、外部符号链接与通过附带文件接口覆盖 SKILL.md", async () => {
    const skill = await manager.create(document("safe"), "project", project);
    const secret = path.join(root, "outside.txt"); await fsp.writeFile(secret, "keep");
    await fsp.symlink(secret, path.join(path.dirname(skill.path), "link.txt"));
    await expect(manager.readFile(skill.id, "../../../outside.txt", project)).rejects.toThrow();
    await expect(manager.readFile(skill.id, "link.txt", project)).rejects.toThrow();
    await expect(manager.saveFile(skill.id, "./SKILL.md", "broken", document("safe"), project)).rejects.toThrow("正文");
    const outside = path.join(root, "external"); await fsp.mkdir(outside);
    const second = path.join(root, "symlink-project"); await fsp.mkdir(second);
    await fsp.symlink(outside, path.join(second, ".agents"));
    await expect(manager.create(document("escape"), "project", second)).rejects.toThrow("之外");
    expect(await fsp.readFile(secret, "utf8")).toBe("keep");
  });

  it("外部修改与同时新建不会覆盖内容", async () => {
    const original = document("review");
    const results = await Promise.allSettled([manager.create(original, "project", project), manager.create(original, "project", project)]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const skill = (await manager.list(project)).skills[0];
    await fsp.writeFile(skill.path, document("review", "outside edit"));
    await expect(manager.save(skill.id, document("review", "stale edit"), original, project)).rejects.toThrow("其他程序");
    expect((await manager.read(skill.id, project)).skill.description).toBe("outside edit");
  });

  it("坏技能可在列表里诊断；导入失败不留下半个目录", async () => {
    const source = path.join(root, "bad-source"); await fsp.mkdir(source);
    await fsp.writeFile(path.join(source, "SKILL.md"), "# no frontmatter");
    const result = await manager.importDirectory(source, "project", project);
    expect(result.errors).toHaveLength(1);
    expect(result.imported).toEqual([]);
    await expect(manager.create("---\nname: ../bad\ndescription: invalid\n---", "project", project)).rejects.toThrow();
    expect((await manager.list(project)).skills).toEqual([]);
  });
});
