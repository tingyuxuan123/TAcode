import { constants } from "node:fs";
import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { DOCUMENT_EDIT_BYTES, DOCUMENT_PAGE_BYTES, type DocumentReadRequest, type DocumentWriteRequest, type FileDocument, type FileMetadata } from "../../shared/files";
import { fileMediaType } from "../../shared/file-format";
import { writeFileAtomic } from "../atomic-file";
import { fileDigest } from "./file-page";
import { ProjectFileError, ProjectFilePaths } from "./file-path";
import type { ProjectPreviewRegistry } from "./preview-registry";

const stamp = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const defaults = (): FileMetadata => ({ size: 0, readBytes: 0, mode: 0, bom: false, lineEnding: "none", writable: false, encoding: "utf8", offset: 0 });
function lineEnding(text: string): FileMetadata["lineEnding"] {
  const crlf = text.includes("\r\n"); const lf = /(?<!\r)\n/.test(text); const cr = /\r(?!\n)/.test(text);
  return (crlf && (lf || cr)) || (cr && lf) ? "mixed" : crlf ? "crlf" : lf ? "lf" : cr ? "mixed" : "none";
}

export class FileDocuments {
  constructor(private readonly paths: ProjectFilePaths, private readonly previews: ProjectPreviewRegistry) {}
  async read(request: DocumentReadRequest): Promise<FileDocument> {
    const offset = request.offset ?? 0; let length = request.length ?? DOCUMENT_EDIT_BYTES;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 4 || length > DOCUMENT_EDIT_BYTES) throw new ProjectFileError("invalidRequest", "Invalid document byte range");
    if (request.expectedVersion !== undefined && !/^[a-f0-9]{64}$/.test(request.expectedVersion)) throw new ProjectFileError("invalidRequest", "Invalid expected document version");
    const bound = await this.paths.resolve(request);
    if (!bound.exists) return { kind: "document", projectRoot: bound.projectRoot, path: bound.path, status: "missing", content: null, metadata: defaults() };
    const beforeOpen = await fs.stat(bound.file, { bigint: true });
    if (!beforeOpen.isFile()) throw new ProjectFileError("notFile", "Not a regular file");
    const handle = await fs.open(bound.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stamp(beforeOpen) !== stamp(stat)) throw new ProjectFileError("changedDuringRead", "Document changed during opening; retry");
      const size = Number(stat.size);
      if (!Number.isSafeInteger(size) || offset > size) throw new ProjectFileError("invalidRequest", "Byte offset exceeds document size");
      const full = size <= DOCUMENT_EDIT_BYTES;
      if (!full && request.length === undefined) length = DOCUMENT_PAGE_BYTES;
      const start = full ? 0 : offset;
      const count = full ? size : Math.min(size - start, length);
      const buffer = Buffer.alloc(count);
      let readBytes = 0;
      while (readBytes < count) {
        const result = await handle.read(buffer, readBytes, count - readBytes, start + readBytes);
        if (!result.bytesRead) break;
        readBytes += result.bytesRead;
      }
      const head = Buffer.alloc(Math.min(size, 32));
      await handle.read(head, 0, head.length, 0);
      const after = await this.paths.resolve(bound);
      if (readBytes !== count || !after.exists || after.file !== bound.file || stamp(await handle.stat({ bigint: true })) !== stamp(stat)
        || stamp(await fs.stat(after.file, { bigint: true })) !== stamp(stat)) throw new ProjectFileError("changedDuringRead", "Document changed during reading; retry");
      const version = fileDigest(`${stamp(stat)}:${full ? fileDigest(buffer) : "large"}`);
      if (request.expectedVersion !== undefined && request.expectedVersion !== version) throw new ProjectFileError("conflict", "The document version changed; refresh before reading another page");
      const bom = head.subarray(0, 3).equals(BOM);
      let mediaType = fileMediaType(bound.path);
      if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mediaType = "image/png";
      else if (head.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) mediaType = "image/jpeg";
      else if (/^GIF8[79]a/.test(head.toString("ascii"))) mediaType = "image/gif";
      else if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") mediaType = "image/webp";
      else if (head.toString("ascii", 0, 5) === "%PDF-") mediaType = "application/pdf";
      let from = full ? offset : 0;
      let end = Math.min(buffer.length, from + length);
      // Byte pagination skips continuation bytes at the beginning and leaves an incomplete final character for the next page.
      if (start + from > 0) while (from < end && (buffer[from]! & 0xc0) === 0x80) from++;
      if (start + end < size) {
        let lead = end - 1;
        while (lead >= from && (buffer[lead]! & 0xc0) === 0x80) lead--;
        const byte = buffer[lead] ?? 0;
        const width = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xc2 && byte <= 0xdf ? 2 : 1;
        if (lead >= from && lead + width > end) end = lead;
      }
      const slice = buffer.subarray(from, end);
      const binary = buffer.includes(0) || mediaType.startsWith("image/") && mediaType !== "image/svg+xml";
      let content: string | null = null; let encoding: FileMetadata["encoding"] = binary ? "binary" : "utf8";
      if (!binary) {
        try {
          const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
          if (full) decoder.decode(buffer);
          content = decoder.decode(slice);
          if (start + from === 0 && bom) content = content.replace(/^\uFEFF/, "");
        }
        catch { encoding = "invalid"; }
      }
      const truncated = size > DOCUMENT_EDIT_BYTES || offset > 0 || start + end < size;
      if (encoding === "utf8" && mediaType === "application/octet-stream") mediaType = "text/plain";
      let writable = !truncated && encoding === "utf8" && !bound.symlink && Boolean(Number(stat.mode) & 0o222);
      if (writable) { try { await fs.access(bound.file, constants.W_OK); } catch { writable = false; } }
      return { kind: "document", projectRoot: bound.projectRoot, path: bound.path,
        status: encoding !== "utf8" ? "binary" : truncated ? "truncated" : size === 0 ? "empty" : "text", content, version,
        metadata: { size, readBytes: slice.length, mode: Number(stat.mode) & 0o7777, bom, lineEnding: content === null ? "none" : lineEnding(content), writable, encoding,
          offset: start + from, nextOffset: start + end < size ? start + end : undefined, mediaType },
        previewUrl: this.previews.url(bound.projectRoot, bound.path) };
    } finally { await handle.close(); }
  }

  async write(request: DocumentWriteRequest, assertActive: () => void = () => {}): Promise<FileDocument> {
    if (typeof request.content !== "string" || typeof request.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(request.expectedVersion)) throw new ProjectFileError("invalidRequest", "An expected document version is required");
    if (Buffer.byteLength(request.content) > DOCUMENT_EDIT_BYTES) throw new ProjectFileError("tooLarge", "Document exceeds the editing limit");
    // UTF-8 roundtrip rejects lone surrogates that would otherwise be silently saved as replacement characters.
    if (Buffer.from(request.content).toString("utf8") !== request.content || request.content.includes("\0")) throw new ProjectFileError("invalidEncoding", "Document must contain valid UTF-8 text");
    const readRequest = { projectRoot: request.projectRoot, path: request.path };
    const document = await this.read(readRequest);
    if (document.version !== request.expectedVersion) throw new ProjectFileError("conflict", "Document changed on disk; reload or resolve the conflict");
    if (document.metadata.size > DOCUMENT_EDIT_BYTES || document.status === "truncated") throw new ProjectFileError("tooLarge", "A partial document cannot be saved");
    if (!document.metadata.writable) throw new ProjectFileError("readOnly", "This document is read-only");
    const bound = await this.paths.resolve(request);
    const text = document.metadata.lineEnding === "crlf" ? request.content.replace(/\r\n|\n/g, "\r\n") : request.content;
    const bytes = Buffer.concat([document.metadata.bom ? BOM : Buffer.alloc(0), Buffer.from(text)]);
    if (bytes.length > DOCUMENT_EDIT_BYTES) throw new ProjectFileError("tooLarge", "Document exceeds the editing limit");
    assertActive();
    await writeFileAtomic(bound.file, bytes, { mode: document.metadata.mode, beforeCommit: async () => {
      assertActive();
      const current = await this.read(readRequest);
      const checked = await this.paths.resolve(request);
      if (checked.file !== bound.file || checked.symlink || current.version !== request.expectedVersion) throw new ProjectFileError("conflict", "Document changed before saving; no changes were written");
      if (!current.metadata.writable) throw new ProjectFileError("readOnly", "This document is read-only");
      assertActive();
    } });
    const saved = await this.read(readRequest);
    if (saved.content !== text) throw new ProjectFileError("conflict", "Document changed immediately after saving; your local text was retained");
    return saved;
  }
}
