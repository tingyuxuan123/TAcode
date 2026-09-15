/** Local Git contracts. Every path is relative to the explicitly bound project. */
export type GitComparison =
  | { kind: "unstaged" }
  | { kind: "staged" }
  | { kind: "commit"; commit: string }
  | { kind: "branch"; base: string }
  | { kind: "turn"; snapshotId: string };

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
  | "outsideProject" | "invalidPath" | "invalidRequest" | "changedDuringRead" | "cancelled" | "timedOut" | "outputLimit" | "invalidOutput" | "failed"
  | "staleSnapshot" | "indexLocked" | "patchRejected" | "unsupportedChange" | "recoveryConflict" | "recoveryFailed"
  | "noStagedChanges" | "outsideStagedChanges" | "noUpstream" | "identityMissing" | "hookFailed" | "commitFailed" | "authFailed" | "pushRejected" | "pushFailed"
  | "noTurnSnapshot" | "turnObjectsMissing";

/** A tool call that was still running when the turn ended; its file writes land after the snapshot. */
export interface GitTurnCommand {
  tool: string;
  command: string;
  processId?: string;
  startedAt: number;
}
/** Immutable record of one agent turn: two workspace trees plus what the snapshot cannot cover. */
export interface GitTurnSnapshot {
  id: string;
  projectRoot: string;
  sessionPath: string | null;
  startedAt: number;
  settledAt: number;
  status: "completed" | "stopped";
  baseTree: string;
  targetTree: string;
  files: number;
  additions: number;
  deletions: number;
  baselineMs: number;
  targetMs: number;
  unfinished: readonly GitTurnCommand[];
  warnings: readonly string[];
}
/** Never substitutes live content for a history the snapshot could not record. */
export type GitTurnSnapshotState =
  | { kind: "turn"; snapshot: GitTurnSnapshot }
  | { kind: "capturing"; projectRoot: string; startedAt: number }
  | { kind: "missing"; projectRoot: string }
  | { kind: "expired"; snapshot: GitTurnSnapshot }
  | { kind: "failed"; projectRoot: string; reason: string }
  | { kind: "error"; error: GitFailure };

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
export interface GitTurnRequest { projectRoot: string }
/** Sent when a turn settles so a visible last-turn scope can pick the new snapshot up. */
export interface GitTurnUpdate { projectRoot: string; snapshot: GitTurnSnapshot }
export interface GitApi {
  subscribe(request: GitSubscribeRequest): Promise<void>;
  unsubscribe(subscriptionId: string): Promise<void>;
  refresh(subscriptionId: string): Promise<void>;
  onUpdate(listener: (update: GitReviewUpdate) => void): () => void;
  turnSnapshot(request: GitTurnRequest): Promise<GitTurnSnapshotState>;
  onTurnSnapshot(listener: (update: GitTurnUpdate) => void): () => void;
  prepareMutation(request: GitPrepareMutationRequest): Promise<GitMutationPreview | Extract<GitMutationResult, { kind: "error" }>>;
  applyMutation(token: string): Promise<GitMutationResult>;
  cancelMutation(token: string): Promise<void>;
  listRecoveries(projectRoot: string): Promise<GitRecoveryPoint[]>;
  restoreRecovery(projectRoot: string, recoveryId: string): Promise<GitMutationResult>;
  getCommitInfo(request: GitCommitInfoRequest): Promise<GitCommitInfoResult>;
  prepareCommit(request: GitPrepareCommitRequest): Promise<GitCommitPreview | GitCommitResult>;
  applyCommit(token: string): Promise<GitCommitResult>;
  cancelCommit(token: string): Promise<void>;
}

export type GitMutationAction = "stage" | "unstage" | "discard";
export type GitMutationTarget = { kind: "all" } | { kind: "file"; fileId: string }
  | { kind: "hunks"; fileId: string; hunkIds: readonly string[] };
export interface GitPrepareMutationRequest {
  subscriptionId: string;
  snapshotId: string;
  action: GitMutationAction;
  target: GitMutationTarget;
}
export interface GitMutationPreview {
  token: string;
  projectRoot: string;
  action: GitMutationAction;
  scope: "unstaged" | "staged";
  paths: readonly string[];
  hunkCount?: number;
  expiresAt: number;
}
export interface GitRecoveryPoint {
  id: string;
  projectRoot: string;
  createdAt: number;
  paths: readonly string[];
  scope: "unstaged" | "staged";
  status: "prepared" | "applied" | "needsAttention" | "rolledBack" | "restored";
}
export type GitMutationResult =
  | { kind: "applied"; projectRoot: string; action: GitMutationAction | "recover"; recovery?: GitRecoveryPoint }
  | { kind: "error"; error: GitFailure; recovery?: GitRecoveryPoint };

export type GitCommitAction = "commit" | "push" | "commitAndPush";
export interface GitRemote {
  name: string;
  fetchUrl: string | null;
  pushUrl: string | null;
}
export interface GitCommitTarget {
  remote: string;
  branch: string;
}
export interface GitCommitInfoRequest {
  subscriptionId: string;
  snapshotId: string;
}
export interface GitCommitInfo {
  projectRoot: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  upstreamTarget?: GitCommitTarget;
  remotes: readonly GitRemote[];
  hasStaged: boolean;
  stagedPaths: readonly string[];
  stagedAdditions: number;
  stagedDeletions: number;
  indexVersion: string;
  identity: { name: string; email: string } | null;
}
export type GitCommitInfoResult = GitCommitInfo | { kind: "error"; error: GitFailure };
export interface GitPrepareCommitRequest extends GitCommitInfoRequest {
  action: GitCommitAction;
  message?: string;
  target?: GitCommitTarget;
}
export interface GitCommitPreview {
  token: string;
  projectRoot: string;
  action: GitCommitAction;
  message?: string;
  target?: GitCommitTarget;
  branch: string | null;
  upstream: string | null;
  stagedPaths: readonly string[];
  stagedAdditions: number;
  stagedDeletions: number;
  expiresAt: number;
}
export interface GitCommitRecord {
  oid: string;
  message: string;
}
export interface GitPushRecord {
  remote: string;
  branch: string;
  oid: string | null;
}
export type GitCommitResult =
  | { kind: "applied"; projectRoot: string; action: GitCommitAction; commit?: GitCommitRecord; push?: GitPushRecord }
  | { kind: "error"; error: GitFailure; projectRoot?: string; action?: GitCommitAction; commit?: GitCommitRecord; push?: GitPushRecord };

export function gitReviewQueryKey(query: GitReviewQuery): string {
  return JSON.stringify(query.kind === "commit" ? [query.kind, query.commit] : query.kind === "branch" ? [query.kind, query.base] : [query.kind]);
}
