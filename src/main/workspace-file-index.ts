import fs from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "dist-dev", "dist-production", "dist-electron", "release", "build", "out", "coverage", ".next", ".nuxt", ".output", ".turbo", ".vite", ".cache", ".tacode", ".build", "DerivedData", "Pods", "__pycache__", ".pnpm-store"]);
export function skipWorkspacePath(relative: string): boolean {
  return relative.replaceAll("\\", "/").split("/").some((part) => SKIP_DIRS.has(part) || (part.startsWith(".") && part !== ".agents" && part !== ".pi"));
}

interface IndexEntry {
  paths: Set<string>;
  sorted: string[];
  full: boolean;
  dirty: Set<string>;
  job?: Promise<string[]>;
}

/** 完整路径索引；浏览分页由 UI 处理，搜索不依赖截断的目录列表。 */
export class WorkspaceFileIndex {
  private roots = new Map<string, IndexEntry>();
  private entry(root: string): IndexEntry {
    let entry = this.roots.get(root);
    if (!entry) entry = { paths: new Set(), sorted: [], full: true, dirty: new Set() };
    this.roots.delete(root);
    this.roots.set(root, entry);
    while (this.roots.size > 3) this.roots.delete(this.roots.keys().next().value!);
    return entry;
  }

  changed(root: string, relative?: string | null): void {
    const entry = this.entry(path.resolve(root));
    if (!relative) { entry.full = true; return; }
    const file = relative.replaceAll("\\", "/").replace(/\/$/, "");
    if (!skipWorkspacePath(file) && !path.isAbsolute(file) && !file.split("/").includes("..")) entry.dirty.add(file);
  }

  list(root: string, refresh = false): Promise<string[]> {
    root = path.resolve(root);
    const entry = this.entry(root);
    if (refresh) entry.full = true;
    if (entry.job) return entry.job;
    if (!entry.full && !entry.dirty.size) return Promise.resolve(entry.sorted);
    entry.job = this.update(root, entry).finally(() => { entry.job = undefined; });
    return entry.job;
  }

  clear(): void { this.roots.clear(); }

  private async update(root: string, entry: IndexEntry): Promise<string[]> {
    try {
      while (entry.full || entry.dirty.size) {
        const full = entry.full;
        const dirty = [...entry.dirty];
        entry.full = false;
        entry.dirty.clear();
        const next = full ? new Set<string>() : new Set(entry.paths);
        if (full) await this.walk(root, "", next);
        else for (const relative of dirty) {
          for (const old of next) if (old === relative || old.startsWith(`${relative}/`)) next.delete(old);
          let stat;
          try { stat = await fs.lstat(path.join(root, relative)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
          if (stat.isDirectory()) { next.add(`${relative}/`); await this.walk(root, relative, next); }
          else if (stat.isFile()) next.add(relative);
        }
        entry.paths = next;
      }
      entry.sorted = [...entry.paths].sort((a, b) => a.localeCompare(b, "en"));
      return entry.sorted;
    } catch (error) {
      entry.full = true;
      throw error;
    }
  }

  private async walk(root: string, relative: string, result: Set<string>): Promise<void> {
    let directory;
    try { directory = await fs.opendir(path.join(root, relative)); }
    catch (error) { if (relative && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for await (const entry of directory) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (skipWorkspacePath(name)) continue;
      if (entry.isDirectory()) { result.add(`${name}/`); await this.walk(root, name, result); }
      else if (entry.isFile()) result.add(name);
    }
  }
}
