import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileScope, projectFilePath, readFileTabs, readFileView, writeFileTabs, writeFileView } from "./file-view-state";
beforeEach(() => { const values = new Map<string, string>(); vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }); });
afterEach(() => vi.unstubAllGlobals());
describe("file entry points and stored views", () => {
  it("normalizes absolute/relative paths and line/column links, preserving literal colon filenames", () => {
    expect(projectFilePath("/project/src/../source.ts:123:8", "/project/", "darwin")).toEqual({ path: "source.ts", location: { line: 123, column: 8 } });
    expect(projectFilePath("./目录/a file.txt:12", "/project", "darwin", true)).toEqual({ path: "目录/a file.txt:12", location: undefined });
    expect(projectFilePath("C:\\Project\\src\\a.ts:3:2", "c:\\project", "win32")).toEqual({ path: "src/a.ts", location: { line: 3, column: 2 } });
    expect(projectFilePath("a\\b.txt", "/project", "darwin", true).path).toBe("a\\b.txt");
    expect(projectFilePath("/project/a:1", "/project", "darwin", true).path).toBe("a:1");
    expect(() => projectFilePath("C:relative.txt", "C:/project", "win32", true)).toThrow();
    for (const path of ["../outside", "/project2/a.ts", "/elsewhere/a", "C:/elsewhere/a", "", "a\0b"]) expect(() => projectFilePath(path, "/project", "darwin")).toThrow();
  });
  it("persists order, preview and reading positions separately for each project/session", () => {
    const a = fileScope("/a", "session-1"); const a2 = fileScope("/a", "session-2"); const b = fileScope("/b", "session-1");
    writeFileTabs(a, { tabs: [{ path: "second.txt", preview: false }, { path: "same.txt", preview: true }], activePath: "same.txt" });
    writeFileView(a, "same.txt", { treeWidth: 400, treeScroll: 2800, expanded: ["src"], query: "same", position: { top: 2200, left: 30, from: 20, to: 24 } });
    expect(readFileTabs(a).tabs.map((tab) => tab.path)).toEqual(["second.txt", "same.txt"]); expect(readFileView(a, "same.txt").position?.top).toBe(2200);
    for (const scope of [a2, b]) { expect(readFileTabs(scope)).toEqual({ tabs: [] }); expect(readFileView(scope, "same.txt")).toEqual({}); }
  });
  it("bounds corrupt storage, excludes duplicate/extra previews and tolerates unavailable storage", () => {
    const scope = fileScope("/a");
    writeFileTabs(scope, { tabs: [{ path: "a", preview: true }, { path: "a", preview: false }, { path: "b", preview: true }, { path: "c", preview: false }], activePath: "b" });
    expect(readFileTabs(scope)).toEqual({ tabs: [{ path: "a", preview: true }, { path: "c", preview: false }], activePath: undefined });
    writeFileView(scope, "a", { treeWidth: -1, treeScroll: Infinity, position: { top: 0, left: 0, from: -1, to: 0 } }); expect(readFileView(scope, "a")).toEqual({});
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("disabled"); }, setItem: () => { throw new Error("full"); } });
    expect(readFileTabs(scope)).toEqual({ tabs: [] }); expect(() => writeFileView(scope, "a", {})).not.toThrow();
  });
});
