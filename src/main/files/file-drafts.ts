import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FileDraft, FileDraftWriteRequest, ProjectPath } from "../../shared/files";
import { writeJsonAtomic } from "../atomic-file";
import { ProjectFileError, ProjectFilePaths, relativeFilePath } from "./file-path";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const TEXT_BYTES = 16 * 1024 * 1024;
const TOTAL_BYTES = 128 * 1024 * 1024;
export function parseFileDraft(raw: unknown): FileDraftWriteRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProjectFileError("invalidRequest", "Invalid file draft");
  const value = raw as FileDraftWriteRequest;
  if (typeof value.projectRoot !== "string" || !path.isAbsolute(value.projectRoot) || value.projectRoot.includes("\0") || value.projectRoot.length > 4096
    || typeof value.baseVersion !== "string" || !/^[a-f0-9]{64}$/.test(value.baseVersion)
    || !["lf", "crlf", "mixed", "none"].includes(value.lineEnding)) throw new ProjectFileError("invalidRequest", "Invalid draft base version");
  for (const text of [value.content, value.baseContent]) {
    if (typeof text !== "string" || text.includes("\0") || Buffer.from(text).toString("utf8") !== text) throw new ProjectFileError("invalidEncoding", "Draft must contain valid UTF-8 text");
    if (Buffer.byteLength(text) > TEXT_BYTES) throw new ProjectFileError("tooLarge", "Draft exceeds the recovery limit");
  }
  return { projectRoot: path.resolve(value.projectRoot), path: relativeFilePath(value.path), content: value.content,
    baseContent: value.baseContent, baseVersion: value.baseVersion, lineEnding: value.lineEnding };
}

/** Recovery is separate from repository files, and never evicts unsaved work. */
export class FileDrafts {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string, private readonly paths: ProjectFilePaths) {}
  private directory(projectRoot: string) { return path.join(this.root, hash(projectRoot)); }
  private target(request: ProjectPath) { return path.join(this.directory(request.projectRoot), `${hash(request.path)}.json`); }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next;
  }
  idle(): Promise<unknown> { return this.queue; }
  async list(request: ProjectPath): Promise<FileDraft[]> {
    const bound = await this.paths.resolve({ ...request, path: "" }, true);
    await this.queue;
    const directory = this.directory(bound.projectRoot);
    let names: string[];
    try { names = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const drafts: FileDraft[] = [];
    for (const name of names.filter((value) => /^[a-f0-9]{64}\.json$/.test(value))) {
      const file = path.join(directory, name);
      if ((await fs.stat(file)).size > TEXT_BYTES * 12) throw new ProjectFileError("tooLarge", "Recovery record is too large");
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as FileDraft;
      const draft = parseFileDraft(raw);
      if (draft.projectRoot !== bound.projectRoot || this.target(draft) !== file || !Number.isFinite(raw.updatedAt)) throw new ProjectFileError("invalidRequest", "Recovery record does not match this project");
      drafts.push({ ...draft, updatedAt: raw.updatedAt });
    }
    return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  write(raw: FileDraftWriteRequest, assertOwner: () => void): Promise<void> {
    const draft = parseFileDraft(raw);
    return this.serialize(async () => {
      // Authorize the project even when a file was deleted or redirected externally.
      await this.paths.resolve({ projectRoot: draft.projectRoot, path: "" }, true); assertOwner();
      const target = this.target(draft);
      const record = { ...draft, updatedAt: Date.now() };
      const bytes = Buffer.byteLength(JSON.stringify(record));
      let total = 0; let count = 0;
      const roots = await fs.readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
      for (const directory of roots.filter((name) => /^[a-f0-9]{64}$/.test(name))) {
        for (const name of await fs.readdir(path.join(this.root, directory))) {
          if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
          const file = path.join(this.root, directory, name);
          if (file !== target) { total += (await fs.stat(file)).size; count++; }
        }
      }
      if (count >= 100 || total + bytes > TOTAL_BYTES) throw new ProjectFileError("tooLarge", "Recovery storage is full; existing drafts were retained");
      await writeJsonAtomic(target, record, { beforeCommit: async () => {
        await this.paths.resolve({ projectRoot: draft.projectRoot, path: "" }, true); assertOwner();
      } });
    });
  }
  remove(request: ProjectPath, assertOwner: () => void): Promise<void> {
    const targetRequest = { projectRoot: path.resolve(request.projectRoot), path: relativeFilePath(request.path) };
    return this.serialize(async () => {
      await this.paths.resolve({ ...targetRequest, path: "" }, true); assertOwner();
      await fs.rm(this.target(targetRequest), { force: true });
    });
  }
}
