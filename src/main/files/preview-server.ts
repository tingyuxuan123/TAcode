import { net } from "electron";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ProjectFilePaths } from "./file-path";
import type { ProjectPreviewRegistry } from "./preview-registry";

export async function serveProjectPreview(request: Request, paths: ProjectFilePaths, registry: ProjectPreviewRegistry): Promise<Response> {
  try {
    const url = new URL(request.url);
    const root = registry.root(url.host);
    const name = decodeURIComponent(url.pathname).replace(/^\//, "");
    const bound = await paths.resolve({ projectRoot: root, path: name });
    if (!bound.exists || !(await fs.stat(bound.file)).isFile()) return new Response("Not found", { status: 404 });
    return await net.fetch(pathToFileURL(bound.file).toString());
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "Forbidden", { status: error instanceof URIError ? 400 : 403 });
  }
}
