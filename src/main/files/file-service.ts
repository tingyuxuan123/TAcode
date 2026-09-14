import type { DirectoryRequest, DocumentReadRequest, DocumentWriteRequest, FileSearchRequest, ProjectPath } from "../../shared/files";
import { WorkspaceFileIndex } from "../workspace-file-index";
import { FileDirectories } from "./file-directory";
import { FileDocuments } from "./file-document";
import { ProjectFileError, ProjectFilePaths } from "./file-path";
import { ProjectPreviewRegistry } from "./preview-registry";
import { FileSubscriptions, type FileSubscriptionOptions } from "./file-subscriptions";

export interface FileServiceOptions {
  resolveProject(root: string): Promise<string>;
  index?: WorkspaceFileIndex;
  previews?: ProjectPreviewRegistry;
  watchProject?(root: string): void;
  changed?(root: string, paths?: string[]): void;
  watch?: FileSubscriptionOptions["watch"];
  pollMs?: number;
}
export class FileService {
  readonly paths: ProjectFilePaths;
  readonly previews: ProjectPreviewRegistry;
  readonly subscriptions: FileSubscriptions;
  private readonly directories: FileDirectories;
  private readonly documents: FileDocuments;
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
    const pending = this.bound(request, false, () => this.documents.write(request, assertActive)).then((document) => {
      this.options.changed?.(document.projectRoot, [document.path]); this.changed(document.projectRoot);
      return { kind: "saved" as const, document };
    });
    this.writes.add(pending); void pending.catch(() => {}).finally(() => this.writes.delete(pending)); return pending;
  }
  previewUrl(request: ProjectPath) { return this.bound(request, false, async () => {
    const bound = await this.paths.resolve(request); return this.previews.url(bound.projectRoot, bound.path);
  }); }
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
