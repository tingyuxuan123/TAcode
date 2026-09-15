import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyFileMutationToStorage, fileScope, projectFilePath, readFileTabs, readFileView, writeFileTabs, writeFileView } from "./file-view-state";
beforeEach(() => { const values = new Map<string, string>(); vi.stubGlobal("localStorage", { get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null,
  removeItem: (key: string) => values.delete(key), getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) }); });
afterEach(() => vi.unstubAllGlobals());
describe("file entry points and stored views", () => {
  it("persists separate preview/source/chunk positions and rejects corrupt or unbounded preview state", () => {
    const scope = fileScope("/formats", "one");
    const position = { top: 1200, left: 10, from: 30, to: 40 };
    writeFileView(scope, "source", { viewMode: "preview", previewPosition: { top: 800, left: 0 }, imageZoom: 1.5, pageOffset: 262144, pagePositions: { 262144: position }, position });
    expect(readFileView(scope, "source")).toMatchObject({ viewMode: "preview", previewPosition: { top: 800 }, pageOffset: 262144, pagePositions: { 262144: position }, position });
    writeFileView(scope, "corrupt", { previewPosition: { top: -1, left: 0 }, imageZoom: 5, pageOffset: Infinity, pagePositions: { bad: position, 12: { ...position, from: -1 } } });
    expect(readFileView(scope, "corrupt")).toEqual({ pagePositions: {} });
  });
  it("continues migrating valid sessions after malformed storage keys", () => {
    for (const suffix of ["broken", "null", "{}"])
      localStorage.setItem(`tacode:file-tabs:v1:${suffix}`, "{}");
    for (const suffix of ["broken", "null", '[null,2]', JSON.stringify([fileScope("/corrupt-migration"), 2])])
      localStorage.setItem(`tacode:file-view:v1:${suffix}`, "{}");
    const scope = fileScope("/corrupt-migration", "valid-session");
    writeFileTabs(scope, { tabs: [{ path: "old/source", preview: false }], activePath: "old/source" });
    writeFileView(scope, "old/source", { position: { top: 1234, left: 0, from: 12, to: 18 }, expanded: ["old/nested"] });
    applyFileMutationToStorage({ kind: "mutation", projectRoot: "/corrupt-migration", path: "old", destination: "new", operation: "rename" });
    expect(readFileTabs(scope)).toEqual({ tabs: [{ path: "new/source", preview: false }], activePath: "new/source" });
    expect(readFileView(scope, "new/source")).toMatchObject({ position: { top: 1234 }, expanded: ["new/nested"] });
    expect(readFileView(scope, "old/source")).toEqual({});
  });
  it("retargets all session tabs and reading state, redirects late cleanup, and isolates another project", () => {
    const root = "/migration"; const first = fileScope(root, "first"); const second = fileScope(root, "second"); const foreign = fileScope("/other-migration", "first");
    for (const scope of [first, second, foreign]) {
      writeFileTabs(scope, { tabs: [{ path: "old/source", preview: false }, { path: "oldish/source", preview: true }], activePath: "old/source" });
      writeFileView(scope, "old/source", { treeWidth: 400, expanded: ["old", "old/nested", "oldish"], position: { top: 1200, left: 0, from: 30, to: 40 } });
    }
    applyFileMutationToStorage({ kind: "mutation", projectRoot: root, path: "old", destination: "new", operation: "rename" });
    for (const scope of [first, second]) {
      expect(readFileTabs(scope).activePath).toBe("new/source"); expect(readFileTabs(scope).tabs.map((tab) => tab.path)).toEqual(["new/source", "oldish/source"]);
      expect(readFileView(scope, "new/source")).toMatchObject({ expanded: ["new", "new/nested", "oldish"], position: { top: 1200 } });
      expect(readFileView(scope, "old/source")).toEqual({});
    }
    writeFileView(first, "old/source", { position: { top: 1250, left: 0, from: 30, to: 40 }, expanded: ["old"] });
    expect(readFileView(first, "new/source")).toMatchObject({ position: { top: 1250 }, expanded: ["new"] });
    applyFileMutationToStorage({ kind: "mutation", projectRoot: root, path: "new", operation: "trash" });
    writeFileView(first, "new/source", { treeWidth: 500 });
    for (const scope of [first, second]) { expect(readFileTabs(scope).tabs.map((tab) => tab.path)).toEqual(["oldish/source"]); expect(readFileView(scope, "new/source")).toEqual({}); }
    expect(readFileTabs(foreign).activePath).toBe("old/source"); expect(readFileView(foreign, "old/source").position?.top).toBe(1200);
  });
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
