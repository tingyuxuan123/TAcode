import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { GitRepositoryInfo, GitWatchMode } from "../../shared/git";

export type GitWatchChange = "worktree" | "repository" | "poll";
export type GitWatchFactory = (root: string, changed: (filename: string | null) => void, failed: () => void) => () => void;
const nativeWatch: GitWatchFactory = (root, changed, failed) => {
  const watcher: FSWatcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => changed(filename));
  watcher.on("error", failed);
  return () => watcher.close();
};

/** Ignore object/log/lock churn; observe index replacement and refs in linked worktrees. */
export function isGitMetadataChange(filename: string | null): boolean {
  if (!filename) return true;
  const name = filename.split(path.sep).join("/");
  return /^(?:index|HEAD|packed-refs|config|config\.worktree|commondir|gitdir|shallow)$/.test(name)
    || name === "refs" || (name.startsWith("refs/") && !name.endsWith(".lock"))
    || name === "info" || name === "info/exclude" || name === "info/attributes";
}

/** No directory scans. Watchers exist only while a review has subscribers. */
export class GitProjectWatch {
  private readonly handles = new Map<string, () => void>();
  private metadataRoots: string[] = [];
  private disposed = false;
  private generation = 0;
  private fallback?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setInterval>;
  private failed = false;
  constructor(private readonly root: string, private readonly changed: (kind: GitWatchChange) => void,
    private readonly factory: GitWatchFactory = nativeWatch, private readonly pollMs = 1000) {
    this.install();
  }
  get mode(): GitWatchMode { return this.failed ? "polling" : "native"; }

  updateRepository(repository?: GitRepositoryInfo): void {
    const roots = repository ? [...new Set([repository.gitDir, repository.commonDir])] : [];
    if (roots.join("\0") === this.metadataRoots.join("\0")) return;
    this.metadataRoots = roots;
    this.install();
  }

  private install(): void {
    if (this.disposed) return;
    const generation = ++this.generation;
    for (const close of this.handles.values()) close();
    this.handles.clear();
    this.failed = false;
    const add = (key: string, root: string, listener: (filename: string | null) => void) => {
      try {
        const close = this.factory(root, (file) => { if (!this.disposed && generation === this.generation) listener(file); }, () => {
          if (this.disposed || generation !== this.generation) return;
          this.handles.get(key)?.();
          this.handles.delete(key);
          this.degrade();
        });
        this.handles.set(key, close);
      } catch { this.degrade(); }
    };
    add("worktree", this.root, (filename) => {
      const name = filename?.split(path.sep).join("/");
      if (!name || name === ".git") this.changed("repository");
      else if (name.startsWith(".git/")) {
        if (!this.metadataRoots.length) this.changed("repository");
      } else this.changed(name.split("/").includes(".gitattributes") ? "repository" : "worktree");
    });
    for (const root of this.metadataRoots) add(root, root, (filename) => { if (isGitMetadataChange(filename)) this.changed("repository"); });
    if (!this.failed) {
      clearInterval(this.fallback); this.fallback = undefined;
      clearInterval(this.retry); this.retry = undefined;
    }
  }

  private degrade(): void {
    if (this.disposed) return;
    this.failed = true;
    // Native watch can be unavailable on network volumes. Expose the fallback
    // and retry watch setup without leaving the view silently stale.
    this.fallback ??= setInterval(() => this.changed("poll"), this.pollMs);
    this.fallback.unref();
    this.retry ??= setInterval(() => { this.install(); this.changed("repository"); }, Math.max(5000, this.pollMs * 5));
    this.retry.unref();
  }

  close(): void {
    this.disposed = true;
    clearInterval(this.fallback); clearInterval(this.retry);
    for (const close of this.handles.values()) close();
    this.handles.clear();
  }
}
