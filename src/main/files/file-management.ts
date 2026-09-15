import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FileLocation, FileMutation, FileMutationRequest, FileTarget, ProjectPath } from "../../shared/files";
import { ProjectFileError, ProjectFilePaths, relativeFilePath, type BoundFile } from "./file-path";
import { isPathInsideRoot } from "../workspace-path";

const stamp = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
export interface FileManagementOptions { trash?(file: string): Promise<void> }
export class FileManagement {
  constructor(private readonly paths: ProjectFilePaths, private readonly options: FileManagementOptions) {}
  private validate(value: string): string {
    const relative = relativeFilePath(value);
    if (Buffer.from(relative).toString("utf8") !== relative) throw new ProjectFileError("invalidRequest", "The path must contain valid Unicode text");
    if (relative.split("/").some((part) => part.toLowerCase() === ".git")) throw new ProjectFileError("invalidRequest", "Git metadata cannot be changed with file management");
    if (process.platform === "win32" && relative.split("/").some((part) => /[<>:"\\|?*\x00-\x1f]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new ProjectFileError("invalidRequest", "Invalid Windows filename");
    return relative;
  }
  async location(request: ProjectPath): Promise<FileLocation> {
    const bound = request.path ? await this.paths.entry(request) : await this.paths.resolve(request, true);
    return { kind: "location", projectRoot: bound.projectRoot, path: bound.path, absolutePath: bound.lexicalFile };
  }
  async inspect(request: ProjectPath): Promise<FileTarget> {
    const bound = await this.paths.entry({ ...request, path: this.validate(request.path) });
    this.validate(path.relative(bound.realRoot, bound.file).split(path.sep).join("/"));
    if (!bound.exists) throw new ProjectFileError("missing", "The selected entry no longer exists");
    const stat = await fs.lstat(bound.file, { bigint: true });
    const digest = createHash("sha256"); let count = 0;
    const visit = async (file: string, relative: string): Promise<void> => {
      if (++count > 100_000) throw new ProjectFileError("tooLarge", "The directory is too large to verify");
      const before = await fs.lstat(file, { bigint: true }); digest.update(JSON.stringify([relative, stamp(before)]));
      if (before.isSymbolicLink()) digest.update(await fs.readlink(file));
      else if (before.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), `${relative}/${name}`);
      else if (!before.isFile()) throw new ProjectFileError("notFile", "Special filesystem entries cannot be managed");
      if (stamp(await fs.lstat(file, { bigint: true })) !== stamp(before)) throw new ProjectFileError("conflict", "The entry changed while verifying; retry");
    };
    await visit(bound.file, "");
    return { kind: "target", projectRoot: bound.projectRoot, path: bound.path, version: digest.digest("hex"),
      entryKind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file" };
  }
  private async parentWritable(bound: BoundFile): Promise<void> {
    const parent = path.dirname(bound.file);
    if (!(Number((await fs.stat(parent)).mode) & 0o222)) throw new ProjectFileError("readOnly", "The parent directory is read-only");
    await fs.access(parent, constants.W_OK);
  }
  async mutate(request: FileMutationRequest, active: () => void): Promise<FileMutation> {
    const relative = this.validate(request.path); const operation = request.operation;
    const bound = await this.paths.entry({ ...request, path: relative }); await this.parentWritable(bound); active();
    this.validate(path.relative(bound.realRoot, bound.file).split(path.sep).join("/"));
    if (operation === "createFile" || operation === "createDirectory") {
      if (bound.exists) throw new ProjectFileError("exists", "An entry already exists at this path");
      const checked = await this.paths.entry(bound); active();
      if (checked.file !== bound.file || checked.exists) throw new ProjectFileError("conflict", "The target path changed");
      try {
        if (operation === "createDirectory") await fs.mkdir(bound.file);
        else { const handle = await fs.open(bound.file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o666); await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProjectFileError("exists", "An entry already exists at this path"); throw error; }
      return { kind: "mutation", projectRoot: bound.projectRoot, path: relative, operation };
    }
    if (operation !== "rename" && operation !== "trash") throw new ProjectFileError("invalidRequest", "Unknown file operation");
    if (typeof request.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(request.expectedVersion)) throw new ProjectFileError("invalidRequest", "An expected entry version is required");
    const verify = async () => {
      const checked = await this.paths.entry(bound);
      if (checked.file !== bound.file || (await this.inspect(bound)).version !== request.expectedVersion) throw new ProjectFileError("conflict", "The entry changed since confirmation; retry");
      active();
    };
    if (operation === "trash") {
      if (!this.options.trash) throw new ProjectFileError("unavailable", "The system trash is unavailable");
      await verify(); await this.options.trash(bound.file);
      return { kind: "mutation", projectRoot: bound.projectRoot, path: relative, operation };
    }
    const destination = this.validate(request.destination ?? "");
    if (destination === relative || destination.startsWith(`${relative}/`)) throw new ProjectFileError("invalidRequest", "Choose a different destination outside this entry");
    const target = await this.paths.entry({ projectRoot: bound.projectRoot, path: destination });
    this.validate(path.relative(target.realRoot, target.file).split(path.sep).join("/"));
    if (isPathInsideRoot(bound.file, target.file)) throw new ProjectFileError("invalidRequest", "The destination is inside the selected entry");
    if (target.exists) {
      const fold = (name: string) => name.normalize("NFC").toLowerCase();
      const sourceStat = await fs.lstat(bound.file, { bigint: true }); const targetStat = await fs.lstat(target.file, { bigint: true });
      const sameEntry = path.dirname(bound.file) === path.dirname(target.file) && fold(path.basename(bound.file)) === fold(path.basename(target.file))
        && stamp(sourceStat) === stamp(targetStat) && (await fs.readdir(path.dirname(bound.file))).filter((name) => fold(name) === fold(path.basename(bound.file))).length === 1;
      if (!sameEntry) throw new ProjectFileError("exists", "The destination already exists");
      await verify(); active(); await fs.rename(bound.file, target.file);
      return { kind: "mutation", projectRoot: bound.projectRoot, path: relative, destination, operation };
    }
    await this.parentWritable(target); await verify();
    let reserved: string | undefined;
    try {
      // Reserving the destination makes concurrent creations fail instead of overwriting them.
      const source = await fs.lstat(bound.file);
      if (source.isDirectory() && process.platform === "win32") {
        await verify();
        if ((await this.paths.entry(target)).exists) throw new ProjectFileError("exists", "The destination already exists");
        active(); await fs.rename(bound.file, target.file);
        return { kind: "mutation", projectRoot: bound.projectRoot, path: relative, destination, operation };
      }
      if (source.isDirectory()) await fs.mkdir(target.file);
      else { const handle = await fs.open(target.file, "wx"); await handle.close(); }
      reserved = stamp(await fs.lstat(target.file, { bigint: true }));
      const checked = await this.paths.entry(target);
      if (checked.file !== target.file || stamp(await fs.lstat(target.file, { bigint: true })) !== reserved) throw new ProjectFileError("conflict", "The destination changed during rename");
      await verify();
      if (stamp(await fs.lstat(target.file, { bigint: true })) !== reserved) throw new ProjectFileError("conflict", "The destination changed during rename");
      active(); await fs.rename(bound.file, target.file); reserved = undefined;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProjectFileError("exists", "The destination already exists"); throw error; }
    finally {
      if (reserved) {
        try { const stat = await fs.lstat(target.file, { bigint: true }); if (stamp(stat) === reserved) { if (stat.isDirectory()) await fs.rmdir(target.file); else await fs.unlink(target.file); } }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error; }
      }
    }
    return { kind: "mutation", projectRoot: bound.projectRoot, path: relative, destination, operation };
  }
}
