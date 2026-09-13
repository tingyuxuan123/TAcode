import { describe, expect, it } from "vitest";
import { ancestorPaths, visibleTreeRows } from "./tree-model";
import type { WorkbenchTreeEntry } from "./types";

const entries: WorkbenchTreeEntry[] = [
  { path: "src/renderer/App.tsx", kind: "file", change: "modified" },
  { path: "src/shared/types.ts", kind: "file" },
  { path: ".agents/features.json", kind: "file" },
  { path: "README.md", kind: "file" },
];

describe("workbench tree navigation", () => {
  it("finds a nested file from the root before flattening directory levels", () => {
    const rows = visibleTreeRows(entries, new Set(), "APP.TSX");
    expect(rows.map((row) => row.path)).toEqual(["src", "src/renderer", "src/renderer/App.tsx"]);
    expect(rows[0]).toMatchObject({ depth: 0, expanded: true, descendantChanged: true });
    expect(rows[2]).toMatchObject({ depth: 2, parent: "src/renderer", change: "modified" });
  });

  it("retains dot directories and only expands the selected ancestors", () => {
    const expanded = new Set(ancestorPaths(".agents/features.json"));
    const rows = visibleTreeRows(entries, expanded);
    expect(rows.map((row) => row.path)).toEqual([".agents", ".agents/features.json", "src", "README.md"]);
  });

  it("matches a directory path without confusing similarly prefixed directories", () => {
    const rows = visibleTreeRows([
      { path: "src/app/a.ts", kind: "file" },
      { path: "src/application/b.ts", kind: "file" },
    ], new Set(["src", "src/app"]));
    expect(rows.map((row) => row.path)).toEqual(["src", "src/app", "src/app/a.ts", "src/application"]);
    expect(visibleTreeRows(entries, new Set(), "does-not-exist")).toEqual([]);
  });

  it("keeps every sibling available and preserves supplied directory metadata", () => {
    const many: WorkbenchTreeEntry[] = Array.from({ length: 250 }, (_, i) => ({ path: "src/file-" + i + ".ts", kind: "file" }));
    const rows = visibleTreeRows([{ path: "src", kind: "directory", change: "modified" }, ...many], new Set(["src"]));
    expect(rows).toHaveLength(251);
    expect(rows[0].change).toBe("modified");
    expect(rows.at(-1)?.path).toBe("src/file-249.ts");
  });
});
