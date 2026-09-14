import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GitFileDiff, GitMutationAction, GitMutationPreview, GitMutationResult, GitMutationTarget, GitRepositoryInfo, GitSnapshot } from "../../shared/git";
import { gitDigest, quoteGitPath } from "./git-diff";
import { GitReader } from "./git-reader";
import { decodeGitText, GitProcess, GitReadError, gitOutputLine } from "./git-process";
import { GitRecoveryStore, recoverySummary, type GitRecoveryManifest } from "./git-recovery";
import { GitFileTransaction, gitWorktreePath, missingGitFile, readGitFileImage, writeGitFileImage, type GitFileReplacement } from "./git-worktree-files";

interface MutationPlan {
  owner: number;
  preview: GitMutationPreview;
  snapshot: GitSnapshot;
  authorizedRoot: string;
  paths: string[];
  files: GitFileReplacement[];
  nextIndex: Buffer;
  indexBefore: string;
  indexAfter: string;
  timer?: ReturnType<typeof setTimeout>;
}
export interface GitMutationOptions {
  resolveProject(projectRoot: string): Promise<string>;
  recoveryRoot: string;
  git?: GitProcess;
}
const nulPaths = (paths: readonly string[]) => paths.join("\0") + "\0";
const indexFile = (repository: GitRepositoryInfo) => path.join(repository.gitDir, "index");
const bytesVersion = (bytes: Buffer | undefined) => bytes ? gitDigest(bytes) : "missing";
function preserveTextLineEndings(before: Buffer, after: Buffer): Buffer {
  if (before.includes(0) || after.includes(0)) return after;
  const beforeText = before.toString("utf8");
  const crlf = (beforeText.match(/\r\n/g) ?? []).length;
  const lf = (beforeText.match(/(?<!\r)\n/g) ?? []).length;
  if (!crlf || crlf < lf) return after;
  return Buffer.from(after.toString("utf8").replace(/\r?\n/g, "\r\n"));
}
function normalizeTextLineEndings(bytes: Buffer): Buffer {
  if (bytes.includes(0)) return bytes;
  return Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
}
async function indexBytes(repository: GitRepositoryInfo): Promise<Buffer | undefined> {
  try { return await fs.readFile(indexFile(repository)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export const gitMutationFailure = (error: unknown): Extract<GitMutationResult, { kind: "error" }> => ({ kind: "error", error: error instanceof GitReadError
  ? { code: error.code, message: error.message, details: error.details }
  : { code: "failed", message: error instanceof Error ? error.message : String(error) } });

function selectedFiles(snapshot: GitSnapshot, action: GitMutationAction, target: GitMutationTarget): GitFileDiff[] {
  if (snapshot.readOnly || (snapshot.comparison.kind !== "unstaged" && snapshot.comparison.kind !== "staged")) throw new GitReadError("invalidRequest", "Historical comparisons are read-only");
  if ((action === "stage" && snapshot.comparison.kind !== "unstaged") || (action === "unstage" && snapshot.comparison.kind !== "staged")) throw new GitReadError("invalidRequest", "The action does not apply to this comparison");
  const files = target.kind === "all" ? [...snapshot.files] : snapshot.files.filter((file) => file.id === target.fileId);
  if (!files.length || files.some((file) => file.change === "conflict")) throw new GitReadError("unsupportedChange", "Resolve conflicting index entries before changing this selection");
  if (target.kind === "hunks") {
    const file = files[0];
    if (!target.hunkIds.length || new Set(target.hunkIds).size !== target.hunkIds.length || target.hunkIds.some((id) => !file.hunks.some((hunk) => hunk.id === id))) throw new GitReadError("invalidRequest", "The selected Git hunk does not belong to this snapshot");
    if (file.binary || ![file.old.state, file.new.state].every((state) => state === "missing" || state === "text")) throw new GitReadError("unsupportedChange", "This change has no editable text hunks");
  }
  return files;
}

/** Partial content changes keep a rename and permission change in their current state. */
function selectedPatch(file: GitFileDiff, target: Extract<GitMutationTarget, { kind: "hunks" }>): string {
  const hunks = file.hunks.filter((hunk) => target.hunkIds.includes(hunk.id));
  const from = quoteGitPath(`a/${file.repositoryPath}`);
  const to = quoteGitPath(`b/${file.repositoryPath}`);
  return `diff --git ${from} ${to}\n--- ${from}\n+++ ${to}\n` + hunks.map((hunk) => hunk.patch).join("");
}

/** Repository writes are serialized, including across linked worktrees. */
export class GitMutationService {
  private readonly git: GitProcess;
  private readonly recovery: GitRecoveryStore;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly plans = new Map<string, MutationPlan>();
  private readonly epochs = new Map<number, number>();
  private closing = false;
  constructor(private readonly options: GitMutationOptions) {
    this.git = options.git ?? new GitProcess();
    this.recovery = new GitRecoveryStore(options.recoveryRoot);
  }

  private enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(key) ?? Promise.resolve()).then(job);
    const settled = task.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return task;
  }
  private async allowed(root: string): Promise<string> {
    const resolved = await this.options.resolveProject(root).catch((error: unknown) => {
      throw new GitReadError("outsideProject", error instanceof Error ? error.message : String(error));
    });
    return fs.realpath(resolved);
  }
  private async current(snapshot: GitSnapshot, authorizedRoot: string): Promise<void> {
    const root = await this.allowed(authorizedRoot);
    if (root !== snapshot.repository.projectRoot) throw new GitReadError("outsideProject", "The project binding changed");
    const latest = await new GitReader(root, { git: this.git }).read(snapshot.comparison);
    if (latest.id !== snapshot.id || latest.indexVersion !== snapshot.indexVersion || latest.repository.head !== snapshot.repository.head) throw new GitReadError("staleSnapshot", "Git changed since this comparison was displayed");
  }
  private async entries(repository: GitRepositoryInfo, paths: readonly string[], alternate?: string): Promise<string> {
    return decodeGitText(await this.git.run(repository.root, ["ls-files", "--stage", "-z", "--", ...paths], { indexFile: alternate }));
  }
  private async temporaryIndex<T>(repository: GitRepositoryInfo, source: Buffer | undefined, job: (alternate: string) => Promise<T>): Promise<T> {
    // A split index resolves sharedindex.* next to its index. Keep the private
    // copy in gitDir and make the published candidate self-contained.
    const alternate = path.join(repository.gitDir, `.tacode-index-${randomUUID()}`);
    try {
      if (source) await fs.writeFile(alternate, source, { flag: "wx", mode: 0o600 });
      else await this.git.run(repository.root, ["read-tree", "--empty"], { indexFile: alternate });
      await this.git.run(repository.root, ["update-index", "--no-split-index"], { indexFile: alternate });
      return await job(alternate);
    } finally {
      await fs.rm(alternate, { force: true });
      await fs.rm(`${alternate}.lock`, { force: true });
    }
  }
  private async applyPatch(repository: GitRepositoryInfo, alternate: string, patch: string | Buffer, cached: boolean, scratch?: string, paths: readonly string[] = []): Promise<void> {
    const args = [...(scratch ? [`--git-dir=${repository.gitDir}`, `--work-tree=${scratch}`] : []), "apply", "--reverse", "--whitespace=nowarn", ...(cached ? ["--cached"] : [])];
    try {
      await this.git.run(scratch ?? repository.root, [...args, "--check"], { indexFile: alternate, input: patch });
      await this.git.run(scratch ?? repository.root, args, { indexFile: alternate, input: patch });
    } catch (error) {
      // Only permit Git's whitespace-insensitive fallback when a strict check
      // succeeds after changing line endings alone. Intra-line whitespace
      // changes must remain a conflict with the frozen review snapshot.
      if (!scratch) throw new GitReadError("patchRejected", "The reverse patch overlaps other changes or cannot be applied safely", String(error));
      const normalized = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-git-patch-check-"));
      try {
        for (const file of paths) {
          const source = path.join(scratch, ...file.split("/"));
          const image = await readGitFileImage(source);
          if (image.kind === "missing") continue;
          await writeGitFileImage(path.join(normalized, ...file.split("/")), image.kind === "file"
            ? { ...image, bytes: normalizeTextLineEndings(image.bytes) }
            : image);
        }
        await this.git.run(normalized, [...args, "--check"], { indexFile: alternate, input: patch });
        await this.git.run(scratch ?? repository.root, [...args, "--ignore-whitespace", "--check"], { indexFile: alternate, input: patch });
        await this.git.run(scratch ?? repository.root, [...args, "--ignore-whitespace"], { indexFile: alternate, input: patch });
      } catch (fallback) { throw new GitReadError("patchRejected", "The reverse patch overlaps other changes or cannot be applied safely", `${error instanceof Error ? error.message : String(error)}\nFallback: ${fallback instanceof Error ? fallback.message : String(fallback)}`); }
      finally { await fs.rm(normalized, { recursive: true, force: true }); }
    }
  }

  private async stageFiles(repository: GitRepositoryInfo, alternate: string, files: readonly GitFileDiff[], images: readonly GitFileReplacement[]): Promise<void> {
    for (const file of files) {
      if (file.previousRepositoryPath) await this.git.run(repository.root, ["update-index", "--force-remove", "--", file.previousRepositoryPath], { indexFile: alternate });
      if (file.new.state === "missing") {
        await this.git.run(repository.root, ["update-index", "--force-remove", "--", file.repositoryPath], { indexFile: alternate });
        continue;
      }
      let oid = file.new.oid;
      if (file.new.mode !== "160000") {
        const image = images.find((image) => image.path === file.repositoryPath)!.before;
        oid = gitOutputLine(await this.git.run(repository.root, ["hash-object", "-w", ...(image.kind === "symlink" ? [] : [`--path=${file.repositoryPath}`]), "--stdin"], { input: image.bytes }));
      }
      if (!oid || !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(oid)) throw new GitReadError("invalidOutput", "Git did not produce an object for the selected file");
      await this.git.run(repository.root, ["update-index", "--add", "--cacheinfo", file.new.mode, oid, file.repositoryPath], { indexFile: alternate });
    }
  }

  async prepare(owner: number, snapshot: GitSnapshot, action: GitMutationAction, target: GitMutationTarget, authorizedRoot = snapshot.repository.projectRoot): Promise<GitMutationPreview> {
    if (this.closing) throw new GitReadError("cancelled", "Git service is closing");
    const epoch = this.epochs.get(owner) ?? 0;
    const selected = selectedFiles(snapshot, action, target);
    return this.enqueue(snapshot.repository.commonDir, async () => {
      if (this.closing || (this.epochs.get(owner) ?? 0) !== epoch) throw new GitReadError("cancelled", "The workbench was closed");
      await this.current(snapshot, authorizedRoot);
      const repository = snapshot.repository;
      const paths = [...new Set(selected.flatMap((file) => file.previousRepositoryPath ? [file.previousRepositoryPath, file.repositoryPath] : [file.repositoryPath]))].sort();
      for (const file of paths) await gitWorktreePath(repository, file);
      if (paths.length > 10000) throw new GitReadError("outputLimit", "Too many files in one Git operation");
      const sourceIndex = await indexBytes(repository);
      if (bytesVersion(sourceIndex) !== snapshot.indexVersion) throw new GitReadError("staleSnapshot", "The index changed");
      const files: GitFileReplacement[] = [];
      let remaining = 128 * 1024 * 1024;
      if (action !== "unstage") for (const file of paths) {
        const selectedFile = selected.find((entry) => entry.repositoryPath === file || entry.previousRepositoryPath === file)!;
        if (action === "stage" && selectedFile.new.mode === "160000") continue;
        const absolutePath = await gitWorktreePath(repository, file);
        const before = await readGitFileImage(absolutePath, remaining);
        remaining -= before.bytes.length;
        files.push({ path: file, absolutePath, before, after: before });
      }
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-git-mutation-"));
      let nextIndex!: Buffer, beforeEntries!: string, afterEntries!: string;
      try {
        await this.temporaryIndex(repository, sourceIndex, async (alternate) => {
          beforeEntries = await this.entries(repository, paths, alternate);
          // New/deleted files have a single complete hunk. Partial ordinary
          // hunks preserve file metadata; full-file operations include it.
          const partial = target.kind === "hunks" && selected[0].old.state !== "missing" && selected[0].new.state !== "missing";
          const patch = partial ? selectedPatch(selected[0], target as Extract<GitMutationTarget, { kind: "hunks" }>)
            : action === "discard" && snapshot.comparison.kind === "staged" ? await this.git.run(repository.root,
              ["diff", "--cached", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=50%", "--src-prefix=a/", "--dst-prefix=b/", ...(repository.head ? [repository.head] : []), "--", ...paths], { indexFile: alternate }) : undefined;
          if (action === "stage") {
            if (partial) {
              const args = ["apply", "--cached", "--whitespace=nowarn"];
              try {
                await this.git.run(repository.root, [...args, "--check"], { indexFile: alternate, input: patch });
                await this.git.run(repository.root, args, { indexFile: alternate, input: patch });
              } catch (error) { throw new GitReadError("patchRejected", "The hunk no longer applies to the index", String(error)); }
            } else await this.stageFiles(repository, alternate, selected, files);
          } else if (snapshot.comparison.kind === "staged") {
            if (partial || action === "discard") await this.applyPatch(repository, alternate, patch!, true, undefined, paths);
            else if (repository.head) await this.git.run(repository.root, ["restore", "--staged", `--source=${repository.head}`, "--pathspec-from-file=-", "--pathspec-file-nul"], { indexFile: alternate, input: nulPaths(paths) });
            else await this.git.run(repository.root, ["update-index", "--force-remove", "-z", "--stdin"], { indexFile: alternate, input: nulPaths(paths) });
          }
          if (action === "discard") {
            if (partial || snapshot.comparison.kind === "staged") {
              for (const file of files) await writeGitFileImage(path.join(scratch, ...file.path.split("/")), file.before);
              await this.applyPatch(repository, alternate, patch!, false, scratch, paths);
            } else {
              const tracked = beforeEntries.split("\0").filter(Boolean).map((entry) => entry.slice(entry.indexOf("\t") + 1));
              if (tracked.length) await this.git.run(repository.root, ["checkout-index", `--prefix=${scratch}${path.sep}`, "--force", "-z", "--stdin"], { indexFile: alternate, input: nulPaths(tracked) });
            }
            let nextBudget = 128 * 1024 * 1024;
            for (const file of files) {
              file.after = await readGitFileImage(path.join(scratch, ...file.path.split("/")), nextBudget);
              if (file.before.kind === "file" && file.after.kind === "file") {
                const bytes = preserveTextLineEndings(file.before.bytes, file.after.bytes);
                file.after = { ...file.after, bytes, version: gitDigest(file.after.kind, String(file.after.mode), bytes) };
              }
              nextBudget -= file.after.bytes.length;
            }
          }
          await this.git.run(repository.root, ["update-index", "--no-split-index"], { indexFile: alternate });
          nextIndex = action === "discard" && snapshot.comparison.kind === "unstaged" ? sourceIndex ?? Buffer.alloc(0) : await fs.readFile(alternate);
          afterEntries = await this.entries(repository, paths, alternate);
        });
      } finally { await fs.rm(scratch, { recursive: true, force: true }); }
      await this.current(snapshot, authorizedRoot);
      for (const file of files) if ((await readGitFileImage(file.absolutePath)).version !== file.before.version) throw new GitReadError("staleSnapshot", `Working file changed during preparation: ${file.path}`);
      if (this.closing || (this.epochs.get(owner) ?? 0) !== epoch) throw new GitReadError("cancelled", "The workbench was closed");
      for (const [token, plan] of this.plans) if (plan.owner === owner) this.cancel(owner, token);
      if (this.plans.size >= 8) throw new GitReadError("invalidRequest", "Too many pending Git operations");
      const scope = snapshot.comparison.kind as "unstaged" | "staged";
      const preview: GitMutationPreview = { token: randomUUID(), projectRoot: authorizedRoot, action, scope,
        paths: paths.map((file) => path.relative(repository.projectRoot, path.join(repository.root, ...file.split("/"))).split(path.sep).join("/")),
        hunkCount: target.kind === "hunks" ? target.hunkIds.length : undefined, expiresAt: Date.now() + 5 * 60_000 };
      const plan: MutationPlan = { owner, preview, snapshot, authorizedRoot, paths, files, nextIndex, indexBefore: beforeEntries, indexAfter: afterEntries };
      plan.timer = setTimeout(() => this.cancel(owner, preview.token), 5 * 60_000); plan.timer.unref();
      this.plans.set(preview.token, plan);
      return preview;
    });
  }

  private async publish(repository: GitRepositoryInfo, expectedIndex: string, nextIndex: Buffer, files: readonly GitFileReplacement[],
    validate: () => Promise<void>, recovery?: GitRecoveryManifest): Promise<GitRecoveryManifest | undefined> {
    const lockPath = `${indexFile(repository)}.lock`;
    let handle;
    try { handle = await fs.open(lockPath, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new GitReadError("indexLocked", "Another Git operation owns index.lock"); throw error; }
    const transaction = new GitFileTransaction(repository);
    let published = false, ownLock = true;
    try {
      if (bytesVersion(await indexBytes(repository)) !== expectedIndex) throw new GitReadError("staleSnapshot", "The index changed before the operation");
      await validate();
      await transaction.apply(files);
      if (bytesVersion(await indexBytes(repository)) !== expectedIndex) throw new GitReadError("staleSnapshot", "The index changed during the operation");
      if (nextIndex.length && bytesVersion(nextIndex) !== expectedIndex) {
        await handle.writeFile(nextIndex); await handle.sync(); await handle.close(); handle = undefined;
        await fs.rename(lockPath, indexFile(repository)); ownLock = false;
      }
      published = true;
      await transaction.finish();
      if (recovery) recovery = await this.recovery.status(recovery, "applied").catch(() => recovery!);
      return recovery;
    } catch (error) {
      if (!published) {
        try { await transaction.rollback(); if (recovery) await this.recovery.status(recovery, "rolledBack"); }
        catch (rollbackError) {
          if (recovery) await this.recovery.status(recovery, "needsAttention").catch(() => undefined);
          throw rollbackError;
        }
      }
      throw error;
    } finally {
      await handle?.close();
      if (ownLock) await fs.rm(lockPath, { force: true });
    }
  }

  async apply(owner: number, token: string): Promise<GitMutationResult> {
    const plan = this.plans.get(token);
    if (!plan || plan.owner !== owner || plan.preview.expiresAt < Date.now() || this.closing) return gitMutationFailure(new GitReadError("staleSnapshot", "This Git operation has expired"));
    this.cancel(owner, token);
    return this.enqueue(plan.snapshot.repository.commonDir, async () => {
      let recovery: GitRecoveryManifest | undefined;
      try {
        await this.current(plan.snapshot, plan.authorizedRoot);
        if (plan.preview.action === "discard") recovery = await this.recovery.create(plan.snapshot.repository, plan.preview.scope, plan.paths, plan.indexBefore, plan.indexAfter, plan.files);
        recovery = await this.publish(plan.snapshot.repository, plan.snapshot.indexVersion, plan.nextIndex, plan.files, () => this.current(plan.snapshot, plan.authorizedRoot), recovery);
        return { kind: "applied", projectRoot: plan.preview.projectRoot, action: plan.preview.action, recovery: recovery && recoverySummary(recovery) };
      } catch (error) {
        if (recovery) recovery = await this.recovery.read(plan.snapshot.repository.projectRoot, recovery.id).catch(() => recovery!);
        return { ...gitMutationFailure(error), recovery: recovery && recoverySummary(recovery) };
      }
    });
  }

  cancel(owner: number, token: string): void {
    const plan = this.plans.get(token);
    if (plan?.owner === owner) { clearTimeout(plan.timer); this.plans.delete(token); }
  }
  releaseOwner(owner: number): void {
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    for (const [token, plan] of this.plans) if (plan.owner === owner) this.cancel(owner, token);
  }
  close(): void { this.closing = true; for (const [token, plan] of this.plans) this.cancel(plan.owner, token); }
  async idle(): Promise<void> { await Promise.all([...this.queues.values()]); }
  async listRecoveries(projectRoot: string) { return this.recovery.list(await this.allowed(projectRoot)); }

  async restore(projectRoot: string, id: string): Promise<GitMutationResult> {
    try {
      if (this.closing) throw new GitReadError("cancelled", "Git service is closing");
      const root = await this.allowed(projectRoot);
      const state = await new GitReader(root, { git: this.git }).inspect();
      if (state.kind !== "repository") throw new GitReadError(state.kind, "The project is not an available Git repository");
      return await this.enqueue(state.repository.commonDir, async () => {
        const repository = state.repository;
        const record = await this.recovery.read(root, id);
        if (record.repositoryId !== repository.id || record.head !== repository.head || record.status === "restored" || record.status === "rolledBack") throw new GitReadError("recoveryConflict", "The recovery point no longer matches this repository or HEAD");
        const paths = record.repositoryPaths;
        for (const file of paths) await gitWorktreePath(repository, file);
        const currentIndex = await indexBytes(repository);
        const currentEntries = await this.entries(repository, paths);
        if (currentEntries !== record.indexBefore && currentEntries !== record.indexAfter) throw new GitReadError("recoveryConflict", "Selected index entries changed after the restore point");
        const images = await this.recovery.images(record);
        const files: GitFileReplacement[] = [];
        for (const file of images) {
          if (!paths.includes(file.path)) throw new GitReadError("invalidOutput", "Unexpected recovery path");
          const absolutePath = await gitWorktreePath(repository, file.path);
          const before = await readGitFileImage(absolutePath);
          if (before.version !== file.before.version && before.version !== file.after.version) throw new GitReadError("recoveryConflict", `Working file changed after the restore point: ${file.path}`);
          files.push({ path: file.path, absolutePath, before, after: file.before });
        }
        const nextIndex = await this.temporaryIndex(repository, currentIndex, async (alternate) => {
          const zero = "0".repeat(repository.objectFormat === "sha256" ? 64 : 40);
          for (const entry of record.indexBefore.split("\0").filter(Boolean)) {
            const match = /^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(entry);
            if (!match || !paths.includes(match[4]) || !["100644", "100755", "120000", "160000"].includes(match[1]) || match[3] !== "0") throw new GitReadError("invalidOutput", "Invalid recovery index entry");
          }
          const input = paths.map((file) => `0 ${zero}\t${file}\0`).join("") + record.indexBefore;
          await this.git.run(repository.root, ["update-index", "-z", "--index-info"], { indexFile: alternate, input });
          await this.git.run(repository.root, ["update-index", "--no-split-index"], { indexFile: alternate });
          return fs.readFile(alternate);
        });
        await this.publish(repository, bytesVersion(currentIndex), nextIndex, files, async () => {
          const latest = await new GitReader(await this.allowed(projectRoot), { git: this.git }).inspect();
          if (latest.kind !== "repository" || latest.repository.id !== repository.id || latest.repository.head !== record.head) throw new GitReadError("recoveryConflict", "Repository or HEAD changed before recovery");
        });
        await this.recovery.status(record, "restored");
        return { kind: "applied" as const, projectRoot: root, action: "recover" as const };
      });
    } catch (error) { return gitMutationFailure(error); }
  }
}
