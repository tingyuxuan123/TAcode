import { app, BrowserWindow, nativeTheme } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/**
 * 独立浏览器窗口（浏览器面板「在新窗口中打开」）。
 *
 * 移植自 Snow App（MIT）src/main/browser/browserWindow.ts，复用同一套
 * 渲染端浏览器 UI（browser-window.html 入口复用 BrowserPanel）：
 * - instanceId 经 query 迁移，标签页快照（激活页置首）一并携带重建；
 * - 窗口使用系统边框，不参与主窗口的窗体定制。
 */

const DEFAULT_WINDOW_WIDTH = 1100;
const DEFAULT_WINDOW_HEIGHT = 760;
const MIN_WINDOW_WIDTH = 480;
const MIN_WINDOW_HEIGHT = 320;

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/** instanceId -> 独立浏览器窗口（同一实例只允许一个独立窗口）。 */
const detachedWindows = new Map<string, BrowserWindow>();

const appIconPath = (): string =>
  app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(moduleDirectory, "../../build/icon.png");

const getWindowBackgroundColor = (): string =>
  nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";

const buildPageUrl = (
  instanceId: string,
  url: string,
  tabs?: { url: string; title: string }[],
): string => {
  const query = new URLSearchParams({ instanceId, url });
  if (tabs && tabs.length > 0) query.set("tabs", JSON.stringify(tabs));
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) return `${devServerUrl}/browser-window.html?${query.toString()}`;
  return `${pathToFileURL(path.join(moduleDirectory, "../../dist/browser-window.html")).toString()}?${query.toString()}`;
};

/**
 * 打开（或聚焦）承载指定浏览器实例的独立窗口。
 *
 * 同实例已有窗口时仅聚焦并返回；否则创建新窗口并加载渲染端入口，
 * instanceId / 当前 URL / 全部标签页快照（tabs）经 query 传递。
 */
export const createDetachedBrowserWindow = (
  instanceId: string,
  url: string,
  tabs?: { url: string; title: string }[],
): void => {
  const existing = detachedWindows.get(instanceId);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const win = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: "Tether Browser",
    icon: appIconPath(),
    autoHideMenuBar: true,
    backgroundColor: getWindowBackgroundColor(),
    show: false,
    webPreferences: {
      preload: path.join(moduleDirectory, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  detachedWindows.set(instanceId, win);

  win.setMenu(null);
  win.setMenuBarVisibility(false);
  win.setAutoHideMenuBar(true);

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });

  win.on("closed", () => {
    detachedWindows.delete(instanceId);
    // 通知其余窗口（主窗口面板）该实例不再处于独立窗口中，用于恢复面板展示。
    for (const other of BrowserWindow.getAllWindows()) {
      if (!other.isDestroyed() && other !== win) {
        other.webContents.send("browser:detached-window-closed", { instanceId });
      }
    }
  });

  // 渲染进程异常退出时自动重新加载，避免窗口黑屏卡死。
  win.webContents.on("render-process-gone", () => {
    if (!win.isDestroyed()) win.webContents.reload();
  });

  // 防御性兜底：渲染进程主框架导航到应用页面之外的 URL 一律阻止。
  win.webContents.on("will-navigate", (event, targetUrl) => {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl && targetUrl.startsWith(devServerUrl)) return;
    event.preventDefault();
  });

  void win.loadURL(buildPageUrl(instanceId, url, tabs)).catch((error) => {
    console.error("Failed to load detached browser window:", error);
  });
};

/** 关闭所有独立浏览器窗口（应用退出时调用，避免残留孤儿窗口）。 */
export const closeAllDetachedBrowserWindows = (): void => {
  for (const win of detachedWindows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  detachedWindows.clear();
};
