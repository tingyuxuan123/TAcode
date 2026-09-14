import path from "node:path";
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { GitReviewQuery, GitSubscribeRequest } from "../../shared/git";
import { GitReadError } from "./git-process";
import { GitReviewService, type GitReviewServiceOptions } from "./git-service";

function text(raw: unknown, max: number): string {
  if (typeof raw !== "string" || !raw.length || raw.length > max || raw.includes("\0")) throw new GitReadError("invalidRequest", "Invalid Git request");
  return raw;
}
export function gitSubscriptionId(raw: unknown): string {
  const value = text(raw, 128);
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new GitReadError("invalidRequest", "Invalid Git subscription id");
  return value;
}
export function parseGitSubscribeRequest(raw: unknown): GitSubscribeRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GitReadError("invalidRequest", "Invalid Git request");
  const value = raw as Record<string, unknown>;
  const projectRoot = text(value.projectRoot, 4096);
  if (!path.isAbsolute(projectRoot)) throw new GitReadError("invalidRequest", "An explicit absolute project path is required");
  const query = value.query as Record<string, unknown> | undefined;
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new GitReadError("invalidRequest", "Invalid Git comparison");
  let parsed: GitReviewQuery;
  if (query.kind === "unstaged" || query.kind === "staged" || query.kind === "repository") parsed = { kind: query.kind };
  else if (query.kind === "commit") parsed = { kind: "commit", commit: text(query.commit, 1024) };
  else if (query.kind === "branch") parsed = { kind: "branch", base: text(query.base, 1024) };
  else throw new GitReadError("invalidRequest", "Invalid Git comparison");
  return { subscriptionId: gitSubscriptionId(value.subscriptionId), projectRoot, query: parsed };
}

export function registerGitIpc(options: GitReviewServiceOptions & { host(): WebContents | undefined }): { service: GitReviewService; dispose(): void } {
  const service = new GitReviewService(options);
  const owners = new Map<number, () => void>();
  const authorize = (event: IpcMainInvokeEvent) => {
    const contents = event.sender;
    if (options.host() !== contents || event.senderFrame !== contents.mainFrame) throw new GitReadError("outsideProject", "Git is available only to the workbench main frame");
    if (!owners.has(contents.id)) {
      const release = () => service.releaseOwner(contents.id);
      const navigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => { if (isMainFrame && !isInPlace) release(); };
      const destroyed = () => { release(); cleanup(); };
      const cleanup = () => {
        contents.removeListener("destroyed", destroyed);
        contents.removeListener("render-process-gone", release);
        contents.removeListener("did-start-navigation", navigation);
        owners.delete(contents.id);
      };
      owners.set(contents.id, cleanup);
      contents.once("destroyed", destroyed);
      contents.on("render-process-gone", release);
      contents.on("did-start-navigation", navigation);
    }
    return contents;
  };
  ipcMain.handle("git:subscribe", (event, raw: unknown) => {
    const contents = authorize(event);
    return service.subscribe(contents.id, parseGitSubscribeRequest(raw), (update) => {
      if (!contents.isDestroyed()) contents.send("git:update", update);
    });
  });
  ipcMain.handle("git:unsubscribe", (event, raw: unknown) => service.unsubscribe(authorize(event).id, gitSubscriptionId(raw)));
  ipcMain.handle("git:refresh", (event, raw: unknown) => service.refresh(authorize(event).id, gitSubscriptionId(raw)));
  return { service, dispose: () => {
    service.close();
    for (const cleanup of owners.values()) cleanup();
    for (const channel of ["git:subscribe", "git:unsubscribe", "git:refresh"]) ipcMain.removeHandler(channel);
  } };
}
