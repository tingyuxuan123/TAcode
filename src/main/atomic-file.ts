import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

/**
 * 崩溃安全的 JSON 持久化。
 *
 * 所有配置文件都走同一条路径：同目录临时文件 → fsync → rename。
 * rename 在同一文件系统上是原子的，因此读者要么看到完整旧版本，要么看到完整
 * 新版本，不会读到被截断的半个 JSON。同一路径的并发写入按提交顺序排队，
 * 避免旧快照覆盖新快照。
 */

/** 每个目标路径一条写队列，保证并发写入按调用顺序提交。 */
const writeQueues = new Map<string, Promise<unknown>>();

export interface AtomicWriteOptions {
  /** 文件权限，默认 0o600（仅当前用户可读写）。 */
  mode?: number;
  /** 是否在 rename 前后 fsync 文件与目录，默认开启。 */
  fsync?: boolean;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // 部分平台/文件系统不支持目录 fsync，尽力而为即可。
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function performWrite(
  target: string,
  data: string | Buffer,
  options: AtomicWriteOptions,
): Promise<void> {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const mode = options.mode ?? 0o600;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temp, "w", mode);
    await handle.writeFile(data);
    if (options.fsync !== false) await handle.sync().catch(() => undefined);
    await handle.close();
    handle = undefined;
    await rename(temp, target);
    if (options.fsync !== false) await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 原子写入字符串/字节；同一路径的调用串行提交。 */
export function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const target = path.resolve(filePath);
  const run = () => performWrite(target, data, options);
  const previous = writeQueues.get(target) ?? Promise.resolve();
  const next = previous.then(run, run);
  // 队列本身吞掉失败，避免链上未处理的 rejection；调用方仍拿到真实的 next。
  writeQueues.set(target, next.catch(() => undefined));
  return next;
}

/** 原子写入 JSON（缩进 2 + 结尾换行，与既有文件格式一致）。 */
export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  return writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export interface JsonFileResult<T> {
  value: T;
  /** ok：正常读取；missing：首次运行；recovered：文件损坏，已备份并回退默认值。 */
  status: "ok" | "missing" | "recovered";
  /** 损坏文件的备份路径（`<name>.<时间戳>.corrupt`）。 */
  backupPath?: string;
  /** 损坏原因，用于诊断提示。 */
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把损坏文件移到带时间戳的 `.corrupt` 备份，返回备份路径。 */
export async function backupCorruptFile(target: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${target}.${stamp}.corrupt`;
  try {
    await rename(target, backupPath);
  } catch {
    // rename 失败（例如跨设备或权限问题）时退化为复制，原文件保留给用户排查。
    await copyFile(target, backupPath);
  }
  return backupPath;
}

/**
 * 读取 JSON 配置；损坏时备份为 `.corrupt` 并返回安全默认值，绝不静默吞掉用户配置。
 *
 * `normalize` 用于 schema 校验：返回 `undefined` 视为内容非法（同样走备份+默认值）。
 */
export async function readJsonFile<T>(
  filePath: string,
  fallback: () => T,
  normalize?: (raw: unknown) => T | undefined,
): Promise<JsonFileResult<T>> {
  const target = path.resolve(filePath);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { value: fallback(), status: "missing" };
    return { value: fallback(), status: "recovered", error: errorMessage(error) };
  }
  if (!raw.trim()) {
    // 空文件是典型的“写到一半掉电”，同样按损坏处理。
    const backupPath = await backupCorruptFile(target).catch(() => undefined);
    return {
      value: fallback(),
      status: "recovered",
      ...(backupPath ? { backupPath } : {}),
      error: "file is empty",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const backupPath = await backupCorruptFile(target).catch(() => undefined);
    return {
      value: fallback(),
      status: "recovered",
      ...(backupPath ? { backupPath } : {}),
      error: errorMessage(error),
    };
  }
  const value = normalize ? normalize(parsed) : (parsed as T);
  if (value === undefined) {
    const backupPath = await backupCorruptFile(target).catch(() => undefined);
    return {
      value: fallback(),
      status: "recovered",
      ...(backupPath ? { backupPath } : {}),
      error: "unexpected JSON shape",
    };
  }
  return { value, status: "ok" };
}

// ---------- 配置恢复提示（主进程收集，渲染层启动时取走显示） ----------

const configNotices: string[] = [];
const MAX_NOTICES = 20;

/** 记录一条“已保留损坏文件”提示，供 UI 展示一次。 */
export function noteConfigRecovered(label: string, result: JsonFileResult<unknown>): void {
  if (result.status !== "recovered") return;
  const detail = result.backupPath
    ? `已保留损坏文件：${path.basename(result.backupPath)}`
    : "原文件无法备份";
  configNotices.push(`${label} 配置已损坏（${result.error ?? "未知原因"}）。${detail}，已回退到安全默认值。`);
  if (configNotices.length > MAX_NOTICES) configNotices.shift();
}

/** 取走并清空待展示的配置恢复提示。 */
export function consumeConfigNotices(): string[] {
  return configNotices.splice(0, configNotices.length);
}

/**
 * 受保护消息文件名：由 canonical session path 的哈希派生，保证不同会话不碰撞，
 * 同时保留可读前缀便于人工排查。
 */
export function protectedMessageFileName(sessionPath: string): string {
  const resolved = path.resolve(sessionPath);
  const canonical = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const base = path.basename(canonical).replace(/\.jsonl$/i, "") || "session";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `${safe}-${hash}.jsonl`;
}
