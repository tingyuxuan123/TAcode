import { app, BrowserWindow } from "electron";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyMessageList } from "./message-list-smoke";

/**
 * 消息列表窗口化的真实 Electron 回归入口（由 `scripts/test-browser.mjs` 构建并启动）。
 * 只需一个窗口 + 固定尺寸，不启动主进程 IPC：探针页面自带全部数据。
 */
async function smoke() {
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const profile = await mkdtemp(path.join(tmpdir(), "tacode-message-list-smoke-"));
  app.setPath("userData", profile);
  const fixture = process.env.TACODE_MESSAGE_LIST_FIXTURE;
  if (!fixture) throw new Error("缺少 TACODE_MESSAGE_LIST_FIXTURE");

  const window = new BrowserWindow({
    width: 1120,
    height: 780,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const watchdog = setTimeout(() => {
    console.error("Message list smoke timed out");
    app.exit(1);
  }, 60_000);

  let failed = false;
  try {
    window.webContents.on("console-message", (event, ...rest) => {
      const message = typeof event === "object" && event !== null && "message" in event ? (event as { message?: string }).message : rest[0];
      if (typeof message === "string" && /error|Error|Uncaught/.test(message)) console.error("[renderer]", message);
    });
    await window.loadFile(fixture, { query: { turns: "150" } });
    await verifyMessageList(window);
    if (process.env.TACODE_BROWSER_ARTIFACTS) {
      const image = await window.webContents.capturePage();
      await writeFile(path.join(process.env.TACODE_BROWSER_ARTIFACTS, "message-list-electron.png"), image.toPNG());
    }
    console.log("Message list smoke passed: 150 turns window down to a handful of mounted rows, jump/底部留白/跟随 全部保持.");
  } catch (error) {
    console.error("Message list smoke failed", error);
    failed = true;
  } finally {
    clearTimeout(watchdog);
    if (!window.isDestroyed()) window.destroy();
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    app.exit(failed ? 1 : 0);
  }
}

void smoke();
