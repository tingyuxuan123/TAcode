import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import type { WorkbenchDiffFile } from "./types";

export function workbenchDiffCacheKey(file: WorkbenchDiffFile): string {
  // A snapshot's aggregate byte budget can omit a previously loaded blob even
  // when its Git object/version is unchanged. Availability is part of the view.
  return JSON.stringify([file.id, file.version, file.metadata?.old.state, file.metadata?.new.state]);
}

export function createWorkbenchDiff(file: WorkbenchDiffFile): FileDiffMetadata {
  const cacheKey = workbenchDiffCacheKey(file);
  if (file.oldContent === null && file.newContent === null) {
    // A metadata-only item has no code lines. Its explicit state is rendered as
    // a file-level annotation; binary/omitted/conflicted data is never an empty file.
    return { name: file.path, prevName: file.previousPath, lang: "text", type: file.change === "deleted" ? "deleted"
      : file.change === "added" || file.change === "untracked" ? "new" : file.change === "renamed" ? "rename-changed" : "change",
      hunks: [], splitLineCount: 0, unifiedLineCount: 0, isPartial: true, deletionLines: [], additionLines: [],
      mode: file.metadata?.new.mode, prevMode: file.metadata?.old.mode, cacheKey };
  }
  const oldFile = file.oldContent === null ? null : {
    name: file.previousPath ?? file.path, contents: file.oldContent, cacheKey: JSON.stringify([cacheKey, "old"]),
  };
  const newFile = file.newContent === null ? null : {
    name: file.path, contents: file.newContent, cacheKey: JSON.stringify([cacheKey, "new"]),
  };
  // Three lines initially; full input is retained for expanding omitted context.
  const diff = parseDiffFromFile(oldFile, newFile, { context: 3 }, true);
  // New/deleted files have only one side, so the library cannot derive its own key.
  diff.cacheKey = cacheKey;
  diff.mode = file.metadata?.new.mode;
  diff.prevMode = file.metadata?.old.mode;
  return diff;
}
