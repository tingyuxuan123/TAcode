export const DOCUMENT_EDIT_BYTES = 4 * 1024 * 1024;

export type FileErrorCode = "invalidRequest" | "outsideProject" | "missing" | "notDirectory" | "notFile" | "changedDuringRead"
  | "staleCursor" | "conflict" | "readOnly" | "tooLarge" | "invalidEncoding" | "cancelled" | "failed";
export interface FileFailure { code: FileErrorCode; message: string }
export interface FileError { kind: "error"; error: FileFailure }
export interface ProjectPath { projectRoot: string; path: string }
export interface FileEntry { path: string; name: string; kind: "file" | "directory" | "symlink" }
export interface FilePage {
  kind: "ready";
  projectRoot: string;
  path: string;
  entries: readonly FileEntry[];
  total: number;
  version: string;
  cursor?: string;
}
export interface DirectoryRequest extends ProjectPath { limit?: number; cursor?: string; includeIgnored?: boolean; refresh?: boolean }
export interface FileSearchRequest extends DirectoryRequest { query: string }

export interface FileMetadata {
  size: number;
  readBytes: number;
  mode: number;
  bom: boolean;
  lineEnding: "lf" | "crlf" | "mixed" | "none";
  writable: boolean;
  encoding: "utf8" | "binary" | "invalid";
  offset: number;
  nextOffset?: number;
}
export interface FileDocument extends ProjectPath {
  kind: "document";
  status: "text" | "empty" | "missing" | "binary" | "truncated";
  content: string | null;
  version?: string;
  metadata: FileMetadata;
  previewUrl?: string;
}
export interface DocumentReadRequest extends ProjectPath { offset?: number; length?: number }
export interface DocumentWriteRequest extends ProjectPath { content: string; expectedVersion: string }
export type DocumentWriteResult = { kind: "saved"; document: FileDocument } | FileError;
export interface FileDraft extends ProjectPath {
  content: string;
  baseContent: string;
  baseVersion: string;
  lineEnding: FileMetadata["lineEnding"];
  updatedAt: number;
}
export type FileDraftWriteRequest = Omit<FileDraft, "updatedAt">;
export type FileDraftList = { kind: "drafts"; drafts: FileDraft[] } | FileError;
export type FileDraftResult = { kind: "checkpointed" } | FileError;
export interface FileSubscribeRequest extends ProjectPath { subscriptionId: string; target: "document" | "directory" }
export interface FileUpdate extends ProjectPath {
  subscriptionId: string;
  sequence: number;
  kind: "changed" | "error";
  paths?: readonly string[];
  error?: FileFailure;
  mode?: "native" | "polling";
}
export interface FilesApi {
  directory(request: DirectoryRequest): Promise<FilePage | FileError>;
  search(request: FileSearchRequest): Promise<FilePage | FileError>;
  readDocument(request: DocumentReadRequest): Promise<FileDocument | FileError>;
  writeDocument(request: DocumentWriteRequest): Promise<DocumentWriteResult>;
  readDrafts(request: ProjectPath): Promise<FileDraftList>;
  writeDraft(request: FileDraftWriteRequest): Promise<FileDraftResult>;
  removeDraft(request: ProjectPath): Promise<FileDraftResult>;
  previewUrl(request: ProjectPath): Promise<string | FileError>;
  subscribe(request: FileSubscribeRequest): Promise<{ mode: "native" | "polling" } | FileError>;
  unsubscribe(subscriptionId: string): Promise<void>;
  onUpdate(listener: (update: FileUpdate) => void): () => void;
}
