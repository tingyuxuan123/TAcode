import { parseDiffFromFile, type FileDiffMetadata } from "@pierre/diffs";
import type { WorkbenchDiffFile } from "./types";

export function createWorkbenchDiff(file: WorkbenchDiffFile): FileDiffMetadata {
  const oldFile = file.oldContent === null ? null : {
    name: file.previousPath ?? file.path, contents: file.oldContent, cacheKey: JSON.stringify([file.id, file.version, "old"]),
  };
  const newFile = file.newContent === null ? null : {
    name: file.path, contents: file.newContent, cacheKey: JSON.stringify([file.id, file.version, "new"]),
  };
  // Three lines initially; full input is retained for expanding omitted context.
  const diff = parseDiffFromFile(oldFile, newFile, { context: 3 }, true);
  // New/deleted files have only one side, so the library cannot derive its own key.
  diff.cacheKey = JSON.stringify([file.id, file.version]);
  return diff;
}
