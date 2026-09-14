import fs from "node:fs/promises";
import { gitReviewQueryKey, type GitReviewQuery, type GitReviewResult, type GitReviewUpdate, type GitSubscribeRequest, type GitSnapshot } from "../../shared/git";
import { GitReader } from "./git-reader";
import { GitReadError } from "./git-process";
import { GitProjectWatch, type GitWatchChange, type GitWatchFactory } from "./git-watch";

interface Subscriber {
  owner: number;
  request: GitSubscribeRequest;
  publish(update: GitReviewUpdate): void;
  group?: ComparisonGroup;
}
interface ComparisonGroup {
  project: Project;
  query: GitReviewQuery;
  subscribers: Set<Subscriber>;
  generation: number;
  result?: GitReviewResult;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
interface Project {
  root: string;
  reader: Pick<GitReader, "inspect" | "read" | "branches">;
  watcher: GitProjectWatch;
  groups: Map<string, ComparisonGroup>;
}
export interface GitReviewServiceOptions {
  /** Production supplies the opened-project authorization check. Never ambient cwd. */
  resolveProject(projectRoot: string): Promise<string>;
  reader?(projectRoot: string): Pick<GitReader, "inspect" | "read" | "branches">;
  watch?: GitWatchFactory;
  debounceMs?: number;
  pollMs?: number;
}
const failure = (error: unknown): GitReviewResult => ({ kind: "error", error: error instanceof GitReadError
  ? { code: error.code, message: error.message, details: error.details }
  : { code: "failed", message: error instanceof Error ? error.message : String(error) } });

/** Coalesces reads by canonical project + comparison, with per-window ownership. */
export class GitReviewService {
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly projects = new Map<string, Project>();
  private sequence = 0;
  private closed = false;
  constructor(private readonly options: GitReviewServiceOptions) {}
  private key(owner: number, id: string): string { return `${owner}:${id}`; }
  private current(subscriber: Subscriber): boolean {
    return !this.closed && this.subscribers.get(this.key(subscriber.owner, subscriber.request.subscriptionId)) === subscriber;
  }

  async subscribe(owner: number, request: GitSubscribeRequest, publish: Subscriber["publish"]): Promise<void> {
    if (this.closed) return;
    this.unsubscribe(owner, request.subscriptionId);
    if ([...this.subscribers.values()].filter((sub) => sub.owner === owner).length >= 16) throw new GitReadError("invalidRequest", "Too many Git subscriptions");
    const sub: Subscriber = { owner, request, publish };
    // Register before asynchronous authorization: unsubscribe/reload wins even
    // if realpath or the recent-project store has not returned yet.
    this.subscribers.set(this.key(owner, request.subscriptionId), sub);
    await this.bind(sub);
  }

  private async bind(sub: Subscriber): Promise<void> {
    try {
      const allowed = await this.options.resolveProject(sub.request.projectRoot).catch((error: unknown) => {
        throw error instanceof GitReadError ? error : new GitReadError("outsideProject", error instanceof Error ? error.message : String(error));
      });
      const root = await fs.realpath(allowed);
      if (!(await fs.stat(root)).isDirectory()) throw new GitReadError("invalidPath", "Project is not a directory");
      if (!this.current(sub) || sub.group) return;
      let project = this.projects.get(root);
      if (!project) {
        project = { root, reader: this.options.reader?.(root) ?? new GitReader(root), groups: new Map(), watcher: undefined! };
        const entry = project;
        project.watcher = new GitProjectWatch(root, (reason) => this.changed(entry, reason), this.options.watch, this.options.pollMs);
        this.projects.set(root, project);
      }
      const key = gitReviewQueryKey(sub.request.query);
      let group = project.groups.get(key);
      if (!group) {
        group = { project, query: sub.request.query, subscribers: new Set(), generation: 0 };
        project.groups.set(key, group);
      }
      group.subscribers.add(sub); sub.group = group;
      this.emit(sub, !group.result || Boolean(group.controller || group.timer), group.result);
      if (!group.result && !group.controller && !group.timer) this.schedule(group, 0);
    } catch (error) { if (this.current(sub)) this.emit(sub, false, failure(error)); }
  }

