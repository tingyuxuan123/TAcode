import type { SourceLocation } from "./types";
import { mutatedPath, pathWithin, type FileMutation } from "../../shared/files";

export interface ScrollPosition { top: number; left: number }
export interface EditorPosition extends ScrollPosition { from: number; to: number }
export interface FileViewState {
  treeWidth?: number; treeOpen?: boolean; expanded?: string[]; treeScroll?: number; query?: string; position?: EditorPosition;
  viewMode?: "source" | "preview"; previewPosition?: ScrollPosition; imageZoom?: number; pageOffset?: number; pagePositions?: Record<string, EditorPosition>;
}
export interface SavedFileTab { path: string; preview: boolean; location?: SourceLocation }
export interface SavedFileTabs { tabs: SavedFileTab[]; activePath?: string }
export const fileScope = (root: string | undefined, session?: string): string => JSON.stringify([root ?? "", session ?? ""]);
const key = (scope: string, path: string) => `tacode:file-view:v1:${JSON.stringify([scope, path])}`;
const tabsKey = (scope: string) => `tacode:file-tabs:v1:${scope}`;
const redirects: FileMutation[] = [];
function redirect(scope: string, path: string): string | undefined {
  let root: string; try { root = JSON.parse(scope)[0]; } catch { return path; }
  let next: string | undefined = path;
  for (const mutation of redirects) if (mutation.projectRoot === root && next !== undefined) next = mutatedPath(next, mutation);
  return next;
}
function read(value: string): unknown { try { return JSON.parse(localStorage.getItem(value) ?? "null"); } catch { return null; } }
function write(value: string, data: unknown): void { try { localStorage.setItem(value, JSON.stringify(data)); } catch { /* In-memory views remain usable when storage is unavailable. */ } }
const finite = (value: unknown, max = 100_000_000): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max;
export function readFileView(scope: string, path: string): FileViewState {
  const value = read(key(scope, path)) as FileViewState | null;
  if (!value || typeof value !== "object") return {};
  const state: FileViewState = {};
  if (finite(value.treeWidth, 2000) && value.treeWidth >= 200) state.treeWidth = value.treeWidth;
  if (typeof value.treeOpen === "boolean") state.treeOpen = value.treeOpen;
  if (finite(value.treeScroll)) state.treeScroll = value.treeScroll;
  if (typeof value.query === "string" && value.query.length <= 4096) state.query = value.query;
  if (Array.isArray(value.expanded)) state.expanded = value.expanded.filter((item) => typeof item === "string" && item.length <= 4096).slice(0, 2000);
  const position = value.position;
  if (position && [position.top, position.left, position.from, position.to].every((item) => finite(item))) state.position = position;
  if (value.viewMode === "source" || value.viewMode === "preview") state.viewMode = value.viewMode;
  if (value.previewPosition && [value.previewPosition.top, value.previewPosition.left].every((item) => finite(item))) state.previewPosition = value.previewPosition;
  if (finite(value.imageZoom, 4)) state.imageZoom = value.imageZoom;
  if (finite(value.pageOffset, Number.MAX_SAFE_INTEGER)) state.pageOffset = value.pageOffset;
  if (value.pagePositions && typeof value.pagePositions === "object") {
    state.pagePositions = Object.fromEntries(Object.entries(value.pagePositions).filter(([offset, position]) =>
      /^\d+$/.test(offset) && finite(Number(offset), Number.MAX_SAFE_INTEGER) && position && [position.top, position.left, position.from, position.to].every((item) => finite(item))).slice(-24));
  }
  return state;
}
export function writeFileView(scope: string, path: string, state: FileViewState): void {
  const next = redirect(scope, path); if (next === undefined) return;
  const expanded = state.expanded?.map((value) => redirect(scope, value)).filter((value): value is string => value !== undefined);
  write(key(scope, next), { ...state, expanded });
}
export function readFileTabs(scope: string): SavedFileTabs {
  const value = read(tabsKey(scope)) as SavedFileTabs | null;
  if (!value || !Array.isArray(value.tabs)) return { tabs: [] };
  const seen = new Set<string>(); let preview = false;
  const tabs = value.tabs.filter((tab) => {
    if (!tab || typeof tab.path !== "string" || !tab.path || tab.path.length > 4096 || tab.path.includes("\0") || seen.has(tab.path)) return false;
    seen.add(tab.path); if (tab.preview && preview) return false; preview ||= Boolean(tab.preview); return true;
  }).slice(0, 100).map((tab) => ({ path: tab.path, preview: Boolean(tab.preview) }));
  return { tabs, activePath: tabs.some((tab) => tab.path === value.activePath) ? value.activePath : undefined };
}
export function writeFileTabs(scope: string, value: SavedFileTabs): void { write(tabsKey(scope), value); }
export function applyFileMutationToStorage(mutation: FileMutation): void {
  if (mutation.operation === "createFile" || mutation.operation === "createDirectory") {
    for (let index = redirects.length - 1; index >= 0; index--) if (redirects[index]!.projectRoot === mutation.projectRoot && pathWithin(redirects[index]!.path, mutation.path)) redirects.splice(index, 1);
    return;
  }
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter((value): value is string => Boolean(value));
    for (const storageKey of keys) {
      try {
        if (storageKey.startsWith("tacode:file-tabs:v1:")) {
          const scope = storageKey.slice("tacode:file-tabs:v1:".length);
          if (JSON.parse(scope)[0] !== mutation.projectRoot) continue;
          const saved = readFileTabs(scope); const seen = new Set<string>();
          const tabs = saved.tabs.flatMap((tab) => { const path = mutatedPath(tab.path, mutation); if (!path || seen.has(path)) return []; seen.add(path); return [{ ...tab, path }]; });
          writeFileTabs(scope, { tabs, activePath: saved.activePath ? mutatedPath(saved.activePath, mutation) : undefined });
        } else if (storageKey.startsWith("tacode:file-view:v1:")) {
          const [scope, path] = JSON.parse(storageKey.slice("tacode:file-view:v1:".length)) as [string, string];
          if (JSON.parse(scope)[0] !== mutation.projectRoot) continue;
          const next = mutatedPath(path, mutation); const view = readFileView(scope, path);
          const expanded = view.expanded?.map((value) => mutatedPath(value, mutation)).filter((value): value is string => value !== undefined);
          if (next !== path) localStorage.removeItem(storageKey);
          if (next !== undefined) write(key(scope, next), { ...view, expanded });
        }
      } catch { /* A corrupt record must not prevent other sessions from migrating. */ }
    }
  } catch { /* Mounted tabs still update when browser storage is unavailable. */ }
  redirects.push(mutation);
}

