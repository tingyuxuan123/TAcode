/**
 * TACode Runtime 数据目录与 Pi 会话文件分区。
 *
 * 职责：
 * - 把 Pi 的数据目录（`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`）
 *   指向 TACode 自己的目录，避免读写用户全局 `~/.pi/agent`。
 * - 会话转录按 `sessions/YYYY/MM/DD/*.jsonl` 分区存放，同时保留扁平硬链接，
 *   兼容 Pi 当前的 `--session` / `--resume` 实现。
 *
 * 数据目录默认 `~/.tacode`，可用 `TACODE_HOME` 覆盖。产品改名过来时，旧 `~/.tether`
 * 会在首次启动整目录拷贝到新目录；旧目录原样保留，确认无误后可手动删除。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { tacodeEnv } from "./env.js";

/** 当前数据目录名；再改名只需改这里。 */
const HOME_DIR_NAME = ".tacode";
/** 旧版数据目录名，只作一次性迁移的来源。 */
const LEGACY_HOME_DIR_NAME = ".tether";
/** 迁移完成标记；存在即跳过，避免每次启动重复拷贝。 */
const MIGRATION_MARKER = ".migrated.json";

export function getTacodeHome(): string {
  return resolveHomePath(tacodeEnv("HOME") ?? path.join(os.homedir(), HOME_DIR_NAME));
}

/** 旧版数据目录 `~/.tether`；仅迁移时读取，TACode 不再往这里写。 */
export function getLegacyTacodeHome(): string {
  return path.join(os.homedir(), LEGACY_HOME_DIR_NAME);
}

export function getTacodeSessionsDir(): string {
  return resolveHomePath(tacodeEnv("SESSIONS_DIR") ?? path.join(getTacodeHome(), "sessions"));
}

export function getTacodeArchivedSessionsDir(): string {
  return resolveHomePath(
    tacodeEnv("ARCHIVED_SESSIONS_DIR") ?? path.join(getTacodeHome(), "archived_sessions"),
  );
}

