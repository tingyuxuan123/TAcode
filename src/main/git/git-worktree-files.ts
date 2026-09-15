import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GitRepositoryInfo } from "../../shared/git";
import { gitDigest } from "./git-diff";
import { GitReadError } from "./git-process";

export interface GitFileImage {
  kind: "missing" | "file" | "symlink";
  mode: number;
  bytes: Buffer;
  version: string;
}
export interface GitFileReplacement {
  path: string;
  absolutePath: string;
  before: GitFileImage;
  after: GitFileImage;
}
export const missingGitFile = (): GitFileImage => ({ kind: "missing", mode: 0, bytes: Buffer.alloc(0), version: "missing" });
export const insideGitProject = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const identity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");

/** Resolve even a missing parent, without following a link outside the selected project. */
export async function gitWorktreePath(repository: GitRepositoryInfo, relative: string): Promise<string> {
  const parts = relative.split("/");
  if (!relative || relative.includes("\0") || path.isAbsolute(relative) || path.posix.isAbsolute(relative)
    || parts.some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new GitReadError("invalidPath", "Invalid Git worktree path");
  }
  const target = path.resolve(repository.root, ...parts);
  if (target === repository.projectRoot || !insideGitProject(repository.projectRoot, target)) throw new GitReadError("outsideProject", "Git path is outside the selected project");
  let parent = path.dirname(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = await fs.realpath(parent);
      if (!insideGitProject(repository.projectRoot, canonical)) throw new GitReadError("outsideProject", "A parent symlink points outside the project");
      return path.join(canonical, ...missing.reverse(), path.basename(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === repository.projectRoot || parent === path.dirname(parent)) throw error;
      missing.push(path.basename(parent)); parent = path.dirname(parent);
    }
  }
}

/** Raw bytes, modes and link targets. Git's normalized text is never used as a backup. */
export async function readGitFileImage(target: string, maxBytes = 128 * 1024 * 1024): Promise<GitFileImage> {
  let initial: BigIntStats;
  try { initial = await fs.lstat(target, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return missingGitFile(); throw error; }
  if (!initial.isFile() && !initial.isSymbolicLink()) throw new GitReadError("unsupportedChange", "Directory and submodule contents must be handled in their own repository");
  if (initial.size > BigInt(maxBytes)) throw new GitReadError("outputLimit", "File is too large for a recoverable Git operation");
  const mode = Number(initial.mode) & 0o777;
  const kind = initial.isSymbolicLink() ? "symlink" : "file";
  let bytes: Buffer;
  if (kind === "symlink") bytes = await fs.readlink(target, { encoding: "buffer" });
  else {
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (identity(initial) !== identity(before)) throw new GitReadError("staleSnapshot", "File was replaced while it was opened");
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const read = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      if (offset !== Number(before.size) || identity(before) !== identity(await handle.stat({ bigint: true }))) throw new GitReadError("staleSnapshot", "File changed while it was read");
      bytes = buffer.subarray(0, offset);
    } finally { await handle.close(); }
  }
  if (identity(initial) !== identity(await fs.lstat(target, { bigint: true }))) throw new GitReadError("staleSnapshot", "File changed while it was read");
  return { kind, mode, bytes, version: gitDigest(kind, String(mode), bytes) };
}

export async function writeGitFileImage(target: string, value: GitFileImage): Promise<void> {
  if (value.kind === "missing") return;
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (value.kind === "symlink") { await fs.symlink(value.bytes, target); return; }
  const handle = await fs.open(target, "wx", value.mode);
  try { await handle.writeFile(value.bytes); await handle.chmod(value.mode); await handle.sync(); }
  finally { await handle.close(); }
}

interface InstalledFile { entry: GitFileReplacement; backup: string; temporary: string; moved: boolean; installed: boolean }

/**
 * Replace via a same-directory backup and non-overwriting hard-link publish.
 * A writer racing the rename is detected on the moved inode, and a new file
 * appearing before publish causes EEXIST instead of being overwritten.
 */
export class GitFileTransaction {
  private readonly installed: InstalledFile[] = [];
  constructor(private readonly repository: GitRepositoryInfo) {}

  async apply(entries: readonly GitFileReplacement[]): Promise<void> {
    for (const entry of entries) {
      const target = await gitWorktreePath(this.repository, entry.path);
      if (target !== entry.absolutePath || (await readGitFileImage(target)).version !== entry.before.version) throw new GitReadError("staleSnapshot", `Working file changed: ${entry.path}`);
    }
    for (const entry of entries) {
      if (entry.before.version === entry.after.version) continue;
      const target = await gitWorktreePath(this.repository, entry.path);
      if (target !== entry.absolutePath) throw new GitReadError("staleSnapshot", `Working path changed: ${entry.path}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tag = `.tacode-git-${randomUUID()}`;
      const record: InstalledFile = { entry, backup: path.join(path.dirname(target), `${tag}.before`), temporary: path.join(path.dirname(target), `${tag}.after`), moved: false, installed: false };
      this.installed.push(record);
      await writeGitFileImage(record.temporary, entry.after);
      if ((await readGitFileImage(target)).version !== entry.before.version) throw new GitReadError("staleSnapshot", `Working file changed: ${entry.path}`);
      if (entry.before.kind !== "missing") {
        await fs.rename(target, record.backup); record.moved = true;
        if ((await readGitFileImage(record.backup)).version !== entry.before.version) throw new GitReadError("staleSnapshot", `Working file changed before replacement: ${entry.path}`);
      }
      if (entry.after.kind !== "missing") {
        // link(2) may follow a symbolic link on macOS. Publish the link itself
        // explicitly so recovery never creates a hard link to its target.
        if (entry.after.kind === "symlink") await fs.symlink(entry.after.bytes, target);
        else await fs.link(record.temporary, target);
        record.installed = true;
      }
    }
  }

  async rollback(): Promise<void> {
    const failures: string[] = [];
    for (const record of [...this.installed].reverse()) {
      const { entry } = record;
      try {
        const target = await gitWorktreePath(this.repository, entry.path);
        if (target !== entry.absolutePath) throw new Error("parent path changed");
        if (record.installed) {
          if ((await readGitFileImage(target)).version !== entry.after.version) throw new Error("replacement was edited");
          await fs.unlink(target); record.installed = false;
        }
        if (record.moved) {
          const backup = await readGitFileImage(record.backup);
          if (backup.kind === "symlink") await fs.symlink(backup.bytes, target);
          else await fs.link(record.backup, target);
          await fs.unlink(record.backup); record.moved = false;
        }
        await fs.rm(record.temporary, { force: true });
      } catch (error) { failures.push(`${entry.path}: ${String(error)}; backup: ${record.backup}`); }
    }
    if (failures.length) throw new GitReadError("recoveryFailed", "A concurrent file change prevented complete rollback; the recovery point and backups were preserved", failures.join("\n"));
  }

  async finish(): Promise<void> {
    for (const record of this.installed) {
      // The durable recovery record already has the original bytes. A failed
      // cleanup must never roll back a successfully published index.
      await fs.rm(record.backup, { force: true }).catch(() => undefined);
      await fs.rm(record.temporary, { force: true }).catch(() => undefined);
    }
  }
}
