import type { GitFileDiff } from "../../shared/git";

export type WorkbenchChange = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflict";

export interface WorkbenchTreeEntry {
  /** Workspace-relative path, with "/" separators and no trailing slash. */
  path: string;
  kind: "file" | "directory";
  change?: WorkbenchChange;
}

export type ReviewScope = "unstaged" | "staged" | "commit" | "branch" | "lastTurn";

export interface WorkbenchDiffFile {
  id: string;
  path: string;
  previousPath?: string;
  oldContent: string | null;
  newContent: string | null;
  change: WorkbenchChange;
  additions: number;
  deletions: number;
  /** Changes whenever either side of this immutable comparison changes. */
  version: number | string;
  /** Non-text state stays separate from displayed source; never placeholder code. */
  metadata?: Pick<GitFileDiff, "old" | "new" | "conflictStages">;
}

export interface SourceLocation {
  line: number;
  column?: number;
  endLine?: number;
}

export type WorkbenchColorScheme = "light" | "dark";
