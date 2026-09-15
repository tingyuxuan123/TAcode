/**
 * AI 审查的 IPC 边界：只接受显式项目路径与已知比较范围；窗口重载/销毁时取消该窗口
 * 启动的审查，避免留下孤立 worker。
 */

import path from "node:path";
import { ipcMain, type WebContents } from "electron";
import type { GitComparison } from "../../shared/git";
import type { ReviewStartRequest } from "../../shared/review";
import { REVIEW_LIMITS } from "../../shared/review";
import { GitReadError } from "../git/git-process";
import type { ReviewCoordinator } from "./review-coordinator";

const text = (raw: unknown, max: number): string => {
  if (typeof raw !== "string" || !raw.length || raw.length > max || raw.includes("\0")) throw new GitReadError("invalidRequest", "Invalid review request");
  return raw;
};
const digest = (raw: unknown): string => {
  const value = text(raw, 64);
  if (!/^[a-f0-9]{64}$/.test(value) && !/^[a-f0-9-]{36}$/.test(value)) throw new GitReadError("invalidRequest", "Invalid review run id");
  return value;
};
export function parseReviewStartRequest(raw: unknown): ReviewStartRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GitReadError("invalidRequest", "Invalid review request");
  const value = raw as Record<string, unknown>;
  const projectRoot = text(value.projectRoot, 4_096);
  if (!path.isAbsolute(projectRoot)) throw new GitReadError("invalidRequest", "An explicit absolute project path is required");
  const query = value.comparison as Record<string, unknown> | undefined;
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new GitReadError("invalidRequest", "Invalid review range");
  let comparison: GitComparison;
  if (query.kind === "unstaged" || query.kind === "staged") comparison = { kind: query.kind };
  else if (query.kind === "commit") comparison = { kind: "commit", commit: text(query.commit, 1024) };
  else if (query.kind === "branch") comparison = { kind: "branch", base: text(query.base, 1024) };
  else if (query.kind === "turn") comparison = { kind: "turn", snapshotId: digest(query.snapshotId) };
  else throw new GitReadError("invalidRequest", "Invalid review range");
  const requirements = value.requirements === undefined ? undefined : text(value.requirements, REVIEW_LIMITS.requirements);
  const snapshotId = value.snapshotId === undefined ? undefined : digest(value.snapshotId);
  return { projectRoot, comparison, ...(snapshotId ? { snapshotId } : {}), ...(requirements ? { requirements } : {}) };
}

export function registerReviewIpc(options: { host(): WebContents | undefined; coordinator: ReviewCoordinator }): { dispose(): void } {
  const owned = new Map<number, { runs: Set<string>; cleanup(): void }>();
  const authorize = (event: Electron.IpcMainInvokeEvent) => {
    const contents = event.sender;
    if (options.host() !== contents || event.senderFrame !== contents.mainFrame) throw new GitReadError("outsideProject", "Reviews are available only to the workbench main frame");
    if (!owned.has(contents.id)) {
      const entry: { runs: Set<string>; cleanup(): void } = { runs: new Set(), cleanup: () => {} };
      const release = () => { for (const id of entry.runs) options.coordinator.cancel(id); entry.runs.clear(); };
      const navigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => { if (isMainFrame && !isInPlace) release(); };
      const destroyed = () => { release(); entry.cleanup(); };
      entry.cleanup = () => {
        contents.removeListener("destroyed", destroyed);
        contents.removeListener("render-process-gone", release);
        contents.removeListener("did-start-navigation", navigation);
        owned.delete(contents.id);
      };
      owned.set(contents.id, entry);
      contents.once("destroyed", destroyed);
      contents.on("render-process-gone", release);
      contents.on("did-start-navigation", navigation);
    }
    return contents;
  };
  ipcMain.handle("review:start", async (event, raw: unknown) => {
    const contents = authorize(event);
    const run = await options.coordinator.start(parseReviewStartRequest(raw));
    owned.get(contents.id)?.runs.add(run.id);
    return run;
  });
  ipcMain.handle("review:cancel", (event, raw: unknown) => { authorize(event); return options.coordinator.cancel(digest(raw)); });
  ipcMain.handle("review:retry", async (event, raw: unknown) => {
    const contents = authorize(event);
    const run = await options.coordinator.retry(digest(raw));
    if (run) owned.get(contents.id)?.runs.add(run.id);
    return run;
  });
  ipcMain.handle("review:list", (event, raw: unknown) => { authorize(event); return options.coordinator.list(text(raw, 4_096)); });
  return { dispose: () => {
    for (const entry of owned.values()) entry.cleanup();
    for (const channel of ["review:start", "review:cancel", "review:retry", "review:list"]) ipcMain.removeHandler(channel);
  } };
}
