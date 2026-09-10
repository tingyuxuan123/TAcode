/**
 * TACode Runtime 会话索引（SQLite）。
 *
 * JSONL 转录是唯一事实来源；SQLite 只是索引/运行时状态层，用于侧边栏列表、
 * 置顶与归档。表结构与 Tether 时代一致，因此可直接复用历史 `state.sqlite`。
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  getTacodeArchivedSessionsDir,
  getTacodeHome,
  getTacodeSessionsDir,
  partitionSessionFile,
  type PartitionedSessionPath,
} from "./home.js";
import { getTacodeStorageSettings } from "./settings.js";
import type { DelegationStatus } from "../shared/delegation.js";

const require = createRequire(import.meta.url);

interface SqliteStatement {
  all(...parameters: unknown[]): unknown[];
  get(...parameters: unknown[]): unknown;
  run(...parameters: unknown[]): { changes: number };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface ThreadRow {
  id: string;
  session_path: string;
  storage_path: string;
  cwd: string;
  title: string;
  preview: string | null;
  provider: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
  pinned: number;
  archived: number;
  file_size: number;
  file_mtime_ms: number;
  parent_session_path: string | null;
  source_delegation_id: string | null;
  delegation_role: string | null;
  delegation_status: DelegationStatus | null;
  delegation_depth: number | null;
  delegation_goal: string | null;
  delegation_report: string | null;
  delegation_error: string | null;
  delegation_completed_at: number | null;
}

export interface TacodeThread {
  id: string;
  sessionPath: string;
  storagePath: string;
  cwd: string;
  title: string;
  preview?: string;
  provider?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  pinned: boolean;
  archived: boolean;
  parentSessionPath?: string;
  sourceDelegationId?: string;
  delegationRole?: string;
  delegationStatus?: DelegationStatus;
  delegationDepth?: number;
  delegationGoal?: string;
  delegationReport?: string;
  delegationError?: string;
  delegationCompletedAt?: string;
}

export interface ListThreadOptions {
  cwd?: string;
  includeArchived?: boolean;
  parentSessionPath?: string;
  sourceDelegationId?: string;
}

export interface DelegatedThreadInput {
  id: string;
  sessionPath: string;
  storagePath?: string;
  cwd: string;
  title: string;
  provider?: string;
  model?: string;
  parentSessionPath: string;
  sourceDelegationId: string;
  delegationRole: string;
  delegationStatus: DelegationStatus;
  delegationDepth: number;
  delegationGoal: string;
  createdAt?: number;
}

export function getTacodeStatePath(): string {
  const sqliteHome = getTacodeStorageSettings().sqliteHome ?? getTacodeHome();
  return path.join(sqliteHome, "state.sqlite");
}

export class TacodeStateStore {
  readonly statePath: string;
  private readonly database: SqliteDatabase;
  private readonly findByPath: SqliteStatement;

  constructor(statePath: string = getTacodeStatePath()) {
    this.statePath = statePath;
    if (statePath !== ":memory:") {
      fsSync.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    }
    const { DatabaseSync: SQLiteDatabase } = require("node:sqlite") as {
      DatabaseSync: new (path: string) => SqliteDatabase;
    };
    this.database = new SQLiteDatabase(statePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        session_path TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        preview TEXT,
        provider TEXT,
        model TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        file_mtime_ms REAL NOT NULL DEFAULT 0,
        parent_session_path TEXT,
        source_delegation_id TEXT,
        delegation_role TEXT,
        delegation_status TEXT,
        delegation_depth INTEGER,
        delegation_goal TEXT,
        delegation_report TEXT,
        delegation_error TEXT,
        delegation_completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS threads_updated_at_idx ON threads(archived, pinned DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS threads_cwd_idx ON threads(cwd, archived, updated_at DESC);
      CREATE INDEX IF NOT EXISTS threads_storage_path_idx ON threads(storage_path);
    `);
    const columns = new Set(
      (this.database.prepare("PRAGMA table_info(threads)").all() as Array<{ name?: unknown }>)
        .map((column) => (typeof column.name === "string" ? column.name : ""))
        .filter(Boolean),
    );
    const migrations: Array<[string, string]> = [
      ["parent_session_path", "TEXT"],
      ["source_delegation_id", "TEXT"],
      ["delegation_role", "TEXT"],
      ["delegation_status", "TEXT"],
      ["delegation_depth", "INTEGER"],
      ["delegation_goal", "TEXT"],
      ["delegation_report", "TEXT"],
      ["delegation_error", "TEXT"],
      ["delegation_completed_at", "INTEGER"],
    ];
    for (const [name, type] of migrations) {
      if (!columns.has(name)) this.database.exec(`ALTER TABLE threads ADD COLUMN ${name} ${type}`);
    }
    this.database.exec(
      "CREATE INDEX IF NOT EXISTS threads_parent_session_idx ON threads(parent_session_path, created_at DESC);" +
      "CREATE UNIQUE INDEX IF NOT EXISTS threads_source_delegation_idx ON threads(source_delegation_id);" +
      "PRAGMA user_version = 2;",
    );
    if (statePath !== ":memory:") fsSync.chmodSync(statePath, 0o600);
    this.findByPath = this.database.prepare(
      "SELECT * FROM threads WHERE session_path = ? OR storage_path = ? LIMIT 1",
    );
  }

  close(): void {
    this.database.close();
  }

  async refresh(): Promise<void> {
    const seen = new Set<string>();
    for (const file of await directJsonlFiles(getTacodeSessionsDir())) {
      const partitioned = await partitionSessionFile(file);
      seen.add(partitioned.storagePath);
      await this.indexFile(partitioned.runtimePath, partitioned.storagePath, false);
    }
    for (const file of await recursiveJsonlFiles(getTacodeArchivedSessionsDir())) {
      seen.add(file);
      await this.indexFile(file, file, true);
    }
    const rows = this.database.prepare("SELECT id, storage_path, source_delegation_id, delegation_status FROM threads").all() as Array<{
      id: string;
      storage_path: string;
      source_delegation_id: string | null;
      delegation_status: string | null;
    }>;
    const remove = this.database.prepare("DELETE FROM threads WHERE id = ?");
    for (const row of rows) {
      if (!seen.has(row.storage_path) && !row.source_delegation_id) remove.run(row.id);
    }
  }

  async indexSession(file: string): Promise<TacodeThread | undefined> {
    const partitioned = await partitionSessionFile(file);
    return this.indexFile(partitioned.runtimePath, partitioned.storagePath, false);
  }

  list(options: ListThreadOptions = {}): TacodeThread[] {
    const where: string[] = [];
    const parameters: unknown[] = [];
    if (!options.includeArchived) where.push("archived = 0");
    if (options.cwd) {
      where.push("cwd = ?");
      parameters.push(path.resolve(options.cwd));
    }
    if (options.parentSessionPath) {
      where.push("parent_session_path = ?");
      parameters.push(path.resolve(options.parentSessionPath));
    }
    if (options.sourceDelegationId) {
      where.push("source_delegation_id = ?");
      parameters.push(options.sourceDelegationId);
    }
    const query = `SELECT * FROM threads${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY pinned DESC, created_at DESC`;
    return (this.database.prepare(query).all(...parameters) as ThreadRow[]).map(rowToThread);
  }

  get(id: string): TacodeThread | undefined {
    const row = this.database.prepare("SELECT * FROM threads WHERE id = ?").get(id) as
      | ThreadRow
      | undefined;
    return row ? rowToThread(row) : undefined;
  }

  findBySessionPath(sessionPath: string): TacodeThread | undefined {
    const row = this.findByPath.get(sessionPath, sessionPath) as ThreadRow | undefined;
    return row ? rowToThread(row) : undefined;
  }

  createDelegatedThread(input: DelegatedThreadInput): TacodeThread {
    const createdAt = input.createdAt ?? Date.now();
    const storagePath = input.storagePath ?? input.sessionPath;
    this.database
      .prepare(`
        INSERT INTO threads (
          id, session_path, storage_path, cwd, title, preview, provider, model,
          created_at, updated_at, message_count, pinned, archived, file_size, file_mtime_ms,
          parent_session_path, source_delegation_id, delegation_role, delegation_status,
          delegation_depth, delegation_goal, delegation_report, delegation_error,
          delegation_completed_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          session_path = excluded.session_path,
          storage_path = excluded.storage_path,
          cwd = excluded.cwd,
          title = excluded.title,
          provider = excluded.provider,
          model = excluded.model,
          parent_session_path = excluded.parent_session_path,
          source_delegation_id = excluded.source_delegation_id,
          delegation_role = excluded.delegation_role,
          delegation_status = excluded.delegation_status,
          delegation_depth = excluded.delegation_depth,
          delegation_goal = excluded.delegation_goal,
          delegation_report = COALESCE(threads.delegation_report, excluded.delegation_report),
          delegation_error = COALESCE(threads.delegation_error, excluded.delegation_error),
          delegation_completed_at = COALESCE(threads.delegation_completed_at, excluded.delegation_completed_at),
          updated_at = excluded.updated_at
      `)
      .run(
        input.id,
        input.sessionPath,
        storagePath,
        path.resolve(input.cwd),
        input.title,
        input.provider ?? null,
        input.model ?? null,
        createdAt,
        createdAt,
        path.resolve(input.parentSessionPath),
        input.sourceDelegationId,
        input.delegationRole,
        input.delegationStatus,
        input.delegationDepth,
        input.delegationGoal,
      );
    return this.get(input.id)!;
  }

  updateDelegation(
    sourceDelegationId: string,
    updates: Partial<Pick<TacodeThread, "title" | "delegationStatus" | "delegationGoal" | "delegationReport" | "delegationError" | "delegationCompletedAt">> & {
      preview?: string;
      updatedAt?: number;
    },
  ): TacodeThread | undefined {
    const current = this.database.prepare(
      "SELECT * FROM threads WHERE source_delegation_id = ? LIMIT 1",
    ).get(sourceDelegationId) as ThreadRow | undefined;
    if (!current) return undefined;
    const nextTitle = updates.title ?? current.title;
    const nextStatus = updates.delegationStatus ?? current.delegation_status;
    const nextGoal = updates.delegationGoal ?? current.delegation_goal;
    const nextReport = updates.delegationReport ?? current.delegation_report;
    const nextError = updates.delegationError ?? current.delegation_error;
    const nextCompletedAt = updates.delegationCompletedAt
      ? Date.parse(updates.delegationCompletedAt)
      : current.delegation_completed_at;
    const nextPreview = updates.preview ?? current.preview;
    this.database.prepare(`
      UPDATE threads
      SET title = ?, preview = ?, delegation_status = ?, delegation_goal = ?,
          delegation_report = ?, delegation_error = ?, delegation_completed_at = ?, updated_at = ?
      WHERE source_delegation_id = ?
    `).run(
      nextTitle,
      nextPreview,
      nextStatus,
      nextGoal,
      nextReport,
      nextError,
      nextCompletedAt,
      updates.updatedAt ?? Date.now(),
      sourceDelegationId,
    );
    const row = this.database.prepare(
      "SELECT * FROM threads WHERE source_delegation_id = ? LIMIT 1",
    ).get(sourceDelegationId) as ThreadRow | undefined;
    return row ? rowToThread(row) : undefined;
  }

  setPinned(id: string, pinned: boolean): boolean {
    return (
      this.database.prepare("UPDATE threads SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, id)
        .changes > 0
    );
  }

  async archive(id: string): Promise<TacodeThread | undefined> {
    const current = this.get(id);
    if (!current || current.archived) return current;
    const dateParts = current.createdAt.slice(0, 10).split("-");
    const target = path.join(
      getTacodeArchivedSessionsDir(),
      ...dateParts,
      path.basename(current.storagePath),
    );
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(target), 0o700).catch(() => undefined);
    let compatibilityLinkRemoved = false;
    if (current.sessionPath !== current.storagePath) {
      await fs.unlink(current.sessionPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
      compatibilityLinkRemoved = true;
    }
    try {
      await fs.rename(current.storagePath, target);
    } catch (error) {
      if (compatibilityLinkRemoved) {
        await fs.link(current.storagePath, current.sessionPath).catch(() => undefined);
      }
      throw error;
    }
    this.database
      .prepare(
        "UPDATE threads SET session_path = ?, storage_path = ?, archived = 1, updated_at = ? WHERE id = ?",
      )
      .run(target, target, Date.now(), id);
    return this.get(id);
  }

  async unarchive(id: string): Promise<TacodeThread | undefined> {
    const current = this.get(id);
    if (!current || !current.archived) return current;
    const dateParts = current.createdAt.slice(0, 10).split("-");
    const storagePath = path.join(
      getTacodeSessionsDir(),
      ...dateParts,
      path.basename(current.storagePath),
    );
    const runtimePath = path.join(getTacodeSessionsDir(), path.basename(current.storagePath));
    await fs.mkdir(path.dirname(storagePath), { recursive: true, mode: 0o700 });
    await fs.rename(current.storagePath, storagePath);
    try {
      await fs.link(storagePath, runtimePath);
    } catch (error) {
      await fs.rename(storagePath, current.storagePath).catch(() => undefined);
      throw error;
    }
    await fs.chmod(storagePath, 0o600).catch(() => undefined);
    this.database
      .prepare(
        "UPDATE threads SET session_path = ?, storage_path = ?, archived = 0, updated_at = ? WHERE id = ?",
      )
      .run(runtimePath, storagePath, Date.now(), id);
    return this.get(id);
  }

  private async indexFile(
    sessionPath: string,
    storagePath: string,
    archived: boolean,
  ): Promise<TacodeThread | undefined> {
    let stat: Stats;
    try {
      stat = await fs.stat(storagePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
    const cached = this.findByPath.get(sessionPath, storagePath) as ThreadRow | undefined;
    if (
      cached &&
      cached.file_size === stat.size &&
      cached.file_mtime_ms === stat.mtimeMs &&
      Boolean(cached.archived) === archived
    ) {
      return rowToThread(cached);
    }
    const parsed = await parseSession(storagePath, stat);
    if (!parsed) return undefined;
    const indexedId = cached?.source_delegation_id ? cached.id : parsed.id;
    this.database
      .prepare(`
        INSERT INTO threads (
          id, session_path, storage_path, cwd, title, preview, provider, model,
          created_at, updated_at, message_count, pinned, archived, file_size, file_mtime_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          session_path = excluded.session_path,
          storage_path = excluded.storage_path,
          cwd = excluded.cwd,
          title = excluded.title,
          preview = excluded.preview,
          provider = excluded.provider,
          model = excluded.model,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          message_count = excluded.message_count,
          archived = excluded.archived,
          file_size = excluded.file_size,
          file_mtime_ms = excluded.file_mtime_ms
      `)
      .run(
        indexedId,
        sessionPath,
        storagePath,
        parsed.cwd,
        parsed.title,
        parsed.preview ?? null,
        parsed.provider ?? null,
        parsed.model ?? null,
        parsed.createdAt,
        stat.mtimeMs,
        parsed.messageCount,
        archived ? 1 : 0,
        stat.size,
        stat.mtimeMs,
      );
    return this.get(parsed.id);
  }
}

export async function listTacodeThreads(
  options: ListThreadOptions = {},
): Promise<TacodeThread[]> {
  const store = new TacodeStateStore();
  try {
    await store.refresh();
    return store.list(options);
  } finally {
    store.close();
  }
}

export async function indexTacodeSession(file: string): Promise<TacodeThread | undefined> {
  const store = new TacodeStateStore();
  try {
    return await store.indexSession(file);
  } finally {
    store.close();
  }
}

interface ParsedSession {
  id: string;
  cwd: string;
  title: string;
  preview?: string;
  provider?: string;
  model?: string;
  createdAt: number;
  messageCount: number;
}

async function parseSession(
  file: string,
  stat: Stats,
): Promise<ParsedSession | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const lines = raw.split("\n").filter(Boolean);
  const header = lines[0] ? parseLine(lines[0]) : undefined;
  if (header?.type !== "session" || typeof header.cwd !== "string") return undefined;
  let firstUserText: string | undefined;
  let preview: string | undefined;
  let namedTitle: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let messageCount = 0;
  for (const line of lines.slice(1)) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (entry.type === "model_change") {
      if (typeof entry.provider === "string") provider = entry.provider;
      if (typeof entry.modelId === "string") model = entry.modelId;
    }
    if (entry.type === "session_info" && typeof entry.name === "string") namedTitle = entry.name;
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    messageCount += 1;
    const text = messageText(entry.message.content);
    if (!text) continue;
    preview = text;
    if (!firstUserText && entry.message.role === "user") firstUserText = text;
  }
  const createdAt =
    typeof header.timestamp === "string" && Number.isFinite(Date.parse(header.timestamp))
      ? Date.parse(header.timestamp)
      : stat.birthtimeMs || stat.mtimeMs;
  return {
    id: typeof header.id === "string" ? header.id : path.basename(file, ".jsonl"),
    cwd: path.resolve(header.cwd),
    title: crop(normalize(namedTitle ?? firstUserText ?? "New thread"), 96),
    ...(preview ? { preview: crop(preview, 240) } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    createdAt,
    messageCount,
  };
}

function rowToThread(row: ThreadRow): TacodeThread {
  return {
    id: row.id,
    sessionPath: row.session_path,
    storagePath: row.storage_path,
    cwd: row.cwd,
    title: row.title,
    ...(row.preview ? { preview: row.preview } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    messageCount: row.message_count,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    ...(row.parent_session_path ? { parentSessionPath: row.parent_session_path } : {}),
    ...(row.source_delegation_id ? { sourceDelegationId: row.source_delegation_id } : {}),
    ...(row.delegation_role ? { delegationRole: row.delegation_role } : {}),
    ...(row.delegation_status ? { delegationStatus: row.delegation_status } : {}),
    ...(row.delegation_depth === null || row.delegation_depth === undefined
      ? {}
      : { delegationDepth: row.delegation_depth }),
    ...(row.delegation_goal ? { delegationGoal: row.delegation_goal } : {}),
    ...(row.delegation_report ? { delegationReport: row.delegation_report } : {}),
    ...(row.delegation_error ? { delegationError: row.delegation_error } : {}),
    ...(row.delegation_completed_at
      ? { delegationCompletedAt: new Date(row.delegation_completed_at).toISOString() }
      : {}),
  };
}

async function directJsonlFiles(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

async function recursiveJsonlFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await recursiveJsonlFiles(child)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child);
  }
  return files;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return normalize(content);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  return text ? normalize(text) : undefined;
}

function normalize(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function crop(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error;
}