  private emit(sub: Subscriber, loading: boolean, result?: GitReviewResult): void {
    if (!this.current(sub)) return;
    sub.publish({ ...sub.request, sequence: ++this.sequence, loading, result, watchMode: sub.group?.project.watcher.mode ?? "native" });
  }
  private broadcast(group: ComparisonGroup, loading: boolean, result?: GitReviewResult): void {
    for (const sub of group.subscribers) this.emit(sub, loading, result);
  }
  private changed(project: Project, reason: GitWatchChange): void {
    if (this.closed || this.projects.get(project.root) !== project) return;
    for (const group of project.groups.values()) {
      if (reason === "worktree" && group.query.kind !== "unstaged") continue;
      if (reason === "poll" && (group.controller || group.timer)) continue;
      this.invalidate(group);
    }
  }
  private invalidate(group: ComparisonGroup): void {
    group.generation++;
    if (!group.controller) this.schedule(group, this.options.debounceMs ?? 180);
  }
  private schedule(group: ComparisonGroup, delay: number): void {
    if (group.timer || !group.subscribers.size || this.closed) return;
    group.timer = setTimeout(() => { group.timer = undefined; void this.read(group); }, delay);
    group.timer.unref();
  }

  private async read(group: ComparisonGroup): Promise<void> {
    if (!group.subscribers.size || this.closed) return;
    const generation = group.generation;
    const controller = new AbortController(); group.controller = controller;
    this.broadcast(group, true);
    let result: GitReviewResult;
    try {
      const { reader, watcher } = group.project;
      const state = await reader.inspect(controller.signal);
      if (controller.signal.aborted) return;
      watcher.updateRepository(state.kind === "repository" ? state.repository : undefined);
      if (state.kind !== "repository") result = state;
      else if (group.query.kind === "repository") result = { ...state, branches: await reader.branches(controller.signal) };
      else {
        const [snapshot, branches] = await Promise.allSettled([reader.read(group.query, controller.signal), reader.branches(controller.signal)]);
        if (snapshot.status === "rejected") throw snapshot.reason;
        if (branches.status === "rejected") throw branches.reason;
        result = { kind: "ready", snapshot: snapshot.value, branches: branches.value };
      }
    } catch (error) { result = failure(error); }
    finally { if (group.controller === controller) group.controller = undefined; }
    if (controller.signal.aborted || this.closed || !group.subscribers.size) return;
    if (generation !== group.generation) { this.schedule(group, this.options.debounceMs ?? 180); return; }
    // Reuse file objects on no-op refreshes while allowing branch/upstream/HEAD
    // metadata to advance even when the compared text is identical.
    if (result.kind === "ready" && group.result?.kind === "ready" && result.snapshot.id === group.result.snapshot.id) {
      result = { ...result, snapshot: { ...result.snapshot, files: group.result.snapshot.files } };
    }
    group.result = result;
    this.broadcast(group, false, result);
  }

  refresh(owner: number, id: string): void {
    const sub = this.subscribers.get(this.key(owner, id));
    if (sub?.group) this.invalidate(sub.group);
    else if (sub) void this.bind(sub);
  }
  mutationContext(owner: number, subscriptionId: string, snapshotId: string): { snapshot: GitSnapshot; projectRoot: string } {
    const sub = this.subscribers.get(this.key(owner, subscriptionId));
    const result = sub?.group?.result;
    if (!sub || result?.kind !== "ready" || result.snapshot.id !== snapshotId) throw new GitReadError("staleSnapshot", "This Git comparison is no longer active");
    return { snapshot: result.snapshot, projectRoot: sub.request.projectRoot };
  }
  refreshOwner(owner: number): void {
    const groups = new Set<ComparisonGroup>();
    for (const sub of this.subscribers.values()) if (sub.owner === owner && sub.group) groups.add(sub.group);
    for (const group of groups) this.invalidate(group);
  }
  unsubscribe(owner: number, id: string): void {
    const key = this.key(owner, id);
    const sub = this.subscribers.get(key);
    if (!sub) return;
    this.subscribers.delete(key);
    const group = sub.group;
    if (!group) return;
    group.subscribers.delete(sub);
    if (group.subscribers.size) return;
    clearTimeout(group.timer); group.controller?.abort();
    group.project.groups.delete(gitReviewQueryKey(group.query));
    if (!group.project.groups.size) {
      group.project.watcher.close();
      this.projects.delete(group.project.root);
    }
  }
  releaseOwner(owner: number): void {
    for (const sub of this.subscribers.values()) if (sub.owner === owner) this.unsubscribe(owner, sub.request.subscriptionId);
  }
  close(): void {
    for (const sub of this.subscribers.values()) this.unsubscribe(sub.owner, sub.request.subscriptionId);
    this.closed = true;
  }
  /** Counts used by diagnostics and Electron smoke tests; never includes file contents. */
  stats(): { projects: number; subscriptions: number; reads: number } {
    return { projects: this.projects.size, subscriptions: this.subscribers.size,
      reads: [...this.projects.values()].reduce((sum, project) => sum + [...project.groups.values()].filter((group) => group.controller).length, 0) };
  }
}
