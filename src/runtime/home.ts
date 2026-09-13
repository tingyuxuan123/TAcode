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
import { randomUUID } from "node:crypto";
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
export async function initializeTacodeHome(options: { deferHistory?: boolean } = {}): Promise<string> {
  const home = getTacodeHome();
  // 显式指定数据目录（TACODE_HOME）时不自动迁移：路径是用户自己定的。
  if (tacodeEnv("HOME") === undefined) {
    if (options.deferHistory) await migrateLegacySettings(home, getLegacyTacodeHome());
    else await migrateLegacyHome(home, getLegacyTacodeHome());
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
  if (!options.deferHistory) await partitionExistingSessions(sessions);
  return home;
}

/** 首屏只迁入顶层设置/索引，目录中的大批历史交给后台整理。 */
async function migrateLegacySettings(home: string, legacy: string): Promise<void> {
  if (home === legacy || await pathExists(path.join(home, MIGRATION_MARKER))) return;
  const entries = await fs.readdir(legacy, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (!entries.length) return;
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  for (const entry of entries) if (entry.isFile() && entry.name !== MIGRATION_MARKER) {
    await copyLegacyTree(path.join(legacy, entry.name), path.join(home, entry.name));
  }
}

export interface HomeMaintenanceOptions {
  signal?: AbortSignal;
  onSession?(session: PartitionedSessionPath, progress: { completed: number; total: number }): Promise<void> | void;
}

/** 可中断、可重入；每次仍发现新文件，不使用永久的“历史已整理”标记。 */
export async function maintainTacodeHome(options: HomeMaintenanceOptions = {}): Promise<void> {
  options.signal?.throwIfAborted();
  if (tacodeEnv("HOME") === undefined) await migrateLegacyHome(getTacodeHome(), getLegacyTacodeHome(), options);
  await partitionExistingSessions(getTacodeSessionsDir(), options);
}

/**
 * 产品改名时把旧数据目录整目录拷贝到新目录。
 *
 * 逐文件发布完整副本，目标里已存在的文件保留，不覆盖。
 * 只读旧目录，因为它是回退路径。旧目录里的会话转录用硬链接在「扁平运行时路径」与
 * 「日期分区路径」间共享 inode，拷贝后会变成各自独立的文件，两条路径仍然都可读。
 *
 * 失败不写标记，下次启动重试；目标只包含已经完整复制的文件。
 *
 * @returns 是否真的执行了拷贝（已有标记、旧目录不存在、或新=旧时为 `false`）。
 */
export async function migrateLegacyHome(home: string, legacy: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
  if (home === legacy) return false;
  if (await pathExists(path.join(home, MIGRATION_MARKER))) return false;
  const legacyStat = await statOrUndefined(legacy);
  if (!legacyStat?.isDirectory()) return false;
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await copyLegacyTree(legacy, home, options.signal, true);
  await fs
    .writeFile(
      path.join(home, MIGRATION_MARKER),
      `${JSON.stringify({ from: legacy, at: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    )
    .catch(() => undefined);
  return true;
}

/** 临时文件完整写好后才以排他硬链接发布，退出不会留下“已存在”的半份目标。 */
async function copyLegacyTree(source: string, target: string, signal?: AbortSignal, root = false): Promise<void> {
  signal?.throwIfAborted();
  const stat = await fs.lstat(source);
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    for (const entry of await fs.readdir(source)) {
      if ((root && (entry === MIGRATION_MARKER || entry === "side-chats" || entry.startsWith(".side-chats-cleanup-"))) || entry.startsWith(".tacode-migrate-")) continue;
      await copyLegacyTree(path.join(source, entry), path.join(target, entry), signal);
    }
    return;
  }
  if (await pathExists(target)) return;
  if (stat.isSymbolicLink()) {
    try { await fs.symlink(await fs.readlink(source), target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return;
  }
  if (!stat.isFile()) return;
  const temporary = path.join(path.dirname(target), `.tacode-migrate-${randomUUID()}`);
  try {
    await fs.copyFile(source, temporary);
    await fs.chmod(temporary, 0o600).catch(() => undefined);
    signal?.throwIfAborted();
    try { await fs.link(temporary, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
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
 * 把扁平转录加入日期分区，并保留原路径。两个路径指向同一 inode，
 * 因此内容不重复，Pi 仍可正常 resume。
 */
const partitionCache = new Map<string, { signature: string; result: PartitionedSessionPath }>();
const partitionJobs = new Map<string, Promise<PartitionedSessionPath>>();

export function partitionSessionFile(file: string, sessions = getTacodeSessionsDir()): Promise<PartitionedSessionPath> {
  const key = path.resolve(file);
  const current = partitionJobs.get(key);
  if (current) return current;
  const job = partitionFile(key, sessions).finally(() => { if (partitionJobs.get(key) === job) partitionJobs.delete(key); });
  partitionJobs.set(key, job);
  return job;
}

async function partitionFile(file: string, sessions: string): Promise<PartitionedSessionPath> {
  const runtimePath = path.resolve(file);
  const relative = path.relative(sessions, runtimePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { runtimePath, storagePath: runtimePath };
  }
  if (path.dirname(relative) !== ".") {
    return { runtimePath: path.join(sessions, path.basename(file)), storagePath: runtimePath };
  }
  const stat = await fs.stat(runtimePath);
  const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const cached = partitionCache.get(runtimePath);
  if (cached?.signature === signature) {
    const stored = await statOrUndefined(cached.result.storagePath);
    if (stored && sameFile(stat, stored)) return cached.result;
  }
  const remember = (storagePath: string) => {
    const result = { runtimePath, storagePath };
    partitionCache.set(runtimePath, { signature, result });
    while (partitionCache.size > 10_000) partitionCache.delete(partitionCache.keys().next().value!);
    return result;
  };
  const timestamp = await sessionTimestamp(runtimePath, stat.mtime);
  const date = timestamp.toISOString().slice(0, 10).split("-");
  const storagePath = path.join(sessions, ...date, path.basename(runtimePath));
  await fs.mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(storagePath), 0o700).catch(() => undefined);
  const existing = await statOrUndefined(storagePath);
  if (existing) {
    if (sameFile(stat, existing)) {
      await fs.chmod(runtimePath, 0o600).catch(() => undefined);
      return remember(storagePath);
    }
    // 路径冲突时绝不覆盖不同的转录。
    return { runtimePath, storagePath: runtimePath };
  }
  try {
    // 先建存储硬链接，不移动原文件：任意时刻退出都至少留下可恢复的运行路径。
    await fs.link(runtimePath, storagePath);
    await fs.chmod(storagePath, 0o600).catch(() => undefined);
    return remember(storagePath);
  } catch {
    const stored = await statOrUndefined(storagePath);
    if (stored && sameFile(stat, stored)) return remember(storagePath);
    // 某些网络文件系统不支持硬链接；保留原扁平文件比复制或破坏 resume 语义更安全。
    return { runtimePath, storagePath: runtimePath };
  }
}

export async function partitionExistingSessions(
  sessions: string = getTacodeSessionsDir(),
  options: HomeMaintenanceOptions = {},
): Promise<PartitionedSessionPath[]> {
  let entries;
  try {
    entries = await fs.readdir(sessions, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => path.join(sessions, entry.name));
  const known = new Set(files.map((file) => path.basename(file)));
  // 恢复旧版 rename→link 之间退出或手动删除留下的日期目录孤立文件。
  const recover = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      options.signal?.throwIfAborted();
      const storagePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await recover(storagePath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && !known.has(entry.name)) {
        const runtimePath = path.join(sessions, entry.name);
        try { await fs.link(storagePath, runtimePath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        known.add(entry.name);
        files.push(runtimePath);
      }
    }
  };
  for (const entry of entries) if (entry.isDirectory() && /^\d{4}$/.test(entry.name)) await recover(path.join(sessions, entry.name));
  const partitioned: PartitionedSessionPath[] = [];
  for (const file of files) {
    options.signal?.throwIfAborted();
    let result: PartitionedSessionPath;
    try { result = await partitionSessionFile(file, sessions); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    partitioned.push(result);
    await options.onSession?.(result, { completed: partitioned.length, total: files.length });
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
