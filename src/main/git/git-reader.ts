import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { GitBranch, GitComparison, GitContentState, GitFileDiff, GitFileSide, GitRepositoryInfo, GitRepositoryState, GitSnapshot } from "../../shared/git";
import { applyGitHunks, gitDigest, parseGitDiff, parseGitHunks, untrackedPatch, type RawGitChange } from "./git-diff";
import { decodeGitText, GitProcess, GitReadError, gitOutputLine } from "./git-process";

const diffOptions = ["--raw", "--numstat", "--patch", "-z", "--no-abbrev", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--submodule=short", "--ignore-submodules=none", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3"];
const missingSide = (): GitFileSide => ({ oid: null, mode: "000000", size: 0, state: "missing", content: null });
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const statIdentity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(":");
const gitMode = (stat: BigIntStats) => stat.isSymbolicLink() ? "120000" : stat.isDirectory() ? "160000" : Number(stat.mode) & 0o111 ? "100755" : "100644";

interface BlobData { size: number; bytes?: Buffer }
interface WorkingFile { mode: string; size: number; bytes?: Buffer; version: string; missing: boolean }
interface ResolvedComparison { args: string[]; base: string | null; target: string | null }

export interface GitReaderOptions {
  git?: GitProcess;
  maxTextBytes?: number;
  maxSnapshotBytes?: number;
  /** Resolves a recorded turn snapshot to its two immutable workspace trees. */
  turns?: { resolve(snapshotId: string, projectRoot?: string): Promise<{ base: string; target: string } | undefined> };
}

/** Read-only, asynchronous Git access. No Electron imports or global active cwd. */
export class GitReader {
  private readonly git: GitProcess;
  private readonly maxTextBytes: number;
  private readonly maxSnapshotBytes: number;
  private readonly turns?: GitReaderOptions["turns"];

  constructor(private readonly projectRoot: string, options: GitReaderOptions = {}) {
    this.git = options.git ?? new GitProcess();
    this.maxTextBytes = options.maxTextBytes ?? 8 * 1024 * 1024;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 64 * 1024 * 1024;
    this.turns = options.turns;
  }

  async inspect(signal?: AbortSignal): Promise<GitRepositoryState> {
    const projectRoot = await fs.realpath(this.projectRoot);
    try {
      const worktree = gitOutputLine(await this.git.run(projectRoot, ["rev-parse", "--is-inside-work-tree"], { signal }));
      if (worktree !== "true") return { kind: "notRepository", projectRoot };
      const [rootValue, gitDirValue, commonDirValue, formatValue, head, branch, upstream] = await Promise.all([
        this.git.run(projectRoot, ["rev-parse", "--show-toplevel"], { signal }),
        this.git.run(projectRoot, ["rev-parse", "--absolute-git-dir"], { signal }),
        this.git.run(projectRoot, ["rev-parse", "--git-common-dir"], { signal }),
        this.git.run(projectRoot, ["rev-parse", "--show-object-format"], { signal }),
        this.optionalReference(projectRoot, "HEAD", signal),
        this.git.run(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { signal, allowExitCodes: [1] }).then(gitOutputLine),
        this.git.run(projectRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { signal, allowExitCodes: [1, 128] }).then(gitOutputLine),
      ]);
      const root = await fs.realpath(gitOutputLine(rootValue));
      const gitDir = await fs.realpath(gitOutputLine(gitDirValue));
      const commonDir = await fs.realpath(path.resolve(projectRoot, gitOutputLine(commonDirValue)));
      if (!inside(root, projectRoot)) throw new GitReadError("outsideProject", "Project is outside the repository worktree");
      const objectFormat = gitOutputLine(formatValue);
      if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new GitReadError("invalidOutput", "Unsupported Git object format");
      return { kind: "repository", repository: {
        id: gitDigest(projectRoot, root, gitDir), projectRoot, root, gitDir, commonDir, objectFormat,
        pathPrefix: path.relative(root, projectRoot).split(path.sep).join("/"), head, branch: branch || null, upstream: upstream || null, unborn: head === null,
      } };
    } catch (error) {
      if (error instanceof GitReadError && error.code === "missingGit") return { kind: "missingGit", projectRoot };
      if (error instanceof GitReadError && /not a git repository|must be run in a work tree/.test(error.message)) return { kind: "notRepository", projectRoot };
      throw error;
    }
  }

