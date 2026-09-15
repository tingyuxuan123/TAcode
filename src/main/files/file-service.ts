import type { DirectoryRequest, DocumentReadRequest, DocumentWriteRequest, FileSearchRequest, FileMutationRequest, FileOpenRequest, FileMutation, FileHtmlRequest, ProjectPath } from "../../shared/files";
import { WorkspaceFileIndex } from "../workspace-file-index";
import { FileDirectories } from "./file-directory";
import { FileDocuments } from "./file-document";
import { ProjectFileError, ProjectFilePaths } from "./file-path";
import { ProjectPreviewRegistry } from "./preview-registry";
import { FileSubscriptions, type FileSubscriptionOptions } from "./file-subscriptions";
import { FileManagement, type FileManagementOptions } from "./file-management";
import { FileExternal, type FileExternalOptions } from "./file-external";

export interface FileServiceOptions extends FileManagementOptions, FileExternalOptions {
  resolveProject(root: string): Promise<string>;
  index?: WorkspaceFileIndex;
  previews?: ProjectPreviewRegistry;
  watchProject?(root: string): void;
  changed?(root: string, paths?: string[]): void;
  watch?: FileSubscriptionOptions["watch"];
  pollMs?: number;
  mutation?(mutation: FileMutation): void;
}
export class FileService {
  readonly paths: ProjectFilePaths;
  readonly previews: ProjectPreviewRegistry;
  readonly subscriptions: FileSubscriptions;
  private readonly directories: FileDirectories;
  private readonly documents: FileDocuments;
  private readonly management: FileManagement;
  private readonly external: FileExternal;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly writes = new Set<Promise<unknown>>();
  private readonly requests = new Set<Promise<unknown>>();
  private readonly index: WorkspaceFileIndex;
  private closed = false;
  constructor(private readonly options: FileServiceOptions) {
    this.paths = new ProjectFilePaths(options.resolveProject);
    this.previews = options.previews ?? new ProjectPreviewRegistry();
    const index = this.index = options.index ?? new WorkspaceFileIndex();
    this.directories = new FileDirectories(this.paths, index);
    this.documents = new FileDocuments(this.paths, this.previews);
    this.management = new FileManagement(this.paths, options);
    this.external = new FileExternal(this.paths, options);
    this.subscriptions = new FileSubscriptions({ paths: this.paths, watch: options.watch, pollMs: options.pollMs, changed: (root, paths) => {
      if (paths) for (const file of paths) index.changed(root, file); else index.changed(root);
      this.changed(root); options.changed?.(root, paths);
    } });
  }
  changed(root: string): void { this.directories.changed(root); }
  directory(request: DirectoryRequest) { return this.bound(request, true, () => this.directories.directory(request)); }
  search(request: FileSearchRequest) { return this.bound(request, true, () => this.directories.search(request)); }
  readDocument(request: DocumentReadRequest) { return this.bound(request, false, () => this.documents.read(request)); }
  writeDocument(request: DocumentWriteRequest, assertOwner: () => void = () => {}) {
    const assertActive = () => { this.assertActive(); assertOwner(); };
    return this.queueWrite(() => this.bound(request, false, () => this.documents.write(request, assertActive)).then((document) => {
      this.options.changed?.(document.projectRoot, [document.path]); this.changed(document.projectRoot);
      return { kind: "saved" as const, document };
    }));
  }
  private queueWrite<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.writeQueue.then(work, work); this.writeQueue = pending.catch(() => {});
    this.writes.add(pending); void pending.catch(() => {}).finally(() => this.writes.delete(pending)); return pending;
  }
  inspect(request: ProjectPath) { return this.bound({ ...request, path: "" }, true, () => this.management.inspect(request)); }
  location(request: ProjectPath) { return this.bound({ ...request, path: "" }, true, () => this.management.location(request)); }
  mutate(request: FileMutationRequest, owner: () => void = () => {}) {
    return this.queueWrite(() => this.bound({ ...request, path: "" }, true, async () => {
      const result = await this.management.mutate(request, () => { this.assertActive(); owner(); });
      for (const file of [result.path, result.destination].filter((value): value is string => value !== undefined)) this.index.changed(result.projectRoot, file);
      this.changed(result.projectRoot); this.options.changed?.(result.projectRoot, [result.path, ...(result.destination ? [result.destination] : [])]);
      this.options.mutation?.(result); return result;
    }));
  }
  editors() { this.assertActive(); return this.external.editors(); }
  open(request: FileOpenRequest, owner: () => void = () => {}) { return this.bound(request, true, async () => { await this.external.open(request, () => { this.assertActive(); owner(); }); return { kind: "opened" as const }; }); }
  reveal(request: ProjectPath, owner: () => void = () => {}) { return this.bound({ ...request, path: "" }, true, async () => { await this.external.reveal(request, () => { this.assertActive(); owner(); }); return { kind: "opened" as const }; }); }
  previewUrl(request: ProjectPath) { return this.bound(request, false, async () => {
    const bound = await this.paths.resolve(request); return this.previews.url(bound.projectRoot, bound.path);
  }); }
  renderHtml(request: FileHtmlRequest, owner: number, active: () => void) {
    return this.bound(request, false, async () => { active(); return this.previews.renderHtml(owner, request); });
  }
  clear(): void { this.directories.clear(); this.previews.clear(); if (!this.options.index) this.index.clear(); }
  close(): void { this.closed = true; this.subscriptions.close(); this.clear(); }
  async idle(): Promise<void> { await Promise.allSettled([...this.writes, ...this.requests, this.subscriptions.idle()]); }
  private assertActive(): void { if (this.closed) throw new ProjectFileError("cancelled", "File service is closed"); }
  private bound<T>(request: ProjectPath, allowRoot: boolean, work: () => Promise<T>): Promise<T> {
    const pending = (async () => {
      this.assertActive(); const bound = await this.paths.resolve(request, allowRoot); this.assertActive();
      this.options.watchProject?.(bound.projectRoot);
      const result = await work();
      if (this.closed) { this.clear(); this.assertActive(); }
      return result;
    })();
    this.requests.add(pending);
    void pending.catch(() => {}).finally(() => this.requests.delete(pending));
    return pending;
  }
}
