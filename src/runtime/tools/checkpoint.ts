/**
 * 文件改动 checkpoint。
 *
 * 每次成功的 `apply_patch` 或 `exec_command` 都会写一条 `tacode-checkpoint`
 * custom entry，渲染层的 `/undo` 依据它恢复最近一轮的文件内容。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import type { Workspace } from "./workspace.js";

export interface FileSnapshot {
  path: string;
  content: string | null;
  mode?: number;
  hash: string;
}

export interface Checkpoint {
  id: string;
  createdAt: string;
  patch: string;
  before: FileSnapshot[];
  after: FileSnapshot[];
}

export const CHECKPOINT_LIMITS = { files: 2_000, fileBytes: 1_000_000, scanBytes: 32 * 1024 * 1024, changedFiles: 500, checkpointBytes: 4 * 1024 * 1024 };
export interface CheckpointMetrics { beforeMs: number; commandMs: number; afterMs: number; reads: number; cacheHits: number }
type CachedSnapshot = { signature: string; snapshot?: FileSnapshot };
/** 每个工具集只保留最近一个工作区、一次扫描的有界缓存。 */
export class WorkspaceCheckpointCache {
  root = "";
  entries = new Map<string, CachedSnapshot>();
}
interface WorkspaceScan {
  snapshots: Map<string, FileSnapshot>;
  seen: Set<string>;
  incomplete: boolean;
  warnings: Set<string>;
}

export async function capturePatchCheckpoint(
  workspace: Workspace,
  patchInput: string,
  apply: () => Promise<void>,
): Promise<Checkpoint> {
  const touched = extractTouchedPaths(patchInput);
  const before = await snapshotPaths(workspace, touched);
  await apply();
  const after = await snapshotPaths(workspace, touched);
  return {
    id: crypto.randomUUID().slice(0, 12),
    createdAt: new Date().toISOString(),
    patch: patchInput,
    before,
    after,
  };
}

export async function captureWorkspaceCheckpoint<T extends { running: boolean }>(
  workspace: Workspace,
  label: string,
  apply: () => Promise<T>,
  options: { cache?: WorkspaceCheckpointCache; signal?: AbortSignal; onPhase?(phase: "before" | "after"): void } = {},
): Promise<{ result: T; checkpoint?: Checkpoint; metrics: CheckpointMetrics; warnings: string[] }> {
  const cache = options.cache ?? new WorkspaceCheckpointCache();
  const metrics = { beforeMs: 0, commandMs: 0, afterMs: 0, reads: 0, cacheHits: 0 };
  options.onPhase?.("before");
  let start = performance.now();
  const before = await scanWorkspace(workspace, cache, metrics, options.signal);
  metrics.beforeMs = performance.now() - start;
  options.signal?.throwIfAborted();
  start = performance.now();
  const result = await apply();
  metrics.commandMs = performance.now() - start;
  // yield 时命令仍会写盘，不能把此时的目录当最终结果，也不再白做第二次扫描。
  if (result.running) return { result, metrics, warnings: ["命令仍在后台运行；其文件改动不包含在本次自动撤销中。"] };
  options.onPhase?.("after");
  start = performance.now();
  // 中止的命令也可能已经写盘，必须保留它的最终可恢复内容。
  const after = await scanWorkspace(workspace, cache, metrics, undefined, before.snapshots);
  metrics.afterMs = performance.now() - start;
  const warnings = new Set([...before.warnings, ...after.warnings]);
  const files = [...new Set([...before.snapshots.keys(), ...after.snapshots.keys()])].sort();
  const changed = files.filter((file) => {
    const previous = before.snapshots.get(file);
    const next = after.snapshots.get(file);
    // 扫描不完整不能把未覆盖的旧文件推断为“新增”，读取失败也不能推断为“删除”。
    if (!next || (!previous && (next.content === null || before.incomplete || before.seen.has(file)))) return false;
    return previous?.hash !== next.hash || (previous?.content !== null && next.content !== null && previous?.mode !== next.mode);
  });
  const saved: string[] = [];
  let bytes = 0;
  for (const file of changed) {
    const size = Buffer.byteLength(JSON.stringify([before.snapshots.get(file) ?? missingSnapshot(file), after.snapshots.get(file)]));
    if (saved.length >= CHECKPOINT_LIMITS.changedFiles || bytes + size > CHECKPOINT_LIMITS.checkpointBytes) {
      warnings.add("单次撤销最多保存 500 个变更文件、4 MiB 内容；超出部分未保存。");
      continue;
    }
    saved.push(file);
    bytes += size;
  }
  if (!saved.length) return { result, metrics, warnings: [...warnings] };
  return {
    result,
    metrics,
    warnings: [...warnings],
    checkpoint: {
      id: crypto.randomUUID().slice(0, 12),
      createdAt: new Date().toISOString(),
      patch: `exec_command: ${label}`,
      before: saved.map((file) => before.snapshots.get(file) ?? missingSnapshot(file)),
      after: saved.map((file) => after.snapshots.get(file)!),
    },
  };
}

export function extractTouchedPaths(input: string): string[] {
  const paths: string[] = [];
  for (const line of input.replaceAll("\r\n", "\n").split("\n")) {
    const match = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/.exec(line);
    if (!match) continue;
    const file = match[1].trim();
    if (file && !paths.includes(file)) paths.push(file);
  }
  if (paths.length === 0) throw new Error("Patch contains no file paths");
  return paths;
}

