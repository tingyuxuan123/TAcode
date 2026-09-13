import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { CapabilityScope, ManagedSkill, SkillDocument, SkillImportResult, SkillsSnapshot } from "../shared/capabilities";
import { isCapabilityProjectTrusted } from "../runtime/capability-config";
import { getTacodeHome } from "../runtime/home";
import { writeFileAtomic } from "./atomic-file";
import { isPathInsideRoot } from "./workspace-path";

const MAX_DOCUMENT_BYTES = 1_000_000;
const IGNORED = new Set(["node_modules", ".git", ".DS_Store", "__pycache__"]);
const mutations = new Map<string, Promise<unknown>>();

interface SkillRoot {
  id: string;
  path: string;
  inactive: string;
  boundary: string;
  label: string;
  scope: CapabilityScope;
}

/** 读-改-写也排队，防止开关、编辑与导入互相覆盖。 */
export function withCapabilityLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = mutations.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  mutations.set(key, next);
  void next.finally(() => { if (mutations.get(key) === next) mutations.delete(key); }).catch(() => undefined);
  return next;
}

async function exists(file: string): Promise<boolean> {
  try { await fsp.lstat(file); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function metadata(content: string): { name: string; description: string; version?: string; group?: string } {
  if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) throw new Error("SKILL.md 不能超过 1 MB");
  const { frontmatter } = parseFrontmatter(content.replace(/^\uFEFF/, ""));
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  if (!name || name.length > 64 || !/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error("name 需使用小写字母、数字和连字符，最多 64 个字符");
  if (!description) throw new Error("SKILL.md 的 frontmatter 必须包含 description");
  return {
    name, description,
    ...(typeof frontmatter.version === "string" || typeof frontmatter.version === "number" ? { version: String(frontmatter.version) } : {}),
    ...(typeof frontmatter.group === "string" && frontmatter.group.trim() ? { group: frontmatter.group.trim() } : {}),
  };
}

/** 管理文件，实际发现、验证、提示词注入和 /skill 调用仍由 Pi 完成。 */
export class SkillsManager {
  constructor(private readonly userHome = os.homedir()) {}

  private roots(cwd?: string): SkillRoot[] {
    const root = (id: string, container: string, label: string, scope: CapabilityScope, boundary = container): SkillRoot => ({
      id, path: path.join(container, "skills"), inactive: path.join(container, "skills-inactive"), label, scope, boundary,
    });
    return [
      ...(cwd ? [root("project-agents", path.join(cwd, ".agents"), ".agents/skills", "project", cwd), root("project-pi", path.join(cwd, ".pi"), ".pi/skills", "project", cwd)] : []),
      root("user-tacode", getTacodeHome(), "~/.tacode/skills", "user"),
      root("user-agents", path.join(this.userHome, ".agents"), "~/.agents/skills", "user"),
    ];
  }

  /** 对不存在的写入路径也检查最近祖先，防止符号链接绕过目录边界。 */
  private async safePath(root: SkillRoot, target: string): Promise<string> {
    if (!isPathInsideRoot(root.boundary, target)) throw new Error("技能路径超出允许目录");
    let ancestor = target;
    while (!(await exists(ancestor))) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error("技能目录不可访问");
      ancestor = parent;
    }
    let boundary = root.boundary;
    while (!(await exists(boundary))) boundary = path.dirname(boundary);
    const [realBoundary, realAncestor] = await Promise.all([fsp.realpath(boundary), fsp.realpath(ancestor)]);
    if (!isPathInsideRoot(realBoundary, realAncestor)) throw new Error("技能的符号链接指向允许目录之外");
    return target;
  }

  private async scan(root: SkillRoot, enabled: boolean): Promise<ManagedSkill[]> {
    const base = enabled ? root.path : root.inactive;
    const result: ManagedSkill[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || result.length >= 1_000) return;
      try {
        await this.safePath(root, dir);
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        if (entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) {
          const file = path.join(dir, "SKILL.md");
          let fields: ReturnType<typeof metadata> = { name: path.basename(dir), description: "" };
          let warning: string | undefined;
          try {
            if ((await fsp.stat(file)).size > MAX_DOCUMENT_BYTES) throw new Error("SKILL.md 不能超过 1 MB");
            fields = metadata(await fsp.readFile(file, "utf8"));
          } catch (error) { warning = error instanceof Error ? error.message : String(error); }
          const relative = path.relative(base, dir).split(path.sep).join("/");
          result.push({ id: `${root.id}:${relative}`, ...fields, scope: root.scope, rootLabel: root.label, path: file, enabled, ...(warning ? { warning } : {}) });
          return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
          if (entry.isDirectory()) await visit(path.join(dir, entry.name), depth + 1);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && depth === 0) throw error;
      }
    };
    await visit(base, 0);
    return result;
  }

  async list(cwd?: string): Promise<SkillsSnapshot> {
    const groups = await Promise.all(this.roots(cwd).flatMap((root) => [this.scan(root, true), this.scan(root, false)]));
    return { skills: groups.flat().sort((a, b) => a.name.localeCompare(b.name)), projectTrusted: isCapabilityProjectTrusted(cwd) };
  }

  private async resolve(id: string, cwd?: string): Promise<{ skill: ManagedSkill; root: SkillRoot; directory: string }> {
    if (typeof id !== "string" || id.length > 4_096) throw new Error("无效的技能标识");
    const root = this.roots(cwd).find((entry) => id.startsWith(`${entry.id}:`));
    if (!root) throw new Error("找不到此技能");
    const skill = [...await this.scan(root, true), ...await this.scan(root, false)].find((entry) => entry.id === id);
    if (!skill) throw new Error("技能已移动或删除，请刷新列表");
    await this.safePath(root, skill.path);
    return { skill, root, directory: path.dirname(skill.path) };
  }

  async directory(id: string, cwd?: string): Promise<string> { return (await this.resolve(id, cwd)).directory; }

  async read(id: string, cwd?: string): Promise<SkillDocument> {
    const { skill, root, directory } = await this.resolve(id, cwd);
    const files: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || files.length >= 500) return;
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        await this.safePath(root, file);
        if (entry.isDirectory()) await walk(file, depth + 1);
        else if (entry.isFile() && file !== skill.path) files.push(path.relative(directory, file).split(path.sep).join("/"));
      }
    };
    await walk(directory, 0);
    return { skill, content: await this.readText(skill.path), files: files.sort() };
  }

  private async readText(file: string): Promise<string> {
    if ((await fsp.stat(file)).size > MAX_DOCUMENT_BYTES) throw new Error("文件不能超过 1 MB，请在文件夹中打开");
    const text = await fsp.readFile(file, "utf8");
    if (text.includes("\0")) throw new Error("此文件不是可编辑的文本文件");
    return text;
  }

  async create(content: string, scope: CapabilityScope, cwd?: string): Promise<ManagedSkill> {
    const fields = metadata(content);
    const root = this.roots(cwd).find((entry) => entry.id === (scope === "project" ? "project-agents" : "user-tacode"));
    if (!root) throw new Error("请先选择项目");
    return withCapabilityLock(root.boundary, async () => {
      const target = await this.safePath(root, path.join(root.path, fields.name));
      if (await exists(target) || await exists(path.join(root.inactive, fields.name))) throw new Error(`已存在同名技能：${fields.name}`);
      await fsp.mkdir(target, { recursive: true });
      await writeFileAtomic(path.join(target, "SKILL.md"), content, { mode: 0o644 });
      return (await this.resolve(`${root.id}:${fields.name}`, cwd)).skill;
    });
  }

  async save(id: string, content: string, previousContent: string, cwd?: string): Promise<ManagedSkill> {
    metadata(content);
    const { root } = await this.resolve(id, cwd);
    return withCapabilityLock(root.boundary, async () => {
      const { skill } = await this.resolve(id, cwd);
      if (await this.readText(skill.path) !== previousContent) throw new Error("文件已被其他程序修改，请刷新后合并修改");
      await writeFileAtomic(skill.path, content, { mode: (await fsp.stat(skill.path)).mode & 0o777 });
      return (await this.resolve(id, cwd)).skill;
    });
  }

  async setEnabled(id: string, enabled: boolean, cwd?: string): Promise<ManagedSkill> {
    if (typeof enabled !== "boolean") throw new Error("无效的启用状态");
    const { root } = await this.resolve(id, cwd);
    return withCapabilityLock(root.boundary, async () => {
      const { skill, directory } = await this.resolve(id, cwd);
      if (skill.enabled === enabled) return skill;
      if (enabled && skill.warning) throw new Error(skill.warning);
      const relative = path.relative(skill.enabled ? root.path : root.inactive, directory);
      const target = await this.safePath(root, path.join(enabled ? root.path : root.inactive, relative));
      if (await exists(target)) throw new Error("目标目录已有同名技能，请先处理冲突");
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.rename(directory, target);
      return (await this.resolve(id, cwd)).skill;
    });
  }

  async remove(id: string, trash: (directory: string) => Promise<void>, cwd?: string): Promise<void> {
    const { root } = await this.resolve(id, cwd);
    await withCapabilityLock(root.boundary, async () => trash((await this.resolve(id, cwd)).directory));
  }

  private async childFile(id: string, file: string, cwd?: string): Promise<string> {
    const { root, directory } = await this.resolve(id, cwd);
    if (typeof file !== "string" || path.isAbsolute(file) || file.includes("\\") || file.includes("\0")) throw new Error("无效的技能文件路径");
    const target = path.resolve(directory, file);
    if (!isPathInsideRoot(directory, target) || target === directory) throw new Error("文件路径超出技能目录");
    await this.safePath(root, target);
    const [realDir, realFile] = await Promise.all([fsp.realpath(directory), fsp.realpath(target)]);
    if (!isPathInsideRoot(realDir, realFile)) throw new Error("文件路径超出技能目录");
    if (!(await fsp.stat(target)).isFile()) throw new Error("请选择文本文件");
    return target;
  }

  async readFile(id: string, file: string, cwd?: string): Promise<string> { return this.readText(await this.childFile(id, file, cwd)); }

  async saveFile(id: string, file: string, content: string, previousContent: string, cwd?: string): Promise<void> {
    if (path.posix.normalize(file).toLowerCase() === "skill.md") throw new Error("请在技能正文中编辑 SKILL.md");
    if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES || content.includes("\0")) throw new Error("文件须为不超过 1 MB 的文本");
    const { root } = await this.resolve(id, cwd);
    await withCapabilityLock(root.boundary, async () => {
      const target = await this.childFile(id, file, cwd);
      if (await this.readText(target) !== previousContent) throw new Error("文件已被其他程序修改，请刷新后合并修改");
      await writeFileAtomic(target, content, { mode: (await fsp.stat(target)).mode & 0o777 });
    });
  }

  async importDirectory(source: string, scope: CapabilityScope, cwd?: string): Promise<SkillImportResult> {
    const root = this.roots(cwd).find((entry) => entry.id === (scope === "project" ? "project-agents" : "user-tacode"));
    if (!root) throw new Error("请先选择项目");
    const result: SkillImportResult = { imported: [], skipped: [], errors: [] };
    const sources: string[] = [];
    const discover = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6 || sources.length >= 100) return;
      if (await exists(path.join(dir, "SKILL.md"))) { sources.push(dir); return; }
      for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED.has(entry.name)) await discover(path.join(dir, entry.name), depth + 1);
      }
    };
    await discover(source, 0);
    if (!sources.length) throw new Error("所选目录中没有找到 SKILL.md");
    for (const dir of sources) {
      try {
        const fields = metadata(await this.readText(path.join(dir, "SKILL.md")));
        await withCapabilityLock(root.boundary, async () => {
          const target = await this.safePath(root, path.join(root.path, fields.name));
          if (await exists(target) || await exists(path.join(root.inactive, fields.name))) { result.skipped.push(fields.name); return; }
          const temporary = await this.safePath(root, path.join(root.path, `.import-${randomUUID()}`));
          let bytes = 0;
          let count = 0;
          try {
            await fsp.mkdir(root.path, { recursive: true });
            await fsp.cp(dir, temporary, { recursive: true, errorOnExist: true, force: false, filter: async (file) => {
              if (IGNORED.has(path.basename(file))) return false;
              const stat = await fsp.lstat(file);
              if (stat.isSymbolicLink()) throw new Error("导入目录包含符号链接，请先转换为普通文件");
              if (!stat.isFile() && !stat.isDirectory()) throw new Error("技能目录包含不支持的文件类型");
              bytes += stat.isFile() ? stat.size : 0;
              if (++count > 2_000 || bytes > 50_000_000) throw new Error("技能超过 2,000 个文件或 50 MB");
              return true;
            } });
            await fsp.rename(temporary, target);
            result.imported.push(fields.name);
          } finally { await fsp.rm(temporary, { recursive: true, force: true }); }
        });
      } catch (error) { result.errors.push(`${path.basename(dir)}：${error instanceof Error ? error.message : String(error)}`); }
    }
    return result;
  }
}
