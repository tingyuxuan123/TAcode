import fs from "node:fs/promises";
import path from "node:path";
import type { FileError, FileErrorCode, ProjectPath } from "../../shared/files";
import { isPathInsideRoot } from "../workspace-path";

export class ProjectFileError extends Error {
  constructor(readonly code: FileErrorCode, message: string) { super(message); this.name = "ProjectFileError"; }
}
export const fileFailure = (error: unknown): FileError => ({ kind: "error", error: {
  code: error instanceof ProjectFileError ? error.code : "failed",
  message: error instanceof Error ? error.message : String(error),
} });

export function relativeFilePath(value: unknown, allowRoot = false): string {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw new ProjectFileError("invalidRequest", "Invalid project path");
  const normalized = process.platform === "win32" ? value.replaceAll("\\", "/") : value;
  if (allowRoot && (normalized === "" || normalized === ".")) return "";
  if (!normalized || path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new ProjectFileError("invalidRequest", "Invalid project-relative path");
  return normalized;
}

export interface BoundFile extends ProjectPath { realRoot: string; file: string; lexicalFile: string; exists: boolean; symlink: boolean }
export class ProjectFilePaths {
  constructor(private readonly resolveProject: (root: string) => Promise<string>) {}
  async resolve(request: ProjectPath, allowRoot = false): Promise<BoundFile> {
    if (typeof request.projectRoot !== "string" || !path.isAbsolute(request.projectRoot) || request.projectRoot.length > 4096 || request.projectRoot.includes("\0")) throw new ProjectFileError("invalidRequest", "An explicit absolute project root is required");
    const projectRoot = path.resolve(request.projectRoot);
    const relative = relativeFilePath(request.path, allowRoot);
    let realRoot: string;
    try {
      const allowed = await this.resolveProject(projectRoot);
      realRoot = await fs.realpath(allowed);
      if (await fs.realpath(projectRoot) !== realRoot || !(await fs.stat(realRoot)).isDirectory()) throw new Error("The project binding changed");
    } catch (error) { throw new ProjectFileError("outsideProject", error instanceof Error ? error.message : String(error)); }
    const lexicalFile = path.resolve(projectRoot, ...relative.split("/"));
    if (!isPathInsideRoot(projectRoot, lexicalFile)) throw new ProjectFileError("outsideProject", "Path outside project");
    let file: string; let exists = true; let symlink = false;
    try { file = await fs.realpath(lexicalFile); symlink = (await fs.lstat(lexicalFile)).isSymbolicLink(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
      exists = false;
      const tail: string[] = []; let parent = lexicalFile;
      while (true) {
        tail.unshift(path.basename(parent)); parent = path.dirname(parent);
        if (!isPathInsideRoot(projectRoot, parent)) throw new ProjectFileError("outsideProject", "Path outside project");
        try { file = path.join(await fs.realpath(parent), ...tail); break; }
        catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT" && (missing as NodeJS.ErrnoException).code !== "ENOTDIR") throw missing; }
      }
    }
    if (!isPathInsideRoot(realRoot, file!)) throw new ProjectFileError("outsideProject", "Path outside project");
    return { projectRoot, path: relative, realRoot, file: file!, lexicalFile, exists, symlink };
  }
}
