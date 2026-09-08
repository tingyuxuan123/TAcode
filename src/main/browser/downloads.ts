import { app, Notification, session, shell, type DownloadItem, type WebContents } from "electron";

/**
 * webview 下载管理：session 无 will-download 监听器时 Electron 会直接取消
 * 下载，网页 a[download] / Blob 下载全部静默失效。
 *
 * 每次下载弹保存对话框让用户选择保存地址（取消即放弃下载），
 * 列表与进度实时推送到宿主窗口（browser:downloads-updated）。
 */

export type BrowserDownloadItem = {
  id: number;
  url: string;
  filename: string;
  /** 保存路径（保存对话框确认后可用；取消时为空）。 */
  path: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  endedAt: number | null;
};

const downloads = new Map<number, BrowserDownloadItem>();
/** 进行中的 DownloadItem 引用（cancel 用）。 */
const activeItems = new Map<number, DownloadItem>();

let nextDownloadId = 1;
let installed = false;

const snapshot = (): BrowserDownloadItem[] =>
  Array.from(downloads.values()).sort((a, b) => b.startedAt - a.startedAt);

/** 推送列表快照到 webContents 的宿主窗口。 */
const pushSnapshot = (webContents: WebContents | null): void => {
  if (!webContents || webContents.isDestroyed()) return;
  const host = webContents.hostWebContents ?? webContents;
  if (!host.isDestroyed()) host.send("browser:downloads-updated", snapshot());
};

export const listDownloads = (): BrowserDownloadItem[] => snapshot();

export const openDownload = async (id: number): Promise<boolean> => {
  const item = downloads.get(id);
  if (!item || !item.path) return false;
  return shell.openPath(item.path).then((error) => error === "");
};

export const showDownloadInFolder = (id: number): void => {
  const item = downloads.get(id);
  if (item?.path) shell.showItemInFolder(item.path);
};

export const cancelDownload = (id: number): boolean => {
  const active = activeItems.get(id);
  if (!active) return false;
  try {
    active.cancel();
    return true;
  } catch {
    return false;
  }
};

/** 在 defaultSession 上安装 will-download 处理（幂等）。 */
export const installWebviewDownloadHandler = (): void => {
  if (installed) return;
  installed = true;

  session.defaultSession.on("will-download", (_event, item, webContents) => {
    // 保存对话框：每个下载由用户选择保存地址；取消即放弃下载。
    item.setSaveDialogOptions({
      title: "保存文件",
      defaultPath: app.getPath("downloads") + "/" + item.getFilename(),
    });

    const record: BrowserDownloadItem = {
      id: nextDownloadId,
      url: item.getURL(),
      filename: item.getFilename(),
      path: "",
      state: "progressing",
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
      endedAt: null,
    };
    downloads.set(record.id, record);
    activeItems.set(record.id, item);

    item.on("updated", (_e, state) => {
      record.state = state === "progressing" ? "progressing" : "interrupted";
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.path = item.getSavePath();
      pushSnapshot(webContents);
    });

    item.once("done", (_e, state) => {
      record.state = state;
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.path = item.getSavePath();
      record.endedAt = Date.now();
      activeItems.delete(record.id);
      pushSnapshot(webContents);
      if (state !== "cancelled" && Notification.isSupported()) {
        new Notification({
          title: state === "completed" ? "下载完成" : "下载失败",
          body: record.filename,
          silent: state !== "completed",
        }).show();
      }
    });
  });
};
