import {
  BrowserWindow,
  clipboard,
  ipcMain,
  nativeImage,
  session,
  webContents,
  type WebContents,
} from "electron";
import { installWebviewDownloadHandler } from "./downloads";
import {
  cancelDownload,
  listDownloads,
  openDownload,
  showDownloadInFolder,
} from "./downloads";
import { initBrowserPopupHandler } from "./popups";
import { createDetachedBrowserWindow } from "./windows";
import {
  deletePasswordRecord,
  deletePasswordRecords,
  findPasswordForOrigin,
  getPasswordRecord,
  isValidPasswordOrigin,
  listPasswordRecords,
  savePasswordRecord,
} from "./passwords";

/**
 * 内置浏览器 IPC 注册（移植自 Snow App（MIT）windowHandlers 的 browser 区段）。
 * 在 app ready 后调用一次；下载接管与弹出分流也在此统一初始化。
 * closeAllBrowserPopups / closeAllDetachedBrowserWindows 由 index.ts 在窗口
 * 关闭与退出路径上直接调用（自各自模块导入）。
 */

const numberArg = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  return value;
};

/** 仅允许操作 webview guest 的 webContents，避免任意进程句柄被滥用。 */
const getBrowserWebContents = (webContentsId: number): WebContents => {
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed() || contents.getType() !== "webview") {
    throw new Error("No such browser webContents");
  }
  return contents;
};

type RestorePayload = { instanceId: string; tabs: { url: string; title: string }[] };

const isTabSnapshot = (value: unknown): value is { url: string; title: string } =>
  !!value &&
  typeof value === "object" &&
  typeof (value as Record<string, unknown>).url === "string" &&
  typeof (value as Record<string, unknown>).title === "string";

const isRestorePayload = (value: unknown): value is RestorePayload => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.instanceId !== "string" || !record.instanceId.trim()) return false;
  if (!Array.isArray(record.tabs)) return false;
  return record.tabs.every(isTabSnapshot);
};

/**
 * 密码助手的 origin 校验：仅接受 webview guest 的请求，且请求的 origin
 * 必须与发起 frame 的真实 origin 一致，防止 guest 跨源读写凭据。
 */
const guestOriginFrom = (event: Electron.IpcMainInvokeEvent, origin: unknown): string => {
  if (event.sender.getType() !== "webview") throw new Error("Password bridge is guest-only");
  if (typeof origin !== "string" || !isValidPasswordOrigin(origin)) {
    throw new Error("Invalid password origin");
  }
  try {
    const frameOrigin = new URL(event.senderFrame?.url ?? "").origin;
    if (frameOrigin !== origin) throw new Error("Origin mismatch");
  } catch (error) {
    if (error instanceof Error && error.message === "Origin mismatch") throw error;
    throw new Error("Invalid sender frame");
  }
  return origin;
};

export const registerBrowserIpc = (
  getMainWindow: () => BrowserWindow | undefined,
): void => {
  installWebviewDownloadHandler();
  initBrowserPopupHandler();

  ipcMain.handle("browser:clear-cache", async () => {
    await session.defaultSession.clearCache();
  });

  ipcMain.handle("browser:clear-cookies", async () => {
    await session.defaultSession.clearStorageData({ storages: ["cookies"] });
  });

  ipcMain.handle("browser:open-devtools", (_event, webContentsId: unknown) => {
    const contents = getBrowserWebContents(numberArg(webContentsId, "webContentsId"));
    contents.openDevTools({ mode: "detach", activate: true });
  });

  // 截图到剪贴板：渲染进程 navigator.clipboard 写图片需要权限，经主进程总是可用。
  ipcMain.handle("browser:write-image", (_event, dataUrl: unknown) => {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
      throw new Error("A data:image URL is required");
    }
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) throw new Error("Unsupported image data");
    clipboard.writeImage(image);
  });

  ipcMain.handle("browser:downloads-list", () => listDownloads());
  ipcMain.handle("browser:download-open", (_event, id: unknown) => openDownload(numberArg(id, "id")));
  ipcMain.handle("browser:download-show-in-folder", (_event, id: unknown) => {
    showDownloadInFolder(numberArg(id, "id"));
  });
  ipcMain.handle("browser:download-cancel", (_event, id: unknown) => cancelDownload(numberArg(id, "id")));

  // 浏览器面板「在新窗口中打开」：创建独立窗口承载同一实例，
  // tabs（实例内部全部标签页快照，激活页置首）经 query 传给独立窗口。
  ipcMain.handle(
    "browser:open-detached-window",
    (_event, instanceId: unknown, url: unknown, tabs: unknown) => {
      if (typeof instanceId !== "string" || !instanceId.trim()) {
        throw new Error("A valid browser instanceId is required");
      }
      if (typeof url !== "string") throw new Error("A valid browser URL is required");
      const tabSnapshot = Array.isArray(tabs) ? tabs.filter(isTabSnapshot) : undefined;
      createDetachedBrowserWindow(instanceId.trim(), url.trim(), tabSnapshot);
    },
  );

  // 独立窗口「还原为标签页」：转发给主窗口渲染进程恢复为浏览器面板 tab，
  // 随后关闭发起请求的独立窗口。
  ipcMain.on("browser:restore-to-main", (event, payload: unknown) => {
    if (!isRestorePayload(payload)) return;
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("browser:restore-to-main-broadcast", payload);
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (senderWindow && !senderWindow.isDestroyed() && senderWindow !== mainWindow) {
      senderWindow.close();
    }
  });

  // ===== 密码保险库 =====
  // 管理（list/get/delete）：仅限应用窗口渲染进程；
  // find/save（自动填充/保存）：仅限 webview guest 且 origin 与 sender frame 一致。
  ipcMain.handle("browser-passwords:list", (event) => {
    if (event.sender.getType() !== "window") throw new Error("Host renderer only");
    return listPasswordRecords();
  });
  ipcMain.handle("browser-passwords:get", (event, id: unknown) => {
    if (event.sender.getType() !== "window") throw new Error("Host renderer only");
    if (typeof id !== "string") throw new Error("id must be a string");
    return getPasswordRecord(id);
  });
  ipcMain.handle("browser-passwords:save", (event, payload: unknown) => {
    const record = (payload ?? {}) as Record<string, unknown>;
    const origin = guestOriginFrom(event, record.origin);
    if (typeof record.password !== "string" || !record.password) {
      throw new Error("Password must not be empty");
    }
    return savePasswordRecord({
      origin,
      username: typeof record.username === "string" ? record.username : "",
      password: record.password,
    });
  });
  ipcMain.handle("browser-passwords:find", (event, payload: unknown) => {
    const origin = ((payload ?? {}) as Record<string, unknown>).origin;
    return findPasswordForOrigin(guestOriginFrom(event, origin));
  });
  ipcMain.handle("browser-passwords:delete", (event, id: unknown) => {
    if (event.sender.getType() !== "window") throw new Error("Host renderer only");
    if (typeof id !== "string") throw new Error("id must be a string");
    return deletePasswordRecord(id);
  });
  ipcMain.handle("browser-passwords:delete-batch", (event, ids: unknown) => {
    if (event.sender.getType() !== "window") throw new Error("Host renderer only");
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new Error("ids must be string[]");
    }
    return deletePasswordRecords(ids as string[]);
  });
};
