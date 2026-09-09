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

/** 崩溃自动重试状态；超过上限后改为可重试的错误页。 */
const reloadStates = new Map<
  string,
  { attempts: number; timer?: ReturnType<typeof setTimeout>; target: string }
>();
/** 错误页“重新加载”允许回到的目标 URL（will-navigate 只对它放行一次）。 */
const retryTargets = new Map<string, string>();

const MAX_RELOAD_ATTEMPTS = 3;
const RELOAD_BASE_DELAY_MS = 1000;

const crashPage = (target: string): string => `<!doctype html>
<meta charset="utf-8" />
<title>Tether Browser</title>
<style>
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2328; background: #fafafb; }
  h1 { font-size: 16px; margin: 0; }
  p { margin: 0; font-size: 13px; color: #6b7280; max-width: 420px; text-align: center; word-break: break-all; }
  button { font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 8px; border: 1px solid #d0d5dd;
    background: #fff; cursor: pointer; }
  button:hover { background: #f3f4f6; }
</style>
<body>
  <h1>页面进程已崩溃</h1>
  <p>已自动重试 ${MAX_RELOAD_ATTEMPTS} 次仍未恢复。目标地址：${target.replace(/[<>&]/g, "")}</p>
  <button id="retry" type="button">重新加载</button>
  <script>
    document.getElementById("retry").addEventListener("click", () => {
      window.location.href = ${JSON.stringify(target)};
    });
  </script>
</body>`;

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
    const state = reloadStates.get(instanceId);
    if (state?.timer) clearTimeout(state.timer);
    reloadStates.delete(instanceId);
    retryTargets.delete(instanceId);
    // 通知其余窗口（主窗口面板）该实例不再处于独立窗口中，用于恢复面板展示。
    for (const other of BrowserWindow.getAllWindows()) {
      if (!other.isDestroyed() && other !== win) {
        other.webContents.send("browser:detached-window-closed", { instanceId });
      }
    }
  });

  // 渲染进程异常退出：有限次退避重载，持续崩溃则显示可重试的错误页，避免无限刷新。
  win.webContents.on("render-process-gone", () => {
    if (win.isDestroyed()) return;
    const state = reloadStates.get(instanceId) ?? { attempts: 0, target: url };
    if (state.attempts >= MAX_RELOAD_ATTEMPTS) {
      if (!state.timer) {
        state.timer = undefined;
        reloadStates.set(instanceId, state);
        retryTargets.set(instanceId, state.target);
        void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(crashPage(state.target))}`);
      }
      return;
    }
    state.attempts += 1;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (!win.isDestroyed()) void win.loadURL(buildPageUrl(instanceId, state.target));
    }, RELOAD_BASE_DELAY_MS * 2 ** (state.attempts - 1));
    reloadStates.set(instanceId, state);
  });

  // 页面正常加载完成即清零重试计数；错误页本身不算成功。
  win.webContents.on("did-finish-load", () => {
    if (retryTargets.get(instanceId) === win.webContents.getURL()) return;
    reloadStates.delete(instanceId);
  });

  // 防御性兜底：渲染进程主框架导航到应用页面之外的 URL 一律阻止，
  // 只放行错误页的“重新加载”目标一次。
  win.webContents.on("will-navigate", (event, targetUrl) => {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl && targetUrl.startsWith(devServerUrl)) return;
    if (retryTargets.get(instanceId) === targetUrl) {
      retryTargets.delete(instanceId);
      reloadStates.delete(instanceId);
      return;
    }
    event.preventDefault();
  });

  void win.loadURL(buildPageUrl(instanceId, url, tabs)).catch((error) => {
    console.error("Failed to load detached browser window:", error);
  });
};

/** 关闭所有独立浏览器窗口（应用退出时调用，避免残留孤儿窗口）。 */
export const closeAllDetachedBrowserWindows = (): void => {
  for (const state of reloadStates.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  reloadStates.clear();
  retryTargets.clear();
  for (const win of detachedWindows.values()) {
    if (!win.isDestroyed()) win.close();
  }
  detachedWindows.clear();
};
