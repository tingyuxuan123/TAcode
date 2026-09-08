import { app, BrowserWindow, ipcMain, nativeTheme, type WebContents } from "electron";

/**
 * 内置浏览器（<webview>）弹出窗口与标签页管理。
 *
 * 移植自 Snow App（MIT）src/main/browser/browserPopupWindow.ts。
 * guest 页面调用 window.open() 或点击 target=_blank 时，Electron 37 的
 * <webview> 不再触发 new-window 事件；且 guest 默认 disablePopups=true，
 * 除非标签带 allowpopups 属性（渲染端以字符串 "true" 写入，React 会丢弃
 * 未知布尔属性）。请求进入 setWindowOpenHandler 后按打开方式分流：
 *
 * 1. 窗口级弹出（disposition=new-popup，或 features 声明 popup=yes /
 *    width / height，如 OAuth 弹窗）：创建真实 BrowserWindow，保留
 *    window.opener / postMessage 关系并与 webview 共享 session。
 * 2. 标签页级打开（target=_blank、无 features 的 window.open）：deny 并
 *    经 browser:open-tab 通知宿主渲染进程在浏览器面板内新建标签页。
 *
 * 注意：webview guest 内用户点击 target=_blank 因 Electron bug
 * （electron#30886）不触发 setWindowOpenHandler，由 guest preload
 * （webview-browser）拦截点击后经 browser:guest-open-tab 中继到这里，
 * 与主进程路径按 guestId+URL 去重汇合。
 */

const DEFAULT_POPUP_WIDTH = 800;
const DEFAULT_POPUP_HEIGHT = 640;
const MIN_POPUP_WIDTH = 320;
const MIN_POPUP_HEIGHT = 240;
const MAX_POPUP_WIDTH = 1600;
const MAX_POPUP_HEIGHT = 1200;

/** 通知宿主渲染进程：guest 请求在浏览器面板内新建标签页。 */
export const BROWSER_OPEN_TAB_CHANNEL = "browser:open-tab";

/** guest preload 拦截 target=_blank 链接后发送的通道。 */
const GUEST_OPEN_TAB_CHANNEL = "browser:guest-open-tab";

/**
 * 短时间窗口内同 guest 同 URL 的「新建标签页」通知去重：
 * 链接激活有两路上报（guest preload 拦截 + setWindowOpenHandler），
 * 未来 Electron 修复该 bug 后会两路同时到达。
 */
const OPEN_TAB_NOTIFY_DEDUPE_MS = 300;
const recentOpenTabNotifies = new Map<string, number>();

const notifyHostOpenTab = (guest: WebContents, url: string, disposition: string): void => {
  const host = guest.hostWebContents;
  if (!host || host.isDestroyed()) return;
  const key = `${guest.id}\u0000${url}`;
  const now = Date.now();
  const last = recentOpenTabNotifies.get(key);
  if (last !== undefined && now - last < OPEN_TAB_NOTIFY_DEDUPE_MS) return;
  recentOpenTabNotifies.set(key, now);
  if (recentOpenTabNotifies.size > 128) {
    for (const [expiredKey, time] of recentOpenTabNotifies) {
      if (now - time >= OPEN_TAB_NOTIFY_DEDUPE_MS) recentOpenTabNotifies.delete(expiredKey);
    }
  }
  host.send(BROWSER_OPEN_TAB_CHANNEL, { guestWebContentsId: guest.id, url, disposition });
};

const popupWindows = new Set<BrowserWindow>();

const getPopupBackgroundColor = (): string =>
  nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";

/** 解析 window.open() features 字符串中的宽高（如 "popup=yes,width=500,height=600"）。 */
const parseWindowFeatures = (features: string): { width: number; height: number } => {
  const widthMatch = /(?:^|,)\s*width\s*=\s*(\d+)/i.exec(features);
  const heightMatch = /(?:^|,)\s*height\s*=\s*(\d+)/i.exec(features);
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), max);
  return {
    width: widthMatch
      ? clamp(parseInt(widthMatch[1], 10), MIN_POPUP_WIDTH, MAX_POPUP_WIDTH)
      : DEFAULT_POPUP_WIDTH,
    height: heightMatch
      ? clamp(parseInt(heightMatch[1], 10), MIN_POPUP_HEIGHT, MAX_POPUP_HEIGHT)
      : DEFAULT_POPUP_HEIGHT,
  };
};

