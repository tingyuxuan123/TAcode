import path from "node:path";
import { workspacePreviewUrl } from "../../shared/preview";
import { fileDigest } from "./file-page";
import { randomUUID } from "node:crypto";
import { DOCUMENT_EDIT_BYTES, type FileHtmlRequest, type FileHtmlPreview } from "../../shared/files";
import { ProjectFileError, relativeFilePath } from "./file-path";

export const projectPreviewHost = (root: string): string => `workspace-${fileDigest(path.resolve(root)).slice(0, 32)}`;
export const projectPreviewUrl = (root: string, relative: string): string => workspacePreviewUrl(relativeFilePath(relative), projectPreviewHost(root));

export class ProjectPreviewRegistry {
  private readonly roots = new Map<string, string>();
  private readonly snapshots = new Map<string, FileHtmlRequest & { owner: number; size: number }>();
  renderHtml(owner: number, request: FileHtmlRequest): FileHtmlPreview {
    const size = Buffer.byteLength(request.html);
    if (size > DOCUMENT_EDIT_BYTES + 8192 || this.snapshots.size >= 16 || [...this.snapshots.values()].reduce((sum, entry) => sum + entry.size, size) > 64 * 1024 * 1024)
      throw new ProjectFileError("tooLarge", "The HTML preview memory limit was reached");
    if (Buffer.from(request.html).toString("utf8") !== request.html || request.html.includes("\0")) throw new ProjectFileError("invalidEncoding", "The preview must contain valid UTF-8 text");
    const id = randomUUID(); this.snapshots.set(id, { ...request, owner, size });
    return { kind: "htmlPreview", id, url: `${this.url(request.projectRoot, request.path)}?tacode-html-preview=${id}` };
  }
  htmlSource(host: string, path: string, id: string): string {
    const entry = this.snapshots.get(id);
    if (!entry || projectPreviewHost(entry.projectRoot) !== host || entry.path !== path) throw new ProjectFileError("outsideProject", "The HTML preview is unavailable");
    return entry.html;
  }
  releaseHtml(owner: number, id?: string): void {
    for (const [key, entry] of this.snapshots) if (entry.owner === owner && (id === undefined || key === id)) this.snapshots.delete(key);
  }
  stats(): { htmlSnapshots: number; htmlBytes: number } { return { htmlSnapshots: this.snapshots.size, htmlBytes: [...this.snapshots.values()].reduce((sum, entry) => sum + entry.size, 0) }; }
  url(root: string, relative: string): string { this.roots.set(projectPreviewHost(root), path.resolve(root)); return projectPreviewUrl(root, relative); }
  root(host: string): string {
    const root = this.roots.get(host);
    if (!root) throw new ProjectFileError("outsideProject", "The preview project is unavailable");
    return root;
  }
  release(root: string): void { this.roots.delete(projectPreviewHost(root)); for (const [id, entry] of this.snapshots) if (entry.projectRoot === root) this.snapshots.delete(id); }
  clear(): void { this.roots.clear(); this.snapshots.clear(); }
}