async function snapshotPaths(workspace: Workspace, files: string[]): Promise<FileSnapshot[]> {
  const snapshots: FileSnapshot[] = [];
  for (const file of files) {
    const absolute = await workspace.resolve(file, true);
    try {
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) throw new Error(`Checkpoint path is not a regular file: ${file}`);
      const content = await fs.readFile(absolute, "utf8");
      snapshots.push({ path: file, content, mode: stat.mode, hash: hash(content) });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      snapshots.push({ path: file, content: null, hash: hash(null) });
    }
  }
  return snapshots;
}

async function scanWorkspace(workspace: Workspace, cache: WorkspaceCheckpointCache, metrics: CheckpointMetrics, signal?: AbortSignal, required?: Map<string, FileSnapshot>): Promise<WorkspaceScan> {
  await workspace.initialize();
  if (cache.root !== workspace.root) { cache.root = workspace.root; cache.entries.clear(); }
  const scan: WorkspaceScan = { snapshots: new Map(), seen: new Set(), incomplete: false, warnings: new Set() };
  const listedFiles: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    try {
      const absolute = await workspace.resolve(directory, true);
      const entries = (await fs.readdir(absolute, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"));
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
        if (["node_modules", "dist", "dist-electron", "release", "coverage"].includes(entry.name)) continue;
        const relative = directory === "." ? entry.name : path.join(directory, entry.name);
        scan.seen.add(relative);
        if (entry.isDirectory()) await visit(relative);
        else {
          if (listedFiles.length >= CHECKPOINT_LIMITS.files) {
            scan.incomplete = true;
            scan.warnings.add("自动撤销最多检查 2000 个文件；超出范围的变更未保存。");
            return;
          }
          listedFiles.push(relative);
        }
        if (scan.incomplete) return;
      }
    } catch (error) {
      signal?.throwIfAborted();
      scan.incomplete = true;
      scan.warnings.add("部分目录无法读取，自动撤销只覆盖成功检查的文件。");
    }
  };
  await visit(".");
  const nextCache = new Map<string, CachedSnapshot>();
  // 优先复查原有文件，目录达到上限时也不会把漏扫文件误判为删除。
  const candidates = [...new Set([...(required?.keys() ?? []), ...listedFiles])];
  const files = candidates.slice(0, CHECKPOINT_LIMITS.files);
  if (candidates.length > files.length) scan.warnings.add("自动撤销最多检查 2000 个文件；超出范围的变更未保存。");
  let reserved = 0;
  const read = async (file: string): Promise<void> => {
    signal?.throwIfAborted();
    try {
      const absolute = await workspace.resolve(file, true);
      for (let attempt = 0; attempt < 2; attempt++) {
        const stat = await fs.lstat(absolute, { bigint: true });
        if (!stat.isFile()) { scan.warnings.add("符号链接或非普通文件不包含在自动撤销中。"); return; }
        const size = Number(stat.size);
        if (size > CHECKPOINT_LIMITS.fileBytes || reserved + size > CHECKPOINT_LIMITS.scanBytes) {
          scan.warnings.add("自动撤销仅检查单个不超过 1 MB、合计不超过 32 MiB 的文本文件。"); return;
        }
        reserved += size;
        const signature = fileSignature(stat);
        const previous = cache.entries.get(file);
        // 秒/毫秒精度的文件系统在同一时间刻度内可能覆写，近期粗粒度时间戳不复用。
        const coarseAndRecent = stat.ctimeNs <= 0n || (stat.ctimeNs % 1_000_000n === 0n && Date.now() - Number(stat.ctimeNs / 1_000_000n) < 2_000);
        if (!coarseAndRecent && previous?.signature === signature) {
          metrics.cacheHits++;
          nextCache.set(file, previous);
          if (previous.snapshot) scan.snapshots.set(file, previous.snapshot);
          else scan.warnings.add("二进制或非 UTF-8 文件不包含在自动撤销中。");
          return;
        }
        metrics.reads++;
        const buffer = await fs.readFile(absolute);
        const after = await fs.lstat(absolute, { bigint: true });
        if (fileSignature(after) !== signature) { reserved -= size; continue; }
        let content: string;
        try {
          if (buffer.includes(0)) throw new Error("binary");
          content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
        } catch {
          nextCache.set(file, { signature });
          scan.warnings.add("二进制或非 UTF-8 文件不包含在自动撤销中。");
          return;
        }
        const snapshot = { path: file, content, mode: Number(stat.mode), hash: hash(content) };
        nextCache.set(file, { signature, snapshot });
        scan.snapshots.set(file, snapshot);
        return;
      }
      scan.warnings.add("部分文件在检查期间持续变化，未加入自动撤销。");
    } catch (error) {
      signal?.throwIfAborted();
      if (isNodeError(error) && error.code === "ENOENT") scan.snapshots.set(file, missingSnapshot(file));
      else scan.warnings.add("部分文件无法读取，未加入自动撤销。");
    }
  };
  for (let i = 0; i < files.length; i += 16) await Promise.all(files.slice(i, i + 16).map(read));
  cache.entries = nextCache;
  return scan;
}

function fileSignature(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
}

function missingSnapshot(file: string): FileSnapshot {
  return { path: file, content: null, hash: hash(null) };
}

function hash(content: string | null): string {
  return crypto.createHash("sha256").update(content === null ? "\0missing" : content).digest("hex");
}

function isNodeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error;
}
