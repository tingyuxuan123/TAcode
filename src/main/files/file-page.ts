import { createHash } from "node:crypto";
import type { FileEntry, FilePage, ProjectPath } from "../../shared/files";
import { ProjectFileError } from "./file-path";

export const fileDigest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export function filePage(request: ProjectPath & { cursor?: string; limit?: number }, entries: readonly FileEntry[], scope: string): FilePage {
  const version = fileDigest(JSON.stringify([request.projectRoot, request.path, scope, entries]));
  const limit = request.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ProjectFileError("invalidRequest", "Page limit must be between 1 and 500");
  let offset = 0;
  if (request.cursor !== undefined) {
    try {
      if (request.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(request.cursor)) throw new Error("Invalid cursor");
      const value = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")) as { version: string; offset: number };
      if (value.version !== version) throw new ProjectFileError("staleCursor", "The directory or search changed; restart from the first page");
      if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > entries.length) throw new Error("Invalid offset");
      offset = value.offset;
    } catch (error) { if (error instanceof ProjectFileError) throw error; throw new ProjectFileError("invalidRequest", "Invalid page cursor"); }
  }
  const end = Math.min(entries.length, offset + limit);
  return { kind: "ready", projectRoot: request.projectRoot, path: request.path, entries: entries.slice(offset, end), total: entries.length, version,
    cursor: end < entries.length ? Buffer.from(JSON.stringify({ version, offset: end })).toString("base64url") : undefined };
}
