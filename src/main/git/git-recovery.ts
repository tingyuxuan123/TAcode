import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GitRecoveryPoint, GitRepositoryInfo } from "../../shared/git";
import { gitDigest } from "./git-diff";
import { GitReadError } from "./git-process";
import { missingGitFile, type GitFileImage, type GitFileReplacement } from "./git-worktree-files";

interface StoredImage { kind: GitFileImage["kind"]; mode: number; version: string }
export interface GitRecoveryManifest extends GitRecoveryPoint {
  version: 1;
  repositoryId: string;
  head: string | null;
  repositoryPaths: string[];
  indexBefore: string;
  indexAfter: string;
  files: { path: string; before: StoredImage; after: StoredImage }[];
}
export const gitRecoveryId = (id: unknown): string => {
  if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new GitReadError("invalidRequest", "Invalid recovery identifier");
  return id;
};
export const recoverySummary = (record: GitRecoveryManifest): GitRecoveryPoint => ({ id: record.id, projectRoot: record.projectRoot,
  createdAt: record.createdAt, scope: record.scope, status: record.status, paths: record.paths });
const imageMetadata = ({ kind, mode, version }: GitFileImage): StoredImage => ({ kind, mode, version });

async function writeDurably(file: string, bytes: string | Buffer): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Persistent, private to TACode and independent of Agent checkpoints. */
export class GitRecoveryStore {
  constructor(readonly root: string) {}
  private directory(id: string): string { return path.join(this.root, gitRecoveryId(id)); }
  private async save(record: GitRecoveryManifest): Promise<void> {
    const directory = this.directory(record.id);
    const temporary = path.join(directory, `manifest-${randomUUID()}.tmp`);
    try {
      await writeDurably(temporary, JSON.stringify(record, null, 2));
      await fs.rename(temporary, path.join(directory, "manifest.json"));
      await syncDirectory(directory);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async create(repository: GitRepositoryInfo, scope: "unstaged" | "staged", paths: readonly string[],
    indexBefore: string, indexAfter: string, files: readonly GitFileReplacement[]): Promise<GitRecoveryManifest> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const directory = this.directory(id);
    await fs.mkdir(directory, { mode: 0o700 });
    const record: GitRecoveryManifest = { version: 1, id, repositoryId: repository.id, projectRoot: repository.projectRoot,
      createdAt: Date.now(), head: repository.head, scope, status: "prepared",
      paths: paths.map((file) => path.relative(repository.projectRoot, path.join(repository.root, ...file.split("/"))).split(path.sep).join("/")),
      repositoryPaths: [...paths], indexBefore, indexAfter, files: files.map((file) => ({ path: file.path, before: imageMetadata(file.before), after: imageMetadata(file.after) })) };
    try {
      for (const [index, file] of files.entries()) {
        if (file.before.kind !== "missing") await writeDurably(path.join(directory, `${index}.before`), file.before.bytes);
        if (file.after.kind !== "missing") await writeDurably(path.join(directory, `${index}.after`), file.after.bytes);
      }
      await this.save(record);
      await syncDirectory(this.root);
      return record;
    } catch (error) {
      // No repository write has happened yet. A partial backup is unusable.
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async status(record: GitRecoveryManifest, status: GitRecoveryPoint["status"]): Promise<GitRecoveryManifest> {
    const next = { ...record, status };
    await this.save(next);
    return next;
  }

  async read(projectRoot: string, id: string): Promise<GitRecoveryManifest> {
    const file = path.join(this.directory(id), "manifest.json");
    if ((await fs.stat(file)).size > 8 * 1024 * 1024) throw new GitReadError("invalidOutput", "Recovery manifest is too large");
    const record = JSON.parse(await fs.readFile(file, "utf8")) as GitRecoveryManifest;
    if (record.version !== 1 || record.id !== id || record.projectRoot !== projectRoot || !Array.isArray(record.files)
      || !Array.isArray(record.repositoryPaths) || record.repositoryPaths.length > 10000 || record.files.length > 10000
      || (record.scope !== "unstaged" && record.scope !== "staged") || typeof record.indexBefore !== "string" || typeof record.indexAfter !== "string") {
      throw new GitReadError("invalidOutput", "Invalid or foreign recovery record");
    }
    return record;
  }

  async images(record: GitRecoveryManifest): Promise<{ path: string; before: GitFileImage; after: GitFileImage }[]> {
    let budget = 256 * 1024 * 1024;
    const read = async (index: number, side: "before" | "after", meta: StoredImage): Promise<GitFileImage> => {
      if (meta.kind === "missing") return missingGitFile();
      if ((meta.kind !== "file" && meta.kind !== "symlink") || !Number.isInteger(meta.mode) || meta.mode < 0 || meta.mode > 0o777) throw new GitReadError("invalidOutput", "Invalid recovery file metadata");
      const file = path.join(this.directory(record.id), `${index}.${side}`);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > Math.min(128 * 1024 * 1024, budget)) throw new GitReadError("invalidOutput", "Invalid recovery blob");
      const bytes = await fs.readFile(file); budget -= bytes.length;
      if (gitDigest(meta.kind, String(meta.mode), bytes) !== meta.version) throw new GitReadError("invalidOutput", "Recovery blob does not match its recorded version");
      return { ...meta, bytes };
    };
    const result = [];
    for (const [index, file] of record.files.entries()) result.push({ path: file.path,
      before: await read(index, "before", file.before), after: await read(index, "after", file.after) });
    return result;
  }

  async list(projectRoot: string): Promise<GitRecoveryPoint[]> {
    let entries;
    try { entries = await fs.readdir(this.root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const result: GitRecoveryPoint[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      try {
        const record = await this.read(projectRoot, entry.name);
        if (record.status !== "rolledBack") result.push(recoverySummary(record));
      } catch (error) {
        if (error instanceof GitReadError && error.message === "Invalid or foreign recovery record") continue;
        throw error;
      }
    }
    return result.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  }
}
