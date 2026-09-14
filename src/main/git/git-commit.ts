import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { GitCommitAction, GitCommitInfo, GitCommitPreview, GitCommitRecord, GitCommitResult, GitCommitTarget, GitPushRecord, GitRemote, GitRepositoryInfo, GitSnapshot } from "../../shared/git";
import { gitDigest } from "./git-diff";
import { GitReader } from "./git-reader";
import { decodeGitText, GitProcess, GitReadError, gitOutputLine } from "./git-process";
import { GitWriteQueue } from "./git-write-queue";

interface CommitPlan {
  owner: number;
  preview: GitCommitPreview;
  snapshot: GitSnapshot;
  authorizedRoot: string;
  target?: GitCommitTarget;
  targetVersion?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface GitCommitOptions {
  resolveProject(projectRoot: string): Promise<string>;
  git?: GitProcess;
  queue?: GitWriteQueue;
}

const indexFile = (repository: GitRepositoryInfo) => path.join(repository.gitDir, "index");
const indexVersion = async (repository: GitRepositoryInfo): Promise<string> => {
  try { return gitDigest(await fs.readFile(indexFile(repository))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
};

const redactCredentials = (value: string): string => value.replace(/\b([a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi, "$1");
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export const gitCommitFailure = (error: unknown, context?: Pick<GitCommitResult, "projectRoot" | "action" | "commit" | "push">): Extract<GitCommitResult, { kind: "error" }> => ({
  kind: "error",
  ...context,
  error: error instanceof GitReadError ? { code: error.code, message: redactCredentials(error.message), details: error.details && redactCredentials(error.details) }
    : { code: "failed", message: redactCredentials(error instanceof Error ? error.message : String(error)) },
});

function textValue(value: string | undefined, label: string, max = 10_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new GitReadError("invalidRequest", `${label} is invalid`);
  return value.trim();
}

function safeRemoteUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.username = ""; url.password = "";
    return url.toString();
  } catch { return redactCredentials(value); }
}

function classify(error: unknown, operation: "commit" | "push"): GitReadError {
  if (error instanceof GitReadError && error.code !== "failed") return error;
  const message = error instanceof GitReadError ? `${error.message}\n${error.details ?? ""}` : String(error);
  if (operation === "commit") {
    if (/nothing to commit|no changes added to commit|no changes added/i.test(message)) return new GitReadError("noStagedChanges", "There are no staged changes to commit", message);
    if (/please tell me who you are|author identity unknown|user\.name|user\.email|unable to auto-detect email/i.test(message)) return new GitReadError("identityMissing", "Git author identity is not configured", message);
    if (/hook|pre-commit|commit-msg|prepare-commit-msg/i.test(message)) return new GitReadError("hookFailed", "A Git hook rejected the commit", message);
    return new GitReadError("commitFailed", "Git could not create the commit", message);
  }
  if (/authentication failed|could not read username|terminal prompts disabled|permission denied|access denied|http 401|http 403|unauthorized/i.test(message)) return new GitReadError("authFailed", "Git authentication failed", message);
  if (/rejected|non-fast-forward|fetch first|failed to push some refs|remote rejected|updates were rejected/i.test(message)) return new GitReadError("pushRejected", "The remote rejected the push", message);
  return new GitReadError("pushFailed", "Git could not push to the remote", message);
}

/** Commit and push operations share FR-04's serialized repository write boundary. */
export class GitCommitService {
  private readonly git: GitProcess;
  private readonly queue: GitWriteQueue;
  private readonly plans = new Map<string, CommitPlan>();
  private readonly running = new Map<string, { owner: number; controller: AbortController }>();
  private readonly epochs = new Map<number, number>();
  private closing = false;

  constructor(private readonly options: GitCommitOptions) {
    this.git = options.git ?? new GitProcess();
    this.queue = options.queue ?? new GitWriteQueue();
  }

  private async allowed(root: string): Promise<string> {
    try { return await fs.realpath(await this.options.resolveProject(root)); }
    catch (error) { throw new GitReadError("outsideProject", error instanceof Error ? error.message : String(error)); }
  }

  private async current(snapshot: GitSnapshot, authorizedRoot: string, signal?: AbortSignal): Promise<void> {
    const root = await this.allowed(authorizedRoot);
    if (root !== snapshot.repository.projectRoot) throw new GitReadError("outsideProject", "The project binding changed");
    const latest = await new GitReader(root, { git: this.git }).read(snapshot.comparison, signal);
    if (latest.id !== snapshot.id || latest.indexVersion !== snapshot.indexVersion || latest.repository.head !== snapshot.repository.head
      || latest.repository.branch !== snapshot.repository.branch || latest.repository.upstream !== snapshot.repository.upstream) throw new GitReadError("staleSnapshot", "Git changed since this comparison was displayed");
  }

  private async targetVersion(repository: GitRepositoryInfo, target: GitCommitTarget): Promise<string> {
    return gitDigest(await this.git.run(repository.root, ["remote", "get-url", "--push", "--all", "--", target.remote]));
  }

  private async stagedScope(repository: GitRepositoryInfo): Promise<void> {
    if (!repository.pathPrefix) return;
    const paths = decodeGitText(await this.git.run(repository.root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--no-renames"])).split("\0").filter(Boolean);
    if (paths.some((file) => !file.startsWith(`${repository.pathPrefix}/`))) throw new GitReadError("outsideStagedChanges", "Open the repository root before committing staged changes outside the selected project");
  }

  private async remotes(repository: GitRepositoryInfo): Promise<GitRemote[]> {
    const names = decodeGitText(await this.git.run(repository.root, ["remote"])).split(/\r?\n/).filter(Boolean);
    return Promise.all(names.slice(0, 100).map(async (name) => {
      const fetch = gitOutputLine(await this.git.run(repository.root, ["config", "--get", `remote.${name}.url`], { allowExitCodes: [1] }));
      const push = gitOutputLine(await this.git.run(repository.root, ["config", "--get", `remote.${name}.pushurl`], { allowExitCodes: [1] }));
      return { name, fetchUrl: safeRemoteUrl(fetch), pushUrl: safeRemoteUrl(push || fetch) };
    }));
  }

  private async upstreamTarget(repository: GitRepositoryInfo): Promise<GitCommitTarget | undefined> {
    if (!repository.branch || !repository.upstream) return undefined;
    const remote = gitOutputLine(await this.git.run(repository.root, ["config", "--get", `branch.${repository.branch}.remote`], { allowExitCodes: [1] }));
    const merge = gitOutputLine(await this.git.run(repository.root, ["config", "--get", `branch.${repository.branch}.merge`], { allowExitCodes: [1] }));
    if (!remote || remote === "." || !merge.startsWith("refs/heads/")) return undefined;
    return { remote, branch: merge.slice("refs/heads/".length) };
  }

  private async identity(repository: GitRepositoryInfo): Promise<{ name: string; email: string } | null> {
    const [name, email] = await Promise.all([
      this.git.run(repository.root, ["config", "--get", "user.name"], { allowExitCodes: [1] }).then(gitOutputLine),
      this.git.run(repository.root, ["config", "--get", "user.email"], { allowExitCodes: [1] }).then(gitOutputLine),
    ]);
    return name.trim() && email.trim() ? { name: name.trim(), email: email.trim() } : null;
  }

  async info(projectRoot: string, snapshot?: GitSnapshot): Promise<GitCommitInfo> {
    const root = await this.allowed(projectRoot);
    const state = await new GitReader(root, { git: this.git }).inspect();
    if (state.kind !== "repository") throw new GitReadError(state.kind, state.kind === "missingGit" ? "Git is not installed" : "The project is not a Git repository");
    const repository = state.repository;
    const staged = snapshot?.comparison.kind === "staged" && snapshot.repository.id === repository.id
      ? snapshot : await new GitReader(root, { git: this.git }).read({ kind: "staged" });
    const [remotes, upstreamTarget, identity, currentIndexVersion] = await Promise.all([this.remotes(repository), this.upstreamTarget(repository), this.identity(repository), indexVersion(repository)]);
    return { projectRoot: root, branch: repository.branch, head: repository.head, upstream: repository.upstream, upstreamTarget,
      remotes, hasStaged: staged.files.length > 0, stagedPaths: staged.files.map((file) => file.path), stagedAdditions: staged.additions,
      stagedDeletions: staged.deletions, indexVersion: currentIndexVersion, identity };
  }

  private async validateTarget(repository: GitRepositoryInfo, remotes: readonly GitRemote[], target: GitCommitTarget | undefined): Promise<GitCommitTarget> {
    if (!target) throw new GitReadError("noUpstream", "Choose a remote and branch before pushing");
    if (!target.remote || !remotes.some((remote) => remote.name === target.remote)) throw new GitReadError("invalidRequest", "The selected Git remote is unavailable");
    const branch = textValue(target.branch, "Push branch", 1024);
    const check = await this.git.run(repository.root, ["check-ref-format", "--branch", branch], { allowExitCodes: [1, 128] });
    if (gitOutputLine(check) !== branch) throw new GitReadError("invalidRequest", "The selected push branch is invalid");
    return { remote: target.remote, branch };
  }

  async prepare(owner: number, snapshot: GitSnapshot, action: GitCommitAction, message?: string, target: GitCommitTarget | undefined = undefined, authorizedRoot = snapshot.repository.projectRoot): Promise<GitCommitPreview> {
    if (this.closing) throw new GitReadError("cancelled", "Git service is closing");
    if (snapshot.readOnly || (snapshot.comparison.kind !== "unstaged" && snapshot.comparison.kind !== "staged")) throw new GitReadError("invalidRequest", "Historical comparisons are read-only");
    const epoch = this.epochs.get(owner) ?? 0;
    return this.queue.enqueue(snapshot.repository.commonDir, async () => {
      if (this.closing || (this.epochs.get(owner) ?? 0) !== epoch) throw new GitReadError("cancelled", "The workbench was closed");
      await this.current(snapshot, authorizedRoot);
      if (action !== "push") await this.stagedScope(snapshot.repository);
      const info = await this.info(authorizedRoot);
      const commitMessage = action === "push" ? undefined : textValue(message, "Commit message");
      if (action !== "push" && !info.hasStaged) throw new GitReadError("noStagedChanges", "There are no staged changes to commit");
      if (action !== "push" && !info.identity) throw new GitReadError("identityMissing", "Configure Git user.name and user.email before committing");
      const resolvedTarget = action === "commit" ? undefined : await this.validateTarget(snapshot.repository, info.remotes, target ?? info.upstreamTarget);
      const targetVersion = resolvedTarget ? await this.targetVersion(snapshot.repository, resolvedTarget) : undefined;
      if (this.closing || (this.epochs.get(owner) ?? 0) !== epoch) throw new GitReadError("cancelled", "The workbench was closed");
      if (this.plans.size >= 8) throw new GitReadError("invalidRequest", "Too many pending Git operations");
      const preview: GitCommitPreview = { token: randomUUID(), projectRoot: authorizedRoot, action, message: commitMessage, target: resolvedTarget,
        branch: info.branch, upstream: info.upstream, stagedPaths: info.stagedPaths, stagedAdditions: info.stagedAdditions, stagedDeletions: info.stagedDeletions,
        expiresAt: Date.now() + 5 * 60_000 };
      const plan: CommitPlan = { owner, preview, snapshot, authorizedRoot, target: resolvedTarget, targetVersion };
      plan.timer = setTimeout(() => this.cancel(owner, preview.token), 5 * 60_000); plan.timer.unref();
      this.plans.set(preview.token, plan);
      return preview;
    });
  }

  async apply(owner: number, token: string): Promise<GitCommitResult> {
    const plan = this.plans.get(token);
    if (!plan || plan.owner !== owner || plan.preview.expiresAt < Date.now() || this.closing) return gitCommitFailure(new GitReadError("staleSnapshot", "This Git operation has expired"));
    clearTimeout(plan.timer); this.plans.delete(token);
    const epoch = this.epochs.get(owner) ?? 0;
    const controller = new AbortController(); this.running.set(token, { owner, controller });
    return this.queue.enqueue(plan.snapshot.repository.commonDir, async () => {
      let commit: GitCommitRecord | undefined;
      let push: GitPushRecord | undefined;
      let attemptedCommit = false;
      const active = () => {
        if (this.closing || controller.signal.aborted || (this.epochs.get(owner) ?? 0) !== epoch) throw new GitReadError("cancelled", "Git operation was cancelled");
      };
      try {
        active();
        await this.current(plan.snapshot, plan.authorizedRoot, controller.signal);
        if (plan.preview.action !== "push") await this.stagedScope(plan.snapshot.repository);
        if (plan.target && await this.targetVersion(plan.snapshot.repository, plan.target) !== plan.targetVersion) throw new GitReadError("staleSnapshot", "The Git push target changed during confirmation");
        active();
        if (plan.preview.action !== "push") {
          attemptedCommit = true;
          try { await this.git.run(plan.snapshot.repository.root, ["commit", "--file=-"], { input: `${plan.preview.message ?? ""}\n`, signal: controller.signal }); }
          catch (error) { if (controller.signal.aborted) throw new GitReadError("cancelled", "Git operation was cancelled"); throw classify(error, "commit"); }
          // Record a completed commit even when cancellation arrives before push.
          const oid = gitOutputLine(await this.git.run(plan.snapshot.repository.root, ["rev-parse", "HEAD"]));
          if (!objectId.test(oid)) throw new GitReadError("invalidOutput", "Git returned an invalid commit identifier");
          commit = { oid, message: plan.preview.message ?? "" };
          active();
        }
        if (plan.preview.action !== "commit") {
          const target = plan.target;
          if (!target) throw new GitReadError("noUpstream", "Choose a remote and branch before pushing");
          const setUpstream = !plan.preview.upstream || plan.preview.upstream !== `${target.remote}/${target.branch}`;
          const args = ["push", "--porcelain", ...(setUpstream ? ["--set-upstream"] : []), "--", target.remote, `HEAD:refs/heads/${target.branch}`];
          try { await this.git.run(plan.snapshot.repository.root, args, { signal: controller.signal, maxBytes: 512 * 1024 }); }
          catch (error) { if (controller.signal.aborted) throw new GitReadError("cancelled", "Git operation was cancelled"); throw classify(error, "push"); }
          push = { remote: target.remote, branch: target.branch, oid: commit?.oid ?? plan.snapshot.repository.head };
        }
        return { kind: "applied" as const, projectRoot: plan.preview.projectRoot, action: plan.preview.action, commit, push };
      } catch (error) {
        // HEAD can change before a post-commit hook finishes or is cancelled.
        if (attemptedCommit && !commit) {
          const oid = await this.git.run(plan.snapshot.repository.root, ["rev-parse", "HEAD"]).then(gitOutputLine).catch(() => "");
          if (objectId.test(oid) && oid !== plan.snapshot.repository.head) commit = { oid, message: plan.preview.message ?? "" };
        }
        return gitCommitFailure(error, { projectRoot: plan.preview.projectRoot, action: plan.preview.action, commit, push });
      }
      finally { this.running.delete(token); }
    });
  }

  cancel(owner: number, token: string): void {
    const plan = this.plans.get(token);
    if (plan?.owner === owner) { clearTimeout(plan.timer); this.plans.delete(token); }
    const running = this.running.get(token); if (running?.owner === owner) running.controller.abort();
  }
  releaseOwner(owner: number): void {
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    for (const [token, plan] of this.plans) if (plan.owner === owner) this.cancel(owner, token);
    for (const [token, running] of this.running) if (running.owner === owner) this.cancel(owner, token);
  }
  close(): void { this.closing = true; for (const [token, plan] of this.plans) this.cancel(plan.owner, token); for (const [token, running] of this.running) this.cancel(running.owner, token); }
  async idle(): Promise<void> { await this.queue.idle(); }
}
