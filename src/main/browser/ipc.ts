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
};