/** Normalize all entry points without Node APIs; the main process repeats the boundary check. */
export function projectFilePath(input: string, root: string, platform: NodeJS.Platform, literal = false): { path: string; location?: SourceLocation } {
  const windows = platform === "win32";
  const normalizedRoot = (windows ? root.replaceAll("\\", "/") : root).replace(/\/+$/, "");
  let value = windows ? input.replaceAll("\\", "/") : input;
  const line = literal ? null : value.match(/^(.+?):(\d+)(?::(\d+))?$/);
  let location: SourceLocation | undefined;
  if (line) { value = line[1]!; location = { line: Math.max(1, Math.min(100_000_000, Number(line[2]))), column: line[3] ? Math.max(1, Math.min(100_000_000, Number(line[3]))) : undefined }; }
  const comparable = (text: string) => windows ? text.toLocaleLowerCase() : text;
  if (comparable(value).startsWith(`${comparable(normalizedRoot)}/`)) value = value.slice(normalizedRoot.length + 1);
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || (windows && /^[A-Za-z]:/.test(value))) throw new Error("outsideProject");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) throw new Error("outsideProject"); parts.pop(); } else parts.push(part);
  }
  const path = parts.join("/");
  if (!path || path.length > 4096 || path.includes("\0")) throw new Error("invalidRequest");
  return { path, location };
}
