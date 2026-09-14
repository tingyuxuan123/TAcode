import { describe, expect, it } from "vitest";
import type { GitFileDiff, GitFileSide } from "../../shared/git";
import { createWorkbenchDiff } from "./diff-model";
import { gitSnapshotFiles, hasWorkbenchDiffSummary } from "./git-review-model";

const side = (state: GitFileSide["state"], content: string | null, mode = "100644"): GitFileSide => ({ state, content, mode, oid: null, size: content?.length ?? 0 });
const mapFile = (old: GitFileSide, next: GitFileSide, extra: Partial<GitFileDiff> = {}) => gitSnapshotFiles({ files: [{ id: "file", path: "src/example.ts", repositoryPath: "src/example.ts", patch: "", hunks: [], version: "sha-version", change: "modified", additions: 2, deletions: 1, old, new: next, binary: false, ...extra }] })[0];

describe("Git snapshot presentation", () => {
  it("keeps empty text distinct from missing and binary files", () => {
    const empty = mapFile(side("missing", null, "000000"), side("text", ""), { change: "untracked" });
    expect(empty.oldContent).toBeNull(); expect(empty.newContent).toBe("");
    expect(createWorkbenchDiff(empty).type).toBe("new");
    expect(hasWorkbenchDiffSummary(empty)).toBe(true);
    const binary = mapFile(side("binary", null), side("binary", null), { binary: true });
    expect(createWorkbenchDiff(binary)).toMatchObject({ name: "src/example.ts", isPartial: true, hunks: [], additionLines: [], deletionLines: [] });
    expect(hasWorkbenchDiffSummary(binary)).toBe(true);
  });

  it("never turns a missing large/conflicted side into a full-file addition or deletion", () => {
    for (const state of ["binary", "tooLarge", "conflict"] as const) {
      const file = mapFile(side("text", "old content\n"), side(state, null));
      expect(file.oldContent).toBeNull(); expect(file.newContent).toBeNull();
      expect(createWorkbenchDiff(file).hunks).toEqual([]);
      expect(file.additions).toBe(2); expect(file.deletions).toBe(1);
      expect(hasWorkbenchDiffSummary(file)).toBe(true);
    }
  });

  it("invalidates the view when the aggregate read budget omits an unchanged blob", () => {
    const loaded = mapFile(side("text", "old content\n"), side("text", "new content\n"));
    const omitted = mapFile(side("tooLarge", null), side("tooLarge", null));
    expect(loaded.version).toBe(omitted.version);
    expect(createWorkbenchDiff(loaded).cacheKey).not.toBe(createWorkbenchDiff(omitted).cacheKey);
  });

  it("uses full source for expandable context and preserves string versions in cache identity", () => {
    const text = Array.from({ length: 80 }, (_, index) => `const line${index} = ${index};\n`).join("");
    const file = mapFile(side("text", text), side("text", text.replace("line40 = 40", "line40 = 90")));
    const diff = createWorkbenchDiff(file);
    expect(diff.isPartial).toBe(false); expect(diff.additionLines).toHaveLength(80);
    expect(diff.cacheKey).not.toBe(createWorkbenchDiff({ ...file, version: "different-sha" }).cacheKey);
    expect(hasWorkbenchDiffSummary(file)).toBe(false);
  });

  it("displays link pointers as their own text and exposes permissions and pure renames", () => {
    const link = mapFile(side("symlink", "../old", "120000"), side("symlink", "../new", "120000"));
    expect(createWorkbenchDiff(link).hunks).not.toHaveLength(0);
    expect(hasWorkbenchDiffSummary(link)).toBe(true);
    const mode = mapFile(side("text", "ok\n"), side("text", "ok\n", "100755"));
    expect(hasWorkbenchDiffSummary(mode)).toBe(true);
    const renamed = mapFile(side("text", "ok\n"), side("text", "ok\n"), { change: "renamed", previousPath: "old.ts" });
    expect(hasWorkbenchDiffSummary(renamed)).toBe(true);
  });
});
