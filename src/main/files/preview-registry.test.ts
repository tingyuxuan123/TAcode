import { describe, expect, it } from "vitest";
import { ProjectPreviewRegistry } from "./preview-registry";
import { DOCUMENT_EDIT_BYTES } from "../../shared/files";
describe("project HTML snapshots", () => {
  it("binds accurate HTML to a project/path and owner, without replacing ordinary resource URLs", () => {
    const registry = new ProjectPreviewRegistry(); const request = { projectRoot: "/project-a", path: "nested/same.html", html: "<h1>unsaved</h1>" };
    const preview = registry.renderHtml(1, request); const url = new URL(preview.url);
    expect(registry.htmlSource(url.host, request.path, preview.id)).toBe(request.html);
    expect(registry.url(request.projectRoot, request.path)).not.toContain(preview.id);
    const other = registry.url("/project-b", request.path);
    expect(() => registry.htmlSource(new URL(other).host, request.path, preview.id)).toThrow();
    expect(() => registry.htmlSource(url.host, "elsewhere.html", preview.id)).toThrow();
    registry.releaseHtml(2, preview.id); expect(registry.stats().htmlSnapshots).toBe(1);
    registry.releaseHtml(1, preview.id); expect(registry.stats()).toEqual({ htmlSnapshots: 0, htmlBytes: 0 });
    expect(() => registry.htmlSource(url.host, request.path, preview.id)).toThrow();
  });
  it("bounds memory without evicting existing snapshots, and clears all owner/project snapshots", () => {
    const registry = new ProjectPreviewRegistry(); const request = { projectRoot: "/project", path: "index.html", html: "content" };
    for (let index = 0; index < 16; index++) registry.renderHtml(index < 8 ? 1 : 2, request);
    expect(() => registry.renderHtml(3, request)).toThrow(); expect(registry.stats().htmlSnapshots).toBe(16);
    registry.releaseHtml(1); expect(registry.stats().htmlSnapshots).toBe(8);
    registry.release(request.projectRoot); expect(registry.stats().htmlSnapshots).toBe(0);
    expect(() => registry.renderHtml(1, { ...request, html: "a".repeat(DOCUMENT_EDIT_BYTES + 8193) })).toThrow();
    expect(() => registry.renderHtml(1, { ...request, html: "\ud800" })).toThrow();
    registry.renderHtml(1, request); registry.clear(); expect(registry.stats()).toEqual({ htmlSnapshots: 0, htmlBytes: 0 });
  });
});
