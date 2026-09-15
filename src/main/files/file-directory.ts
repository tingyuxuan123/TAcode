import fs from "node:fs/promises";
import path from "node:path";
import type { DirectoryRequest, FileEntry, FilePage, FileSearchRequest } from "../../shared/files";
import { WorkspaceFileIndex, skipWorkspacePath } from "../workspace-file-index";
import { filePage } from "./file-page";
import { ProjectFileError, ProjectFilePaths, type BoundFile } from "./file-path";

export class FileDirectories {
  private readonly cache = new Map<string, { stamp: string; entries: FileEntry[] }>();
  private readonly jobs = new Map<string, Promise<FileEntry[]>>();
  private readonly explicitIndex = new WorkspaceFileIndex(true);
  constructor(private readonly paths: ProjectFilePaths, private readonly index: WorkspaceFileIndex) {}

  async directory(request: DirectoryRequest): Promise<FilePage> {
    const bound = await this.paths.resolve(request, true);
    if (request.refresh) this.changed(bound.projectRoot);
    const entries = await this.entries(bound);
    const visible = request.includeIgnored || bound.path ? entries : entries.filter((entry) => !skipWorkspacePath(entry.path));
    return filePage(boundRequest(request, bound), visible, `directory:${Boolean(request.includeIgnored)}`);
  }

  async search(request: FileSearchRequest): Promise<FilePage> {
    if (typeof request.query !== "string" || request.query.length > 4096 || request.query.includes("\0")) throw new ProjectFileError("invalidRequest", "Invalid file search");
    const bound = await this.paths.resolve(request, true);
    if (!bound.exists) throw new ProjectFileError("missing", "Directory not found");
    if (!(await fs.stat(bound.file)).isDirectory()) throw new ProjectFileError("notDirectory", "Not a directory");
    // Explicit ignored subtrees are scanned on demand; the normal workspace search shares the @ index.
    const explicit = Boolean(request.includeIgnored || (bound.path && skipWorkspacePath(bound.path)));
    const paths = explicit ? await this.explicitIndex.list(bound.file, true) : await this.index.list(bound.projectRoot, request.refresh);
    const query = request.query.toLocaleLowerCase();
    const entries: FileEntry[] = [];
    for (const value of paths) {
      const directory = value.endsWith("/");
      const relative = value.replace(/\/$/, "");
      const full = explicit && bound.path ? `${bound.path}/${relative}` : relative;
      if (!explicit && bound.path && !full.startsWith(`${bound.path}/`)) continue;
      if (full.toLocaleLowerCase().includes(query)) entries.push({ path: full, name: path.posix.basename(full), kind: directory ? "directory" : "file" });
    }
    await this.paths.resolve(bound, true);
    return filePage(boundRequest(request, bound), entries, `search:${query}:${explicit}`);
  }

  clear(): void { this.cache.clear(); this.explicitIndex.clear(); }
  changed(root: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(`${path.resolve(root)}\0`)) this.cache.delete(key);
  }

  private async entries(bound: BoundFile): Promise<FileEntry[]> {
    if (!bound.exists) throw new ProjectFileError("missing", "Directory not found");
    const key = `${bound.projectRoot}\0${bound.path}`;
    const stamp = async () => {
      const stat = await fs.stat(bound.file, { bigint: true });
      if (!stat.isDirectory()) throw new ProjectFileError("notDirectory", "Not a directory");
      return `${bound.file}:${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
    };
    const current = await stamp();
    const cached = this.cache.get(key);
    if (cached?.stamp === current) {
      const checked = await this.paths.resolve(bound, true);
      if (checked.file !== bound.file) throw new ProjectFileError("changedDuringRead", "Directory binding changed; retry");
      return cached.entries;
    }
    let job = this.jobs.get(key);
    if (!job) {
      job = (async () => {
        const entries = (await fs.readdir(bound.file, { withFileTypes: true })).map((entry): FileEntry => ({
          name: entry.name, path: bound.path ? `${bound.path}/${entry.name}` : entry.name,
          kind: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
        })).sort((a, b) => (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) || a.name.localeCompare(b.name, "en"));
        const after = await this.paths.resolve(bound, true);
        if (after.file !== bound.file || await stamp() !== current) throw new ProjectFileError("changedDuringRead", "Directory changed during listing; retry");
        this.cache.delete(key); this.cache.set(key, { stamp: current, entries });
        while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
        return entries;
      })().finally(() => this.jobs.delete(key));
      this.jobs.set(key, job);
    }
    return job;
  }
}

const boundRequest = (request: DirectoryRequest, bound: BoundFile): DirectoryRequest => ({ ...request, projectRoot: bound.projectRoot, path: bound.path });
