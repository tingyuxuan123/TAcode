import type { GitFileSide, GitSnapshot } from "../../shared/git";
import type { WorkbenchDiffFile } from "./types";

const textual = (side: GitFileSide) => side.state === "missing" || (["text", "symlink", "submodule"].includes(side.state) && side.content !== null);
/** Keep Git state adaptation lightweight; the diff engine is loaded only when visible. */
export function gitSnapshotFiles(snapshot: Pick<GitSnapshot, "files">): WorkbenchDiffFile[] {
  return snapshot.files.map((file) => {
    const text = !file.binary && textual(file.old) && textual(file.new);
    return { id: file.id, version: file.version, path: file.path, previousPath: file.previousPath,
      oldContent: text ? file.old.content : null, newContent: text ? file.new.content : null,
      change: file.change, additions: file.additions, deletions: file.deletions,
      hunks: !file.binary && file.change !== "conflict" && [file.old.state, file.new.state].every((state) => state === "missing" || state === "text") ? file.hunks : undefined,
      metadata: { old: file.old, new: file.new, conflictStages: file.conflictStages } };
  });
}

export function hasWorkbenchDiffSummary(file: WorkbenchDiffFile): boolean {
  const data = file.metadata;
  return Boolean(data && (file.change === "conflict" || [data.old, data.new].some((side) => side.state !== "text" && side.state !== "missing")
    || (data.old.mode !== data.new.mode && data.old.state !== "missing" && data.new.state !== "missing")
    || ((!file.oldContent && !file.newContent) || (file.change === "renamed" && file.oldContent === file.newContent))));
}