  async branches(signal?: AbortSignal): Promise<GitBranch[]> {
    const repository = await this.requireRepository(signal);
    const output = decodeGitText(await this.git.run(repository.root, ["for-each-ref", "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)%00%(symref)", "refs/heads", "refs/remotes"], { signal }));
    return output.split("\n").filter(Boolean).flatMap((line) => {
      const [ref, name, oid, upstream, current, symbolic] = line.split("\0");
      if (symbolic) return [];
      return [{ ref, name, oid, upstream: upstream || null, current: current === "*", remote: ref.startsWith("refs/remotes/") }];
    });
  }

  async read(comparison: GitComparison, signal?: AbortSignal): Promise<GitSnapshot> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.capture(comparison, signal); }
      catch (error) {
        if (attempt >= 1 || !(error instanceof GitReadError) || error.code !== "changedDuringRead" || signal?.aborted) throw error;
      }
    }
  }

  private async requireRepository(signal?: AbortSignal): Promise<GitRepositoryInfo> {
    const state = await this.inspect(signal);
    if (state.kind !== "repository") throw new GitReadError(state.kind, state.kind === "missingGit" ? "Git is not installed" : "Project is not a Git repository");
    return state.repository;
  }

  private async optionalReference(root: string, ref: string, signal?: AbortSignal): Promise<string | null> {
    const output = gitOutputLine(await this.git.run(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { signal, allowExitCodes: [1, 128] }));
    return /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(output) ? output : null;
  }

  private async reference(repository: GitRepositoryInfo, ref: string, signal?: AbortSignal): Promise<string> {
    if (!ref || ref.includes("\0") || ref.length > 1024) throw new GitReadError("invalidReference", "Invalid Git revision");
    const oid = await this.optionalReference(repository.root, ref, signal);
    if (!oid) throw new GitReadError("invalidReference", `Git revision could not be resolved: ${ref}`);
    return oid;
  }

  private async resolve(repository: GitRepositoryInfo, comparison: GitComparison, signal?: AbortSignal): Promise<ResolvedComparison> {
    const paths = ["--", repository.pathPrefix || "."];
    if (comparison.kind === "unstaged") return { args: ["diff", "--ours", ...diffOptions, ...paths], base: null, target: null };
    if (comparison.kind === "staged") return { args: ["diff", "--cached", ...diffOptions, ...(repository.head ? [repository.head] : []), ...paths], base: repository.head, target: null };
    if (comparison.kind === "commit") {
      const target = await this.reference(repository, comparison.commit, signal);
      const parents = gitOutputLine(await this.git.run(repository.root, ["rev-list", "--parents", "-n", "1", target], { signal })).split(" ");
      const base = parents[1] ?? null;
      return { args: base ? ["diff", ...diffOptions, base, target, ...paths] : ["diff-tree", "--root", "-r", "--no-commit-id", ...diffOptions, target, ...paths], base, target };
    }
    if (comparison.kind === "turn") {
      const turn = await this.turns?.resolve(comparison.snapshotId, this.projectRoot);
      if (!turn) throw new GitReadError("noTurnSnapshot", "The recorded turn snapshot is no longer available");
      return { args: ["diff", ...diffOptions, turn.base, turn.target, ...paths], base: turn.base, target: turn.target };
    }
    if (!repository.head) throw new GitReadError("noCommits", "A branch comparison needs at least one commit");
    const baseRef = await this.reference(repository, comparison.base, signal);
    const base = gitOutputLine(await this.git.run(repository.root, ["merge-base", baseRef, repository.head], { signal, allowExitCodes: [1] }));
    if (!base) throw new GitReadError("noMergeBase", "The selected branches have no common ancestor");
    return { args: ["diff", ...diffOptions, base, repository.head, ...paths], base, target: repository.head };
  }

  private projectPath(repository: GitRepositoryInfo, filePath: string): string {
    if (!filePath || filePath.includes("\0") || path.posix.isAbsolute(filePath) || path.isAbsolute(filePath)
      || filePath.split("/").some((part) => part === ".." || part === "." || !part)) throw new GitReadError("invalidPath", "Invalid repository-relative path");
    const resolved = path.resolve(repository.root, ...filePath.split("/"));
    if (!inside(repository.projectRoot, resolved) || resolved === repository.projectRoot) throw new GitReadError("outsideProject", "Git path is outside the selected project");
    return path.relative(repository.projectRoot, resolved).split(path.sep).join("/");
  }

  private async indexVersion(repository: GitRepositoryInfo): Promise<string> {
    try { return gitDigest(await fs.readFile(path.join(repository.gitDir, "index"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
  }

  private async untracked(repository: GitRepositoryInfo, signal?: AbortSignal): Promise<string[]> {
    const result = await this.git.run(repository.root, ["ls-files", "--others", "--exclude-standard", "-z", "--", repository.pathPrefix || "."], { signal });
    return decodeGitText(result).split("\0").filter(Boolean).map((file) => file.replace(/\/$/, "")).sort();
  }

  private async untrackedBinaryAttributes(repository: GitRepositoryInfo, files: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
    const binary = new Set<string>();
    if (!files.length) return binary;
    const output = decodeGitText(await this.git.run(repository.root, ["check-attr", "-z", "--stdin", "diff"], { input: files.join("\0") + "\0", signal })).split("\0");
    const drivers = new Map<string, string[]>();
    for (let i = 0; i + 2 < output.length; i += 3) {
      const [file, , attribute] = output.slice(i, i + 3);
      if (attribute === "unset") binary.add(file);
      else if (attribute !== "set" && attribute !== "unspecified") {
        const paths = drivers.get(attribute) ?? [];
        paths.push(file);
        drivers.set(attribute, paths);
      }
    }
    for (const [driver, paths] of drivers) {
      const value = gitOutputLine(await this.git.run(repository.root, ["config", "--bool", "--get", `diff.${driver}.binary`], { signal, allowExitCodes: [1] }));
      if (value === "true") for (const file of paths) binary.add(file);
    }
    return binary;
  }

  private async resolveConflicts(repository: GitRepositoryInfo, changes: RawGitChange[], signal?: AbortSignal): Promise<void> {
    if (!changes.some((change) => change.status === "U")) return;
    const output = decodeGitText(await this.git.run(repository.root, ["ls-files", "--unmerged", "-z", "--", repository.pathPrefix || "."], { signal }));
    const stages = new Map<string, { stage: number; oid: string; mode: string }[]>();
    for (const record of output.split("\0").filter(Boolean)) {
      const match = /^(\d{6}) ([0-9a-f]+) ([123])\t([\s\S]+)$/.exec(record);
      if (!match) throw new GitReadError("invalidOutput", "Invalid unmerged index entry");
      const entries = stages.get(match[4]) ?? [];
      entries.push({ mode: match[1], oid: match[2], stage: Number(match[3]) });
      stages.set(match[4], entries);
    }
    for (const change of changes) if (change.status === "U") {
      change.conflictStages = stages.get(change.path) ?? [];
      const ours = change.conflictStages.find((entry) => entry.stage === 2);
      change.oldMode = ours?.mode ?? "000000";
      change.oldOid = ours?.oid ?? null;
      change.newOid = null;
    }
  }

  private async workingFile(repository: GitRepositoryInfo, repositoryPath: string, signal?: AbortSignal, maxBytes = this.maxTextBytes): Promise<WorkingFile> {
    this.projectPath(repository, repositoryPath);
    if (signal?.aborted) throw new GitReadError("cancelled", "Git operation was cancelled");
    const target = path.join(repository.root, ...repositoryPath.split("/"));
    try {
      const parent = await fs.realpath(path.dirname(target));
      if (!inside(repository.projectRoot, parent)) throw new GitReadError("outsideProject", "A parent symlink points outside the project");
      const safeTarget = path.join(parent, path.basename(target));
      const initial = await fs.lstat(safeTarget, { bigint: true });
      const mode = gitMode(initial);
      if (initial.isSymbolicLink()) {
        const bytes = await fs.readlink(safeTarget, { encoding: "buffer" });
        if (statIdentity(initial) !== statIdentity(await fs.lstat(safeTarget, { bigint: true }))) throw new GitReadError("changedDuringRead", "Symlink changed while being read");
        return { mode, bytes, size: bytes.length, version: gitDigest(mode, bytes), missing: false };
      }
      if (initial.isDirectory()) return { mode, size: 0, version: gitDigest(statIdentity(initial)), missing: false };
      if (!initial.isFile()) throw new GitReadError("invalidPath", "Only regular files and symlinks can be reviewed");
      const handle = await fs.open(safeTarget, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat({ bigint: true });
        if (statIdentity(before) !== statIdentity(initial)) throw new GitReadError("changedDuringRead", "File was replaced while being opened");
        let bytes: Buffer | undefined;
        if (before.size <= BigInt(Math.min(this.maxTextBytes, maxBytes))) {
          const storage = Buffer.alloc(Number(before.size) + 1);
          let offset = 0;
          while (offset < storage.length) {
            const { bytesRead } = await handle.read(storage, offset, storage.length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
          }
          bytes = storage.subarray(0, offset);
          if (offset !== Number(before.size)) throw new GitReadError("changedDuringRead", "File size changed while being read");
        }
        if (statIdentity(before) !== statIdentity(await handle.stat({ bigint: true }))) throw new GitReadError("changedDuringRead", "File changed while being read");
        return { mode, bytes, size: Number(before.size), version: bytes ? gitDigest(mode, bytes) : gitDigest(statIdentity(before)), missing: false };
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "000000", size: 0, version: "missing", missing: true };
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new GitReadError("changedDuringRead", "File was replaced with a symlink");
      throw error;
    }
  }

  private async blobs(repository: GitRepositoryInfo, objectIds: readonly string[], signal?: AbortSignal): Promise<Map<string, BlobData>> {
    const ids = [...new Set(objectIds)];
    const result = new Map<string, BlobData>();
    if (!ids.length) return result;
    const metadata = decodeGitText(await this.git.run(repository.root, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: ids.join("\n") + "\n", signal }));
    let remaining = this.maxSnapshotBytes;
    const load: string[] = [];
    for (const line of metadata.trimEnd().split("\n")) {
      const [oid, type, sizeText] = line.split(" ");
      const size = Number(sizeText);
      if (type !== "blob" || !Number.isSafeInteger(size) || size < 0) throw new GitReadError("changedDuringRead", "Git blob is missing or invalid");
      result.set(oid, { size });
      if (size <= this.maxTextBytes && size <= remaining) { load.push(oid); remaining -= size; }
    }
    if (!load.length) return result;
    const bytes = await this.git.run(repository.root, ["cat-file", "--batch"], { input: load.join("\n") + "\n", signal, maxBytes: this.maxSnapshotBytes + load.length * 100 });
    let offset = 0;
    for (const expected of load) {
      const end = bytes.indexOf(10, offset);
      if (end < 0) throw new GitReadError("invalidOutput", "Truncated Git blob header");
      const [oid, type, sizeText] = bytes.subarray(offset, end).toString("ascii").split(" ");
      const size = Number(sizeText);
      if (oid !== expected || type !== "blob" || size !== result.get(oid)?.size || bytes[end + 1 + size] !== 10) throw new GitReadError("invalidOutput", "Invalid Git blob frame");
      result.get(oid)!.bytes = Buffer.from(bytes.subarray(end + 1, end + 1 + size));
      offset = end + size + 2;
    }
    if (offset !== bytes.length) throw new GitReadError("invalidOutput", "Extra Git blob data");
    return result;
  }

  private side(oid: string | null, mode: string, blob?: BlobData, binary = false): GitFileSide {
    if (mode === "000000") return missingSide();
    if (mode === "160000") return { oid, mode, size: 0, state: "submodule", content: oid ? `Subproject commit ${oid}\n` : null };
    if (!blob) throw new GitReadError("changedDuringRead", "A Git file is missing its content");
    if (binary) return { oid, mode, size: blob.size, state: "binary", content: null };
    if (!blob.bytes) return { oid, mode, size: blob.size, state: "tooLarge", content: null };
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(blob.bytes); }
    catch { return { oid, mode, size: blob.size, state: "binary", content: null }; }
    if (blob.bytes.includes(0)) return { oid, mode, size: blob.size, state: "binary", content: null };
    return { oid, mode, size: blob.size, state: mode === "120000" ? "symlink" : "text", content };
  }

  private blobOid(repository: GitRepositoryInfo, bytes: Buffer): string {
    return createHash(repository.objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  }

  private async file(repository: GitRepositoryInfo, raw: RawGitChange, blobs: Map<string, BlobData>, live: boolean, signal?: AbortSignal): Promise<GitFileDiff> {
    const projectPath = this.projectPath(repository, raw.path);
    const previousPath = raw.previousPath ? this.projectPath(repository, raw.previousPath) : undefined;
    const old = this.side(raw.oldOid, raw.oldMode, raw.oldOid ? blobs.get(raw.oldOid) : undefined, raw.binary);
    const hunks = parseGitHunks(raw.patch);
    let next: GitFileSide;
    let worktreeVersion: string | undefined;
    if (!live) next = raw.status === "U" ? { oid: null, mode: raw.newMode, size: 0, state: "conflict", content: null }
      : this.side(raw.newOid, raw.newMode, raw.newOid ? blobs.get(raw.newOid) : undefined, raw.binary);
    else {
      const disk = await this.workingFile(repository, raw.path, signal);
      worktreeVersion = disk.version;
      if (raw.newMode === "000000") {
        if (!disk.missing) throw new GitReadError("changedDuringRead", "Deleted file reappeared while reviewing");
        next = missingSide();
      } else {
        if (disk.missing) throw new GitReadError("changedDuringRead", "File disappeared while reviewing");
        if (raw.status === "U" || raw.binary || old.state === "binary" || old.state === "tooLarge" || /^diff --(?:cc|combined) /m.test(raw.patch)) {
          next = this.side(raw.newOid, raw.newMode, disk, raw.binary || old.state === "binary");
        } else {
          const content = applyGitHunks(old.content ?? "", hunks);
          const state: GitContentState = raw.newMode === "120000" ? "symlink" : raw.newMode === "160000" ? "submodule" : "text";
          next = { oid: raw.newOid, mode: raw.newMode, content, state, size: Buffer.byteLength(content) };
        }
      }
    }
    const change = raw.status === "U" ? "conflict" : raw.status.startsWith("R") ? "renamed" : raw.status.startsWith("A") || raw.status.startsWith("C") ? "added" : raw.status === "D" ? "deleted" : "modified";
    return Object.freeze({ id: gitDigest(repository.id, raw.path), version: gitDigest(raw.patch, old.oid ?? "", next.oid ?? "", worktreeVersion ?? ""),
      path: projectPath, previousPath, repositoryPath: raw.path, previousRepositoryPath: raw.previousPath, change,
      old: Object.freeze(old), new: Object.freeze(next), additions: raw.additions, deletions: raw.deletions,
      binary: raw.binary || old.state === "binary" || next.state === "binary", patch: raw.patch, hunks: Object.freeze(hunks.map((hunk) => Object.freeze(hunk))), worktreeVersion,
      conflictStages: raw.conflictStages ? Object.freeze(raw.conflictStages.map((stage) => Object.freeze(stage))) : undefined });
  }

  private async untrackedFile(repository: GitRepositoryInfo, filePath: string, signal?: AbortSignal, maxBytes = this.maxTextBytes, forceBinary = false): Promise<GitFileDiff> {
    const disk = await this.workingFile(repository, filePath, signal, maxBytes);
    if (disk.missing) throw new GitReadError("changedDuringRead", "Untracked file disappeared");
    const oid = disk.mode === "160000" ? await this.optionalReference(path.join(repository.root, ...filePath.split("/")), "HEAD", signal)
      : disk.bytes ? this.blobOid(repository, disk.bytes) : null;
    const next = this.side(oid, disk.mode, disk, forceBinary);
    const patch = oid ? untrackedPatch(filePath, next.content, oid, disk.mode) : "";
    let additions = next.content?.match(/[^\n]*\n|[^\n]+$/g)?.length ?? 0;
    let binary = next.state === "binary";
    if (next.state === "tooLarge") {
      const stats = decodeGitText(await this.git.run(repository.root, ["diff", "--no-index", "--numstat", "--no-ext-diff", "--no-textconv", "-z", "--", process.platform === "win32" ? "NUL" : "/dev/null", filePath], { signal, allowExitCodes: [1] }));
      const count = /^(\d+|-)\t/.exec(stats)?.[1];
      additions = count && count !== "-" ? Number(count) : 0;
      binary = count === "-";
    }
    return Object.freeze({ id: gitDigest(repository.id, filePath), version: gitDigest(disk.version, oid ?? ""), path: this.projectPath(repository, filePath), repositoryPath: filePath,
      change: "untracked", old: Object.freeze(missingSide()), new: Object.freeze(next), additions, deletions: 0, binary, patch,
      hunks: Object.freeze(parseGitHunks(patch).map((hunk) => Object.freeze(hunk))), worktreeVersion: disk.version });
  }

  private async capture(comparison: GitComparison, signal?: AbortSignal): Promise<GitSnapshot> {
    const repository = await this.requireRepository(signal);
    const resolved = await this.resolve(repository, comparison, signal);
    const live = comparison.kind === "unstaged";
    const historical = comparison.kind === "commit" || comparison.kind === "branch" || comparison.kind === "turn";
    const indexVersion = await this.indexVersion(repository);
    const [diff, untracked] = await Promise.all([
      this.git.run(repository.root, resolved.args, { signal, maxBytes: this.maxSnapshotBytes }),
      live ? this.untracked(repository, signal) : Promise.resolve([]),
    ]);
    const changes = parseGitDiff(diff);
    for (const change of changes) { this.projectPath(repository, change.path); if (change.previousPath) this.projectPath(repository, change.previousPath); }
    await this.resolveConflicts(repository, changes, signal);
    const ids = changes.flatMap((file) => [file.oldMode !== "160000" ? file.oldOid : null, !live && file.newMode !== "160000" ? file.newOid : null].filter((oid): oid is string => Boolean(oid)));
    const [blobs, binaryAttributes] = await Promise.all([this.blobs(repository, ids, signal), this.untrackedBinaryAttributes(repository, untracked, signal)]);
    const files = await mapLimit(changes, 8, (change) => this.file(repository, change, blobs, live, signal));
    const untrackedMetadata = await mapLimit(untracked, 8, (file) => this.workingFile(repository, file, signal, 0));
    let textBudget = Math.max(0, this.maxSnapshotBytes - files.reduce((size, file) => size + Buffer.byteLength(file.old.content ?? "") + Buffer.byteLength(file.new.content ?? ""), 0));
    // Reserve in path order, independently of I/O completion order. Files beyond
    // the text budget remain in the manifest with real stats and an explicit state.
    const allocations = untrackedMetadata.map((file) => {
      if (file.size > this.maxTextBytes || file.size > textBudget) return 0;
      textBudget -= file.size;
      return file.size;
    });
    files.push(...await mapLimit(untracked.map((file, index) => ({ file, bytes: allocations[index] })), 8,
      ({ file, bytes }) => this.untrackedFile(repository, file, signal, bytes, binaryAttributes.has(file))));
    files.sort((a, b) => a.path.localeCompare(b.path, "en"));
    if (!historical) {
      const [latestIndex, latestHead, latestDiff, latestUntracked] = await Promise.all([
        this.indexVersion(repository), this.optionalReference(repository.root, "HEAD", signal),
        this.git.run(repository.root, resolved.args, { signal, maxBytes: this.maxSnapshotBytes }),
        live ? this.untracked(repository, signal) : Promise.resolve([]),
      ]);
      if (latestIndex !== indexVersion || latestHead !== repository.head || !latestDiff.equals(diff) || latestUntracked.join("\0") !== untracked.join("\0")) throw new GitReadError("changedDuringRead", "Repository changed while its comparison was captured");
    }
    const id = gitDigest(repository.id, JSON.stringify(comparison), resolved.base ?? "", resolved.target ?? "", ...files.map((file) => gitDigest(file.id, file.version)));
    return Object.freeze({ id, repository: Object.freeze(repository), comparison: Object.freeze({ ...comparison }), baseCommit: resolved.base, targetCommit: resolved.target,
      capturedAt: Date.now(), readOnly: historical, indexVersion, files: Object.freeze(files),
      additions: files.reduce((n, file) => n + file.additions, 0), deletions: files.reduce((n, file) => n + file.deletions, 0), binaryFiles: files.filter((file) => file.binary).length });
  }
}

async function mapLimit<T, R>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(values.length);
  let index = 0;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length && !failure) {
      const current = index++;
      try { result[current] = await operation(values[current]); }
      catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
  return result;
}
