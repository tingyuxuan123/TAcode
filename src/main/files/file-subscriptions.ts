import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FileSubscribeRequest, FileUpdate } from "../../shared/files";
import { fileDigest } from "./file-page";
import { fileFailure, ProjectFileError, ProjectFilePaths } from "./file-path";

interface Subscription {
  owner: number; request: FileSubscribeRequest; sequence: number; emit(update: FileUpdate): void;
  stamp?: string; busy?: Promise<void>;
}
interface RootWatch {
  watcher?: FSWatcher; mode: "native" | "polling"; paths: Set<string>; unknown: boolean;
  timer?: ReturnType<typeof setTimeout>; poll: ReturnType<typeof setInterval>;
}
export interface FileSubscriptionOptions {
  paths: ProjectFilePaths;
  changed(root: string, paths?: string[]): void;
  watch?: typeof watch;
  pollMs?: number;
}

/** A root watcher is shared by path subscribers; periodic fingerprints also recover deleted/recreated parents. */
export class FileSubscriptions {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly roots = new Map<string, RootWatch>();
  private readonly reads = new Set<Promise<string>>();
  private readonly starting = new Set<Promise<{ mode: "native" | "polling" }>>();
  private closed = false;
  constructor(private readonly options: FileSubscriptionOptions) {}
  subscribe(owner: number, request: FileSubscribeRequest, emit: (update: FileUpdate) => void): Promise<{ mode: "native" | "polling" }> {
    const pending = this.subscribeFlow(owner, request, emit);
    this.starting.add(pending);
    void pending.catch(() => {}).finally(() => this.starting.delete(pending));
    return pending;
  }
  private async subscribeFlow(owner: number, request: FileSubscribeRequest, emit: (update: FileUpdate) => void): Promise<{ mode: "native" | "polling" }> {
    if (this.closed) throw new ProjectFileError("cancelled", "File service is closed");
    const key = this.key(owner, request.subscriptionId);
    this.unsubscribe(owner, request.subscriptionId);
    if ([...this.subscriptions.values()].filter((item) => item.owner === owner).length >= 128) throw new ProjectFileError("invalidRequest", "Too many file subscriptions");
    const subscription: Subscription = { owner, request, emit, sequence: 0 };
    this.subscriptions.set(key, subscription);
    try {
      const bound = await this.options.paths.resolve(request, request.target === "directory");
      if (!this.alive(subscription) || this.closed) throw new ProjectFileError("cancelled", "File subscription was cancelled");
      subscription.request = { ...request, projectRoot: bound.projectRoot, path: bound.path };
      subscription.stamp = await this.fingerprint(subscription);
      if (this.subscriptions.get(key) !== subscription || this.closed) throw new ProjectFileError("cancelled", "File subscription was cancelled");
      const root = this.start(bound.projectRoot);
      return { mode: root.mode };
    } catch (error) { if (this.subscriptions.get(key) === subscription) this.unsubscribe(owner, request.subscriptionId); throw error; }
  }
  unsubscribe(owner: number, id: string): void {
    this.subscriptions.delete(this.key(owner, id));
    this.prune();
  }
  releaseOwner(owner: number): void { for (const [key, item] of this.subscriptions) if (item.owner === owner) this.subscriptions.delete(key); this.prune(); }
  close(): void { this.closed = true; this.subscriptions.clear(); this.prune(); }
  stats(): { subscriptions: number; roots: number; reads: number } {
    return { subscriptions: this.subscriptions.size, roots: this.roots.size, reads: this.reads.size + this.starting.size };
  }
  async idle(): Promise<void> { await Promise.allSettled([...this.reads, ...this.starting]); }
  private key(owner: number, id: string): string { return `${owner}:${id}`; }
  private alive(item: Subscription): boolean { return this.subscriptions.get(this.key(item.owner, item.request.subscriptionId)) === item; }
  private emit(item: Subscription, update: Pick<FileUpdate, "kind" | "paths" | "error" | "mode">): void {
    if (this.alive(item)) item.emit({ projectRoot: item.request.projectRoot, path: item.request.path, subscriptionId: item.request.subscriptionId, sequence: ++item.sequence, ...update });
  }
  private prune(): void {
    for (const [root, watch] of this.roots) if (![...this.subscriptions.values()].some((item) => item.request.projectRoot === root)) {
      watch.watcher?.close(); clearTimeout(watch.timer); clearInterval(watch.poll); this.roots.delete(root);
    }
  }
  private start(root: string): RootWatch {
    const existing = this.roots.get(root); if (existing) return existing;
    const entry: RootWatch = { mode: "native", paths: new Set(), unknown: false,
      poll: setInterval(() => { for (const item of this.subscriptions.values()) if (item.request.projectRoot === root) this.check(item); }, this.options.pollMs ?? 1000) };
    entry.poll.unref(); this.roots.set(root, entry);
    const failed = () => {
      if (this.roots.get(root) !== entry) return;
      entry.watcher?.close(); entry.watcher = undefined; entry.mode = "polling";
      for (const item of this.subscriptions.values()) if (item.request.projectRoot === root) this.emit(item, { kind: "error", mode: "polling", error: { code: "failed", message: "Native file monitoring failed; polling is active" } });
    };
    try {
      entry.watcher = (this.options.watch ?? watch)(root, { persistent: false, recursive: true }, (_event, filename) => {
        if (this.roots.get(root) !== entry) return;
        const relative = filename?.toString().split(path.sep).join("/");
        if (relative && entry.paths.size < 2000) entry.paths.add(relative); else entry.unknown = true;
        if (entry.timer) return;
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          if (this.roots.get(root) !== entry) return;
          const paths = entry.unknown ? undefined : [...entry.paths]; entry.paths.clear(); entry.unknown = false;
          this.options.changed(root, paths);
          for (const item of this.subscriptions.values()) {
            if (item.request.projectRoot !== root) continue;
            const target = item.request.path;
            if (!paths || !target || paths.some((value) => value === target || target.startsWith(`${value}/`) || (item.request.target === "directory" && value.startsWith(`${target}/`)))) {
              this.check(item, paths, true);
            }
          }
        }, 100);
        entry.timer.unref();
      });
      entry.watcher.on("error", failed);
    } catch { failed(); }
    return entry;
  }
  private check(item: Subscription, paths?: string[], nativeEvent = false): void {
    if (item.busy) return;
    item.busy = (async () => {
      try {
        const next = await this.fingerprint(item);
        if (!this.alive(item)) return;
        if (next !== item.stamp || (nativeEvent && item.request.target === "directory")) {
          this.options.changed(item.request.projectRoot, [item.request.path]);
          this.emit(item, { kind: "changed", paths: paths ?? [item.request.path], mode: this.roots.get(item.request.projectRoot)?.mode });
        }
        item.stamp = next;
      } catch (error) { this.emit(item, { kind: "error", error: fileFailure(error).error }); }
    })().finally(() => { item.busy = undefined; });
  }
  private fingerprint(item: Subscription): Promise<string> {
    const pending = this.snapshot(item);
    this.reads.add(pending);
    void pending.catch(() => {}).finally(() => this.reads.delete(pending));
    return pending;
  }
  private async snapshot(item: Subscription): Promise<string> {
    const bound = await this.options.paths.resolve(item.request, item.request.target === "directory");
    if (!bound.exists) return "missing";
    const stat = await fs.stat(bound.file, { bigint: true });
    const identity = `${bound.file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
    if (item.request.target === "document") {
      if (!stat.isFile()) throw new ProjectFileError("notFile", "Not a regular file");
      return identity;
    }
    if (!stat.isDirectory()) throw new ProjectFileError("notDirectory", "Not a directory");
    if (this.roots.get(item.request.projectRoot)?.mode !== "polling") {
      const entries = await fs.readdir(bound.file, { withFileTypes: true });
      return fileDigest(`${identity}:${JSON.stringify(entries.map((entry) => [entry.name, entry.isDirectory(), entry.isSymbolicLink()]).sort())}`);
    }
    const entries: string[] = [];
    const walk = async (directory: string) => {
      for await (const entry of await fs.opendir(directory)) {
        const name = path.join(directory, entry.name);
        const stat = await fs.lstat(name, { bigint: true });
        entries.push(`${name}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`);
        if (entry.isDirectory()) await walk(name);
      }
    };
    await walk(bound.file);
    return fileDigest(`${identity}:${JSON.stringify(entries.sort())}`);
  }
}