/** 把 Pi 的运行时数据目录限定在 TACode 自有路径内，并准备目录。 */
export async function initializeTacodeHome(): Promise<string> {
  const home = getTacodeHome();
  // 显式指定数据目录（TACODE_HOME）时不自动迁移：路径是用户自己定的。
  if (tacodeEnv("HOME") === undefined) {
    await migrateLegacyHome(home, getLegacyTacodeHome());
  }
  const sessions = getTacodeSessionsDir();
  process.env.PI_CODING_AGENT_DIR = home;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessions;
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.chmod(home, 0o700).catch(() => undefined);
  await fs.mkdir(sessions, { recursive: true, mode: 0o700 });
  await fs.chmod(sessions, 0o700).catch(() => undefined);
  await fs.mkdir(getTacodeArchivedSessionsDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(getTacodeArchivedSessionsDir(), 0o700).catch(() => undefined);
  await ensureWebSearchDefaults(home);
  await partitionExistingSessions(sessions);
  return home;
}

/**
 * 产品改名时把旧数据目录整目录拷贝到新目录。
 *
 * 用 `force: false` 合并：目标里已存在的文件（含上次中断留下的部分结果）保留，不覆盖。
 * 只读旧目录，因为它是回退路径。旧目录里的会话转录用硬链接在「扁平运行时路径」与
 * 「日期分区路径」间共享 inode，拷贝后会变成各自独立的文件，两条路径仍然都可读。
 *
 * 失败不写标记，下次启动重试；目标最多只是旧目录的部分合并，不会丢数据。
 *
 * @returns 是否真的执行了拷贝（已有标记、旧目录不存在、或新=旧时为 `false`）。
 */
export async function migrateLegacyHome(home: string, legacy: string): Promise<boolean> {
  if (home === legacy) return false;
  if (await pathExists(path.join(home, MIGRATION_MARKER))) return false;
  const legacyStat = await statOrUndefined(legacy);
  if (!legacyStat?.isDirectory()) return false;
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await fs.cp(legacy, home, { recursive: true, force: false, errorOnExist: false });
  } catch {
    return false;
  }
  await fs
    .writeFile(
      path.join(home, MIGRATION_MARKER),
      `${JSON.stringify({ from: legacy, at: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    )
    .catch(() => undefined);
  return true;
}

/** 桌面/RPC 模式跳过 TUI 引导，但不覆盖已有配置。 */
async function ensureWebSearchDefaults(home: string): Promise<void> {
  const file = path.join(home, "web-search.json");
  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, `${JSON.stringify({ workflow: "auto-summary" }, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}

export interface PartitionedSessionPath {
  /** 保留给 Pi `--resume` / `session-dir` 的扁平硬链接。 */
  runtimePath: string;
  /** 规范转录路径：`sessions/YYYY/MM/DD/*.jsonl`。 */
  storagePath: string;
}

/**
 * 把扁平转录移入日期分区，并保留扁平硬链接。两个路径指向同一 inode，
 * 因此内容不重复，Pi 仍可正常 resume。
 */
export async function partitionSessionFile(file: string): Promise<PartitionedSessionPath> {
  const sessions = getTacodeSessionsDir();
  const runtimePath = path.resolve(file);
  const relative = path.relative(sessions, runtimePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { runtimePath, storagePath: runtimePath };
  }
  if (path.dirname(relative) !== ".") {
    return { runtimePath: path.join(sessions, path.basename(file)), storagePath: runtimePath };
  }
  const stat = await fs.stat(runtimePath);
  const timestamp = await sessionTimestamp(runtimePath, stat.mtime);
  const date = timestamp.toISOString().slice(0, 10).split("-");
  const storagePath = path.join(sessions, ...date, path.basename(runtimePath));
  await fs.mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(storagePath), 0o700).catch(() => undefined);
  const existing = await statOrUndefined(storagePath);
  if (existing) {
    if (sameFile(stat, existing)) {
      await fs.chmod(runtimePath, 0o600).catch(() => undefined);
      return { runtimePath, storagePath };
    }
    // 路径冲突时绝不覆盖不同的转录。
    return { runtimePath, storagePath: runtimePath };
  }
  try {
    await fs.rename(runtimePath, storagePath);
    try {
      await fs.link(storagePath, runtimePath);
    } catch (error) {
      await fs.rename(storagePath, runtimePath).catch(() => undefined);
      throw error;
    }
    await fs.chmod(storagePath, 0o600).catch(() => undefined);
    return { runtimePath, storagePath };
  } catch {
    // 某些网络文件系统不支持硬链接；保留原扁平文件比复制或破坏 resume 语义更安全。
    return { runtimePath, storagePath: runtimePath };
  }
}

export async function partitionExistingSessions(
  sessions: string = getTacodeSessionsDir(),
): Promise<PartitionedSessionPath[]> {
  let entries;
  try {
    entries = await fs.readdir(sessions, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const partitioned: PartitionedSessionPath[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    partitioned.push(await partitionSessionFile(path.join(sessions, entry.name)));
  }
  return partitioned;
}

/**
 * Pi 通过扁平运行时路径 resume。硬链接丢失时从分区文件重建，
 * 避免打开会话时得到空转录。
 */
export async function ensureSessionRuntimeLink(
  sessionPath: string,
  storagePath: string = sessionPath,
): Promise<string> {
  const runtime = path.resolve(sessionPath);
  const storage = path.resolve(storagePath);
  const storageStat = await statOrUndefined(storage);
  if (!storageStat) return runtime;
  const runtimeStat = await statOrUndefined(runtime);
  if (runtimeStat && sameFile(runtimeStat, storageStat)) return runtime;
  if (runtimeStat) {
    await fs.unlink(runtime).catch(() => undefined);
  } else {
    await fs.mkdir(path.dirname(runtime), { recursive: true, mode: 0o700 }).catch(() => undefined);
  }
  try {
    await fs.link(storage, runtime);
  } catch {
    return storage;
  }
  await fs.chmod(runtime, 0o600).catch(() => undefined);
  return runtime;
}

function resolveHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

async function sessionTimestamp(file: string, fallback: Date): Promise<Date> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    if (!firstLine) return fallback;
    const header: unknown = JSON.parse(firstLine);
    if (isRecord(header) && typeof header.timestamp === "string") {
      const timestamp = new Date(header.timestamp);
      if (!Number.isNaN(timestamp.getTime())) return timestamp;
    }
    return fallback;
  } catch {
    return fallback;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function statOrUndefined(file: string): Promise<Awaited<ReturnType<typeof fs.stat>> | undefined> {
  try {
    return await fs.stat(file);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function sameFile(
  left: Awaited<ReturnType<typeof fs.stat>>,
  right: Awaited<ReturnType<typeof fs.stat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error;
}
