import path from "node:path";
import { workspacePreviewUrl } from "../../shared/preview";
import { fileDigest } from "./file-page";
import { ProjectFileError, relativeFilePath } from "./file-path";

export const projectPreviewHost = (root: string): string => `workspace-${fileDigest(path.resolve(root)).slice(0, 32)}`;
export const projectPreviewUrl = (root: string, relative: string): string => workspacePreviewUrl(relativeFilePath(relative), projectPreviewHost(root));

export class ProjectPreviewRegistry {
  private readonly roots = new Map<string, string>();
  url(root: string, relative: string): string { this.roots.set(projectPreviewHost(root), path.resolve(root)); return projectPreviewUrl(root, relative); }
  root(host: string): string {
    const root = this.roots.get(host);
    if (!root) throw new ProjectFileError("outsideProject", "The preview project is unavailable");
    return root;
  }
  release(root: string): void { this.roots.delete(projectPreviewHost(root)); }
  clear(): void { this.roots.clear(); }
}