/** 相对发起窗口居中计算弹出窗口位置（发起窗口不可见时交给系统默认定位）。 */
const computeCenteredPosition = (
  opener: BrowserWindow | null,
  width: number,
  height: number,
): { x: number; y: number } | undefined => {
  if (!opener || opener.isDestroyed() || opener.isMinimized()) return undefined;
  const bounds = opener.getBounds();
  return {
    x: Math.round(bounds.x + (bounds.width - width) / 2),
    y: Math.round(bounds.y + (bounds.height - height) / 2),
  };
};

/** 判断一次 window.open / target=_blank 是否属于「窗口级弹出」。 */
const isWindowPopupRequest = (disposition: string, features: string): boolean => {
  if (disposition === "new-popup") return true;
  if (/\bpopup\s*=\s*(?:yes|1|true)/i.test(features)) return true;
  if (/\b(?:width|height)\s*=/.test(features)) return true;
  return false;
};

/**
 * 为指定 webContents（webview guest 或已创建的弹出窗口）注册弹出处理：
 * 窗口级弹出创建真实 BrowserWindow；标签页级打开 deny 并通知渲染端建 tab。
 */
export const attachBrowserPopupWindowHandler = (
  contents: WebContents,
  options?: { openTabsInSidebar?: boolean },
): void => {
  contents.setWindowOpenHandler(({ url, disposition, features }) => {
    if (options?.openTabsInSidebar && !isWindowPopupRequest(disposition, features)) {
      notifyHostOpenTab(contents, url, disposition);
      return { action: "deny" };
    }

    const { width, height } = parseWindowFeatures(features);
    const opener = BrowserWindow.fromWebContents(contents);
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        ...computeCenteredPosition(opener, width, height),
        width,
        height,
        minWidth: MIN_POPUP_WIDTH,
        minHeight: MIN_POPUP_HEIGHT,
        autoHideMenuBar: true,
        backgroundColor: getPopupBackgroundColor(),
        show: false,
        webPreferences: {
          // 弹出窗口是纯网页，无需 Node 能力，保持沙箱开启。
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
    };
  });

  // did-create-window 仅在 setWindowOpenHandler 返回 allow 且窗口创建成功时触发。
  contents.on("did-create-window", (win) => {
    popupWindows.add(win);
    win.setMenu(null);
    win.setMenuBarVisibility(false);
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) win.show();
    });
    win.once("closed", () => {
      popupWindows.delete(win);
    });
    // 弹出窗口内的 window.open 递归走同一逻辑；不传 openTabsInSidebar，
    // OAuth 二次弹窗保持 window.opener 链，不会路由到浏览器面板。
    attachBrowserPopupWindowHandler(win.webContents);
  });
};

/** 初始化：为所有 webview guest 注册弹出处理（幂等）。 */
export const initBrowserPopupHandler = (): void => {
  // guest preload 拦截 target=_blank / 中键激活后的中继：校验 sender 必须是
  // webview guest（guest 受 contextIsolation 保护无法直接触达 ipcRenderer），
  // 转发给宿主窗口由渲染端在浏览器面板内新建标签页。
  if (!ipcGuestRelayInstalled) {
    ipcGuestRelayInstalled = true;
    ipcMain.on(GUEST_OPEN_TAB_CHANNEL, (event, payload) => {
      const guest = event.sender;
      if (guest.getType() !== "webview" || !payload || typeof payload !== "object") return;
      const record = payload as { url?: unknown; disposition?: unknown };
      if (typeof record.url !== "string" || !record.url) return;
      notifyHostOpenTab(
        guest,
        record.url,
        typeof record.disposition === "string" ? record.disposition : "foreground-tab",
      );
    });
  }

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return;
    attachBrowserPopupWindowHandler(contents, { openTabsInSidebar: true });
  });
};

let ipcGuestRelayInstalled = false;

/** 关闭所有浏览器弹出窗口（主窗口关闭时调用，避免 macOS 残留孤儿窗口）。 */
export const closeAllBrowserPopups = (): void => {
  for (const win of popupWindows) {
    if (!win.isDestroyed()) win.close();
  }
  popupWindows.clear();
};
