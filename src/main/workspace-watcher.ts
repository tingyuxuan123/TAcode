import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

interface WatchEntry { watcher?: FSWatcher; timer?: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setTimeout>; attempts: number; paths: Set<string>; unknown: boolean }

/** 保留当前及最近查看项目的监听，预览其他项目时不抢走主工作区的监听。 */
export class WorkspaceWatchers {
  private roots = new Map<string, WatchEntry>();
  constructor(private readonly changed: (root: string, paths?: string[]) => void, private readonly failed: () => void = () => {}) {}
  watch(root: string): boolean {
    root = path.resolve(root);
    const previous = this.roots.get(root);
    if (previous) { this.roots.delete(root); this.roots.set(root, previous); return false; }
    const entry: WatchEntry = { attempts: 0, paths: new Set(), unknown: false };
    this.roots.set(root, entry);
    this.start(root, entry);
    while (this.roots.size > 3) {
      const oldest = this.roots.keys().next().value!;
      this.stop(this.roots.get(oldest)!);
      this.roots.delete(oldest);
    }
    return true;
  }
  close(): void { for (const entry of this.roots.values()) this.stop(entry); this.roots.clear(); }
  private stop(entry: WatchEntry): void { entry.watcher?.close(); clearTimeout(entry.timer); clearTimeout(entry.retry); }
  private start(root: string, entry: WatchEntry): void {
    if (this.roots.get(root) !== entry) return;
    const failed = () => {
      if (this.roots.get(root) !== entry) return;
      entry.watcher?.close(); entry.watcher = undefined;
      clearTimeout(entry.retry);
      if (++entry.attempts > 3) { this.stop(entry); this.roots.delete(root); this.failed(); return; }
      entry.retry = setTimeout(() => this.start(root, entry), 500 * 2 ** entry.attempts);
      entry.retry.unref();
    };
    try {
      entry.watcher = watch(root, { persistent: false, recursive: true }, (_event, filename) => {
        if (this.roots.get(root) !== entry) return;
        const relative = filename?.replaceAll("\\", "/");
        if (relative?.split("/").some((part) => [".git", "node_modules", ".pnpm-store"].includes(part))) return;
        if (relative && entry.paths.size < 2000) entry.paths.add(relative);
        else entry.unknown = true;
        if (entry.timer) return;
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          if (this.roots.get(root) !== entry) return;
          const paths = entry.unknown ? undefined : [...entry.paths];
          entry.paths.clear(); entry.unknown = false;
          this.changed(root, paths);
        }, 200);
      });
      entry.watcher.on("error", failed);
      if (entry.attempts) this.changed(root);
    } catch { failed(); }
  }
}
