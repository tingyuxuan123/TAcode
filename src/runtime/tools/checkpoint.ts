/**
 * 文件改动 checkpoint。
 *
 * 每次成功的 `apply_patch` 或 `exec_command` 都会写一条 `tacode-checkpoint`
 * custom entry，渲染层的 `/undo` 依据它恢复最近一轮的文件内容。
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
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
): Promise<{ result: T; checkpoint?: Checkpoint }> {
  const before = await scanWorkspace(workspace);
  const result = await apply();
  const after = await scanWorkspace(workspace);
  const files = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = files.filter((file) => before.get(file)?.hash !== after.get(file)?.hash);
  if (changed.length === 0) return { result };
  return {
    result,
    checkpoint: {
      id: crypto.randomUUID().slice(0, 12),
      createdAt: new Date().toISOString(),
      patch: `exec_command: ${label}`,
      before: changed.map((file) => before.get(file) ?? missingSnapshot(file)),
      after: changed.map((file) => after.get(file) ?? missingSnapshot(file)),
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

async function scanWorkspace(workspace: Workspace): Promise<Map<string, FileSnapshot>> {
  await workspace.initialize();
  const snapshots = new Map<string, FileSnapshot>();
  await scanDirectory(workspace, ".", snapshots);
  return snapshots;
}

async function scanDirectory(
  workspace: Workspace,
  relativeDirectory: string,
  snapshots: Map<string, FileSnapshot>,
): Promise<void> {
  if (snapshots.size > 2_000) return;
  const absoluteDirectory = await workspace.resolve(relativeDirectory, true);
  let entries;
  try {
    entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".agents") continue;
    if (["node_modules", "dist", "dist-electron", "release", "coverage"].includes(entry.name)) continue;
    const relative = relativeDirectory === "." ? entry.name : path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory(workspace, relative, snapshots);
      continue;
    }
    if (!entry.isFile()) continue;
    const absolute = await workspace.resolve(relative, true);
    const stat = await fs.stat(absolute);
    if (stat.size > 1_000_000) continue;
    const content = await readTextFile(absolute);
    if (content === undefined) continue;
    snapshots.set(relative, { path: relative, content, mode: stat.mode, hash: hash(content) });
  }
}

async function readTextFile(file: string): Promise<string | undefined> {
  const buffer = await fs.readFile(file);
  if (buffer.includes(0)) return undefined;
  return buffer.toString("utf8");
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
