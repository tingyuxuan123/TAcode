import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspacePreviewUrl } from "../../shared/preview";
import { resolveWorkspacePreview } from "./preview-target";

let root = "";
let outside = "";
/** macOS 的 /var 与 /private/var 是同一目录，比较真实路径。 */
const real = (target: string): string => realpathSync(target);

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "tacode-preview-root-"));
  outside = mkdtempSync(path.join(os.tmpdir(), "tacode-preview-outside-"));
  mkdirSync(path.join(root, "demo"));
  writeFileSync(path.join(root, "demo", "index.html"), "<!doctype html><title>demo</title>");
  writeFileSync(path.join(root, "pelican.html"), "<!doctype html><title>pelican</title>");
  writeFileSync(path.join(outside, "secret.html"), "<!doctype html><title>secret</title>");
  symlinkSync(path.join(outside, "secret.html"), path.join(root, "link.html"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("workspace preview target", () => {
  it("resolves project-relative files given as an explicit path", () => {
    expect(resolveWorkspacePreview("demo/index.html", root, { explicit: true })).toEqual({
      file: real(path.join(root, "demo", "index.html")),
      url: workspacePreviewUrl("demo/index.html"),
    });
  });

  it("resolves absolute and file:// inputs inside the workspace", () => {
    const absolute = resolveWorkspacePreview(path.join(root, "pelican.html"), root);
    expect(absolute?.url).toBe(workspacePreviewUrl("pelican.html"));
    expect(resolveWorkspacePreview(`file://${path.join(root, "pelican.html")}`, root)?.file).toBe(real(path.join(root, "pelican.html")));
  });

  it("keeps plain urls on the url path unless they name an existing file", () => {
    // 形如域名的输入不按文件解析，继续走 URL/搜索逻辑。
    expect(resolveWorkspacePreview("localhost:5177/demo", root)).toBeUndefined();
    expect(resolveWorkspacePreview("https://example.com/demo/index.html", root)).toBeUndefined();
    // 相对路径 + 已存在文件才会命中，避免把普通搜索词当文件。
    expect(resolveWorkspacePreview("pelican.html", root)?.file).toBe(real(path.join(root, "pelican.html")));
    expect(resolveWorkspacePreview("missing.html", root)).toBeUndefined();
  });

  it("rejects paths outside the workspace, directories and symlink escapes", () => {
    expect(resolveWorkspacePreview(path.join(outside, "secret.html"), root)).toBeUndefined();
    expect(resolveWorkspacePreview("../secret.html", root, { explicit: true })).toBeUndefined();
    expect(resolveWorkspacePreview("demo", root, { explicit: true })).toBeUndefined();
    expect(resolveWorkspacePreview("link.html", root)).toBeUndefined();
  });

  it("returns nothing without a workspace root or a usable input", () => {
    expect(resolveWorkspacePreview("demo/index.html", undefined, { explicit: true })).toBeUndefined();
    expect(resolveWorkspacePreview("   ", root, { explicit: true })).toBeUndefined();
    expect(resolveWorkspacePreview(undefined, root, { explicit: true })).toBeUndefined();
  });
});
