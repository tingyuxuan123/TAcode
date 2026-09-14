import path from "node:path";
import { ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { DirectoryRequest, DocumentReadRequest, DocumentWriteRequest, FileSearchRequest, FileSubscribeRequest, ProjectPath } from "../../shared/files";
import { fileFailure, ProjectFileError, relativeFilePath } from "./file-path";
import { FileService, type FileServiceOptions } from "./file-service";
import { FileDrafts, parseFileDraft } from "./file-drafts";

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ProjectFileError("invalidRequest", "Invalid file request");
  return raw as Record<string, unknown>;
}
export function parseProjectPath(raw: unknown, allowRoot = false): ProjectPath {
  const value = record(raw);
  if (typeof value.projectRoot !== "string" || !path.isAbsolute(value.projectRoot) || value.projectRoot.length > 4096 || value.projectRoot.includes("\0")) throw new ProjectFileError("invalidRequest", "An explicit absolute project root is required");
  return { projectRoot: path.resolve(value.projectRoot), path: relativeFilePath(value.path, allowRoot) };
}
export function fileSubscriptionId(raw: unknown): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw)) throw new ProjectFileError("invalidRequest", "Invalid file subscription identifier");
  return raw;
}
function directoryRequest(raw: unknown): DirectoryRequest {
  const value = record(raw); const request: DirectoryRequest = parseProjectPath(value, true);
  if (value.limit !== undefined) {
    if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 500) throw new ProjectFileError("invalidRequest", "Invalid page limit");
    request.limit = value.limit;
  }
  if (value.cursor !== undefined) {
    if (typeof value.cursor !== "string" || value.cursor.length > 1024) throw new ProjectFileError("invalidRequest", "Invalid page cursor");
    request.cursor = value.cursor;
  }
  for (const key of ["refresh", "includeIgnored"] as const) if (value[key] !== undefined) {
    if (typeof value[key] !== "boolean") throw new ProjectFileError("invalidRequest", "Invalid directory option");
    request[key] = value[key];
  }
  return request;
}
export function registerFileIpc(options: FileServiceOptions & { host(): WebContents | undefined; draftRoot?: string }) {
  const service = new FileService({ ...options, trash: options.trash ?? ((file) => shell.trashItem(file)),
    openPath: options.openPath ?? ((file) => shell.openPath(file)), reveal: options.reveal ?? ((file) => shell.showItemInFolder(file)),
    mutation: (mutation) => { options.mutation?.(mutation); const host = options.host(); if (host && !host.isDestroyed()) host.send("files:mutation", mutation); } });
  const drafts = options.draftRoot ? new FileDrafts(options.draftRoot, service.paths) : undefined;
  const owners = new Map<number, { generation: number; cleanup(): void }>();
  const authorize = (event: IpcMainInvokeEvent) => {
    const host = event.sender;
    if (options.host() !== host || event.senderFrame !== host.mainFrame) throw new ProjectFileError("outsideProject", "Files are available only to the workbench main frame");
    if (!owners.has(host.id)) {
      const entry = { generation: 0, cleanup: () => {} };
      const release = () => { entry.generation++; service.subscriptions.releaseOwner(host.id); };
      const navigation = (_event: Electron.Event, _url: string, inPlace: boolean, main: boolean) => { if (main && !inPlace) release(); };
      const destroyed = () => { release(); entry.cleanup(); };
      entry.cleanup = () => {
        host.removeListener("destroyed", destroyed); host.removeListener("render-process-gone", release); host.removeListener("did-start-navigation", navigation); owners.delete(host.id);
      };
      owners.set(host.id, entry); host.once("destroyed", destroyed); host.on("render-process-gone", release); host.on("did-start-navigation", navigation);
    }
    return host;
  };
  const channels: string[] = [];
  const handle = (channel: string, work: (host: WebContents, raw: unknown, active: () => void) => unknown) => {
    channels.push(channel);
    ipcMain.handle(channel, async (event, raw: unknown) => {
      try {
        const host = authorize(event); const entry = owners.get(host.id)!; const generation = entry.generation;
        const active = () => { if (owners.get(host.id) !== entry || entry.generation !== generation || host.isDestroyed()) throw new ProjectFileError("cancelled", "The workbench owner changed"); };
        const result = await work(host, raw, active); active(); return result;
      } catch (error) { return fileFailure(error); }
    });
  };
  handle("files:directory", (_host, raw) => service.directory(directoryRequest(raw)));
  handle("files:search", (_host, raw) => {
    const value = record(raw);
    if (typeof value.query !== "string" || value.query.length > 4096 || value.query.includes("\0")) throw new ProjectFileError("invalidRequest", "Invalid search query");
    return service.search({ ...directoryRequest(raw), query: value.query } satisfies FileSearchRequest);
  });
  handle("files:read-document", (_host, raw) => {
    const value = record(raw); const request: DocumentReadRequest = parseProjectPath(raw);
    for (const key of ["offset", "length"] as const) if (value[key] !== undefined) {
      if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key])) throw new ProjectFileError("invalidRequest", "Invalid document byte range");
      request[key] = value[key];
    }
    return service.readDocument(request);
  });
  handle("files:write-document", (_host, raw, active) => {
    const value = record(raw);
    if (typeof value.content !== "string" || typeof value.expectedVersion !== "string") throw new ProjectFileError("invalidRequest", "Invalid document write");
    return service.writeDocument({ ...parseProjectPath(raw), content: value.content, expectedVersion: value.expectedVersion } satisfies DocumentWriteRequest, active);
  });
  handle("files:read-drafts", async (_host, raw) => ({ kind: "drafts", drafts: drafts ? await drafts.list(parseProjectPath(raw, true)) : [] }));
  handle("files:write-draft", async (_host, raw, active) => {
    if (!drafts) throw new ProjectFileError("failed", "Recovery storage is unavailable");
    await drafts.write(parseFileDraft(raw), active); return { kind: "checkpointed" };
  });
  handle("files:remove-draft", async (_host, raw, active) => {
    if (!drafts) throw new ProjectFileError("failed", "Recovery storage is unavailable");
    await drafts.remove(parseProjectPath(raw), active); return { kind: "checkpointed" };
  });
  handle("files:preview-url", (_host, raw) => service.previewUrl(parseProjectPath(raw)));
  handle("files:inspect", (_host, raw) => service.inspect(parseProjectPath(raw)));
  handle("files:location", (_host, raw) => service.location(parseProjectPath(raw, true)));
  handle("files:editors", async () => ({ kind: "editors", editors: await service.editors() }));
  handle("files:mutate", (_host, raw, active) => {
    const value = record(raw);
    if (!["createFile", "createDirectory", "rename", "trash"].includes(value.operation as string)
      || value.expectedVersion !== undefined && typeof value.expectedVersion !== "string"
      || value.destination !== undefined && typeof value.destination !== "string") throw new ProjectFileError("invalidRequest", "Invalid file mutation");
    return service.mutate({ ...parseProjectPath(raw), operation: value.operation as import("../../shared/files").FileMutation["operation"],
      expectedVersion: value.expectedVersion as string | undefined, destination: value.destination as string | undefined }, active);
  });
  handle("files:open", (_host, raw, active) => {
    const value = record(raw);
    if (!["system", "vscode", "cursor"].includes(value.editor as string)) throw new ProjectFileError("invalidRequest", "Invalid external editor");
    for (const key of ["line", "column"] as const) if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 100_000_000)) throw new ProjectFileError("invalidRequest", "Invalid editor location");
    return service.open({ ...parseProjectPath(raw, true), editor: value.editor as import("../../shared/files").ExternalEditor,
      line: value.line as number | undefined, column: value.column as number | undefined }, active);
  });
  handle("files:reveal", (_host, raw, active) => service.reveal(parseProjectPath(raw, true), active));
  handle("files:subscribe", (host, raw) => {
    const value = record(raw);
    if (value.target !== "document" && value.target !== "directory") throw new ProjectFileError("invalidRequest", "Invalid subscription target");
    const request: FileSubscribeRequest = { ...parseProjectPath(raw, value.target === "directory"), subscriptionId: fileSubscriptionId(value.subscriptionId), target: value.target };
    return service.subscriptions.subscribe(host.id, request, (update) => { if (!host.isDestroyed()) host.send("files:update", update); });
  });
  handle("files:unsubscribe", (host, raw) => service.subscriptions.unsubscribe(host.id, fileSubscriptionId(raw)));
  return { service, drafts, idle: async () => { await service.idle(); await drafts?.idle(); }, dispose: () => {
    service.close(); for (const entry of owners.values()) entry.cleanup(); for (const channel of channels) ipcMain.removeHandler(channel);
  } };
}
