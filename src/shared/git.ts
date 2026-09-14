/** Local Git contracts. Every path is relative to the explicitly bound project. */
export type GitComparison =
  | { kind: "unstaged" }
  | { kind: "staged" }
  | { kind: "commit"; commit: string }
  | { kind: "branch"; base: string };

export interface GitRepositoryInfo {
  id: string;
  projectRoot: string;
  root: string;
  pathPrefix: string;
  gitDir: string;
  commonDir: string;
  objectFormat: "sha1" | "sha256";
  head: string | null;
  branch: string | null;
  upstream: string | null;
  unborn: boolean;
}

export type GitRepositoryState =
  | { kind: "repository"; repository: GitRepositoryInfo }
  | { kind: "notRepository"; projectRoot: string }
  | { kind: "missingGit"; projectRoot: string };

export interface GitBranch {
  ref: string;
  name: string;
  oid: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
}

export type GitChange = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflict";
export type GitContentState = "text" | "missing" | "binary" | "symlink" | "submodule" | "tooLarge" | "conflict";

export interface GitFileSide {
  oid: string | null;
  mode: string;
  size: number;
  state: GitContentState;
  /** null means missing/non-text/omitted; an empty text file is the empty string. */
  content: string | null;
}

export interface GitDiffHunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  heading: string;
  patch: string;
}

export interface GitFileDiff {
  id: string;
  version: string;
  path: string;
  previousPath?: string;
  /** Kept by the backend for exact literal pathspec operations. */
  repositoryPath: string;
  previousRepositoryPath?: string;
  change: GitChange;
  old: GitFileSide;
  new: GitFileSide;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  hunks: readonly GitDiffHunk[];
  /** Raw on-disk fingerprint; Git's normalized review text can differ (CRLF). */
  worktreeVersion?: string;
  conflictStages?: readonly { stage: number; oid: string; mode: string }[];
}

export interface GitSnapshot {
  id: string;
  repository: GitRepositoryInfo;
  comparison: GitComparison;
  baseCommit: string | null;
  targetCommit: string | null;
  capturedAt: number;
  readOnly: boolean;
  indexVersion: string;
  files: readonly GitFileDiff[];
  additions: number;
  deletions: number;
  binaryFiles: number;
}

export type GitErrorCode = "missingGit" | "notRepository" | "invalidReference" | "noCommits" | "noMergeBase"
  | "outsideProject" | "invalidPath" | "invalidRequest" | "changedDuringRead" | "cancelled" | "timedOut" | "outputLimit" | "invalidOutput" | "failed";

/** Repository-only queries let the user choose a branch before reading a diff. */
export type GitReviewQuery = GitComparison | { kind: "repository" };
export interface GitFailure { code: GitErrorCode; message: string; details?: string }
export type GitReviewResult =
  | { kind: "ready"; snapshot: GitSnapshot; branches: readonly GitBranch[] }
  | { kind: "repository"; repository: GitRepositoryInfo; branches: readonly GitBranch[] }
  | Exclude<GitRepositoryState, { kind: "repository" }>
  | { kind: "error"; error: GitFailure };
export type GitWatchMode = "native" | "polling";
export interface GitSubscribeRequest {
  /** Chosen before invoking IPC so an in-flight subscription can be cancelled. */
  subscriptionId: string;
  projectRoot: string;
  query: GitReviewQuery;
}
export interface GitReviewUpdate extends GitSubscribeRequest {
  sequence: number;
  loading: boolean;
  /** Loading events omit large payloads; the previous immutable result remains visible. */
  result?: GitReviewResult;
  watchMode: GitWatchMode;
}
export interface GitApi {
  subscribe(request: GitSubscribeRequest): Promise<void>;
  unsubscribe(subscriptionId: string): Promise<void>;
  refresh(subscriptionId: string): Promise<void>;
  onUpdate(listener: (update: GitReviewUpdate) => void): () => void;
}

export function gitReviewQueryKey(query: GitReviewQuery): string {
  return JSON.stringify(query.kind === "commit" ? [query.kind, query.commit] : query.kind === "branch" ? [query.kind, query.base] : [query.kind]);
}
