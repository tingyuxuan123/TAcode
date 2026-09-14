export const DOCUMENT_EDIT_BYTES = 4 * 1024 * 1024;

export type FileErrorCode = "invalidRequest" | "outsideProject" | "missing" | "notDirectory" | "notFile" | "changedDuringRead"
  | "staleCursor" | "conflict" | "readOnly" | "tooLarge" | "invalidEncoding" | "cancelled" | "exists" | "unavailable" | "failed";
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
export interface FileTarget extends ProjectPath { kind: "target"; version: string; entryKind: FileEntry["kind"] }
export interface FileMutation extends ProjectPath { kind: "mutation"; operation: "createFile" | "createDirectory" | "rename" | "trash"; destination?: string }
export const pathWithin = (value: string, parent: string): boolean => !parent || value === parent || value.startsWith(`${parent}/`);
export function mutatedPath(value: string, mutation: FileMutation): string | undefined {
  if (!pathWithin(value, mutation.path)) return value;
  if (mutation.operation === "trash") return undefined;
  return mutation.operation === "rename" && mutation.destination ? mutation.destination + value.slice(mutation.path.length) : value;
}
export interface FileMutationRequest extends ProjectPath { operation: FileMutation["operation"]; expectedVersion?: string; destination?: string }
export type ExternalEditor = "system" | "vscode" | "cursor";
export interface FileOpenRequest extends ProjectPath { editor: ExternalEditor; line?: number; column?: number }
export interface FileLocation extends ProjectPath { kind: "location"; absolutePath: string }
export type FileActionResult = { kind: "opened" } | FileError;
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
  inspect(request: ProjectPath): Promise<FileTarget | FileError>;
  mutate(request: FileMutationRequest): Promise<FileMutation | FileError>;
  location(request: ProjectPath): Promise<FileLocation | FileError>;
  editors(): Promise<{ kind: "editors"; editors: ExternalEditor[] } | FileError>;
  open(request: FileOpenRequest): Promise<FileActionResult>;
  reveal(request: ProjectPath): Promise<FileActionResult>;
  onMutation(listener: (mutation: FileMutation) => void): () => void;
  previewUrl(request: ProjectPath): Promise<string | FileError>;
  subscribe(request: FileSubscribeRequest): Promise<{ mode: "native" | "polling" } | FileError>;
  unsubscribe(subscriptionId: string): Promise<void>;
  onUpdate(listener: (update: FileUpdate) => void): () => void;
}
