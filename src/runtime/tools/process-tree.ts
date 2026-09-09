/**
 * 子进程树回收。
 *
 * 命令以 detached 方式启动，普通 `child.kill()` 杀不掉 shell 派生的后代；
 * 这里统一按进程组回收，并在 worker 退出时清理所有已跟踪的子进程。
 */

import { execFileSync, type ChildProcess } from "node:child_process";

interface TrackedRecord {
  child: ChildProcess;
  pgid?: number;
}

const tracked = new Set<TrackedRecord>();
let hooksInstalled = false;

/** 跟踪 detached 子进程，便于 worker 退出时统一回收。 */
export function trackDetachedChild(child: ChildProcess): void {
  installProcessLifetimeHooks();
  const pgid = child.pid ? processGroupId(child.pid) : undefined;
  const record: TrackedRecord = { child, ...(pgid !== undefined ? { pgid } : {}) };
  tracked.add(record);
  refreshProcessGroup(record);
  const refreshTimer = setTimeout(() => refreshProcessGroup(record), 25);
  refreshTimer.unref();
  const drop = () => {
    clearTimeout(refreshTimer);
    wipeTrackedChild(record, "SIGKILL");
    const timer = setTimeout(() => wipeTrackedChild(record, "SIGKILL"), 50);
    timer.unref();
    tracked.delete(record);
  };
  child.once("exit", drop);
  child.once("error", drop);
}

function refreshProcessGroup(record: TrackedRecord): void {
  if (record.child.pid === undefined) return;
  const pgid = processGroupId(record.child.pid);
  if (pgid !== undefined && pgid !== processGroupId(process.pid)) record.pgid = pgid;
}

/** 杀掉所有已跟踪的 detached 子进程及其后代。 */
export function wipeTrackedChildren(signal: NodeJS.Signals = "SIGKILL"): void {
  for (const record of [...tracked]) {
    wipeTrackedChild(record, signal);
    tracked.delete(record);
  }
}

/** 递归杀掉 pid 的后代，再杀 pid 本身；同时尝试进程组 `-pid`。 */
export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
    return;
  }
  for (const child of listChildPids(pid)) killProcessTree(child, signal);
  try {
    process.kill(-pid, signal);
  } catch {
    // not a group leader / already gone
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}

export function listChildPids(pid: number): number[] {
  if (process.platform === "win32" || !Number.isFinite(pid) || pid <= 0) return [];
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return [];
    return out
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

function wipeTrackedChild(record: TrackedRecord, signal: NodeJS.Signals): void {
  if (record.child.pid !== undefined) killProcessTree(record.child.pid, signal);
  if (record.pgid !== undefined) killProcessGroup(record.pgid, signal);
}

function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32" || !Number.isFinite(pgid) || pgid <= 0) return;
  if (pgid === processGroupId(process.pid)) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    // already gone
  }
}

function processGroupId(pid: number): number | undefined {
  if (process.platform === "win32" || !Number.isFinite(pid) || pid <= 0) return undefined;
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const pgid = Number(out);
    return Number.isFinite(pgid) && pgid > 0 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

function installProcessLifetimeHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const wipe = () => wipeTrackedChildren("SIGKILL");
  process.once("exit", wipe);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => {
      wipe();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}
