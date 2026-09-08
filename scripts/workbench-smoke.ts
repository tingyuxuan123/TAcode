import { app, BrowserWindow, ipcMain, webContents } from "electron";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { BrowserAutomation } from "../src/main/browser/automation";
import { initBrowserPopupHandler } from "../src/main/browser/popups";
import { verifyAdaptivePanelWidth } from "./panel-resize-smoke";
import { verifySidebar } from "./sidebar-smoke";
import { verifyWorkbenchHeader } from "./workbench-header-smoke";
import { verifyComposerToolbar } from "./composer-toolbar-smoke";
import type { BrowserParams, BrowserRegistration, BrowserToolResult } from "../src/shared/browser-tools";
import type { BrowserRestorePayload, BrowserTabSnapshot } from "../src/shared/types";

// Uses the production WorkbenchPanels + BrowserPanel in an isolated Chromium profile.
async function smoke() {
  app.on("window-all-closed", () => {});
  const root = process.cwd();
  const profile = await mkdtemp(path.join(tmpdir(), "tether-workbench-smoke-"));
  app.setPath("userData", profile);
  const preload = path.join(profile, "preload.cjs");
  await writeFile(preload, `require(${JSON.stringify(path.join(root, "dist-electron/preload/index.cjs"))});\nlocalStorage.setItem('tether.browserHomepage', JSON.stringify('about:blank'));`);
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    const title = request.url === "/second" ? "页面乙" : request.url === "/third" ? "页面丙" : "页面甲";
    response.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:18px sans-serif;padding:24px}input,a{display:block;margin:20px}</style><h1>${title}</h1><input aria-label="保留输入"><a href="/second" target="_blank">前台链接</a><a href="/third" target="_blank">后台链接</a>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const windows: BrowserWindow[] = [];
  let main: BrowserWindow;
  let detached: BrowserWindow | undefined;
  let detachedSnapshot: BrowserTabSnapshot[] = [];
  let restoredSnapshot: BrowserTabSnapshot[] = [];
  let stage = "startup";
  let failed = false;
  const automation = new BrowserAutomation(() => main);
  const json = (result: BrowserToolResult): any => {
    const part = result.content.find((part) => part.type === "text");
    assert(part?.type === "text");
    return JSON.parse(part.text);
  };
  const run = async (tool: string, params: BrowserParams = {}) => json(await automation.execute(tool, params, new AbortController().signal));
  const wait = async (predicate: () => Promise<boolean>) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out: ${stage}`);
  };
  const host = (script: string, win = main) => win.webContents.executeJavaScript(script);
  const labels = () => host("Array.from(document.querySelectorAll('.inspect-tab-label'), el => el.textContent)");
  const tabs = async () => (await run("browser_list_tabs")).tabs as Array<{ tabId: string; instanceId: string; url: string }>;
  const guest = async (tabId: string, win = main) => {
    const id = await host(`document.querySelector('[data-tab-id="${tabId}"]').getWebContentsId()`, win);
    return webContents.fromId(id)!;
  };
  const clickMenu = async (text: string, win = main) => {
    await host("Array.from(document.querySelectorAll('button[aria-label=\"更多操作\"]')).find(el => el.getBoundingClientRect().width > 0).click()", win);
    await wait(async () => host(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(el => el.textContent.includes(${JSON.stringify(text)}))`, win));
    await host(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(el => el.textContent.includes(${JSON.stringify(text)})).click()`, win);
  };
  const createWindow = (workbench = false) => {
    const win = new BrowserWindow({
      width: 760, height: 620, show: true,
      ...(workbench && process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 14 } } : {}),
      webPreferences: { preload, sandbox: false, contextIsolation: true, nodeIntegration: false, webviewTag: true },
    });
    windows.push(win);
    return win;
  };
  const watchdog = setTimeout(() => { console.error(`Workbench smoke timeout: ${stage}`); app.exit(1); }, 90000);
  try {
    await app.whenReady();
    initBrowserPopupHandler();
    ipcMain.handle("browser:webview-preload-path", () => pathToFileURL(path.join(root, "dist-electron/preload/webview-browser.cjs")).href);
    ipcMain.handle("browser:downloads-list", () => []);
    ipcMain.handle("app:get-locale", () => "zh-CN");
    ipcMain.handle("workspace:list", () => []);
    ipcMain.handle("browser-passwords:find", () => null);
    ipcMain.handle("browser-passwords:save", () => null);
    ipcMain.on("browser:presentation-ready", (event, id: string) => automation.presentationReady(event.sender, id));
    ipcMain.handle("browser:register-tab", (event, registration: BrowserRegistration) => automation.register(event.sender, registration));
    ipcMain.handle("browser:open-detached-window", (_event, instanceId: string, initialUrl: string, pages: BrowserTabSnapshot[]) => {
      detachedSnapshot = pages;
      detached = createWindow();
      detached.on("closed", () => { if (!main.isDestroyed()) main.webContents.send("browser:detached-window-closed", { instanceId }); });
      void detached.loadFile(path.join(root, "dist/browser-window.html"), { query: { instanceId, url: initialUrl, tabs: JSON.stringify(pages) } });
    });
    ipcMain.on("browser:restore-to-main", (event, payload: BrowserRestorePayload) => {
      restoredSnapshot = payload.tabs;
      main.webContents.send("browser:restore-to-main-broadcast", payload);
      BrowserWindow.fromWebContents(event.sender)?.close();
    });
    if (!process.env.TETHER_COMPOSER_ONLY) {
    main = createWindow();
    await main.loadFile(process.env.TETHER_WORKBENCH_FIXTURE!);
    await wait(async () => (await labels()).includes("审查"));
    const inlineTabHeight = await host("document.querySelector('.inspect-tabs').getBoundingClientRect().height");

    stage = "Agent creates a single top-level page";
    const first = (await run("browser_new_tab", { url })).tabId;
    await wait(async () => (await labels()).includes("页面甲"));
    assert.equal(await host("document.querySelectorAll('[role=tablist]').length"), 1);
    assert.equal(await host("document.querySelectorAll('.browser-tab-bar').length"), 0);
    const inputRef = (await run("browser_find", { role: "textbox", name: "保留输入", exact: true })).elements[0].ref;
    await run("browser_fill", { ref: inputRef, text: "切换后保留" });
    const originalGuest = await guest(first);
    const foreground = (await run("browser_find", { role: "link", name: "前台链接", exact: true })).elements[0].ref;
    await run("browser_click", { ref: foreground });
    await wait(async () => (await labels()).includes("页面乙") && (await tabs()).length === 2);
    assert.equal((await tabs()).length, 2);
    assert.equal(await host("document.querySelector('.inspect-tab.active .inspect-tab-label').textContent"), "页面乙");

    stage = "switching preserves guests and background links preserve selection";
    await run("browser_select_tab", { tabId: first });
    assert.equal((await guest(first)).id, originalGuest.id);
    assert.equal(await originalGuest.executeJavaScript("document.querySelector('input').value"), "切换后保留");
    // Native middle click exercises the real guest preload relay and background disposition.
    const point = await originalGuest.executeJavaScript("(() => {const r=document.querySelector('a[href=\"/third\"]').getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+10)}})()");
    originalGuest.sendInputEvent({ type: "mouseDown", button: "middle", clickCount: 1, ...point });
    originalGuest.sendInputEvent({ type: "mouseUp", button: "middle", clickCount: 1, ...point });
    await wait(async () => (await labels()).includes("页面丙") && (await tabs()).length === 3);
    assert.equal(await host("document.querySelector('.inspect-tab.active .inspect-tab-label').textContent"), "页面甲");
    assert.equal((await tabs()).length, 3);

    stage = "manual plus and Agent close share the top-level lifecycle";
    await host("document.querySelector('.inspect-tab-add').click()");
    await wait(async () => (await tabs()).length === 4);
    const manual = (await tabs()).find((tab) => tab.url === "about:blank")!;
    await run("browser_close_tab", { tabId: manual.tabId });
    await wait(async () => (await tabs()).length === 3);
    assert.equal(await host("document.querySelectorAll('.inspect-tab').length"), 4);

    stage = "actual navigation URL, title and address draft survive detaching correctly";
    await run("browser_select_tab", { tabId: first });
    await originalGuest.executeJavaScript("history.pushState({}, '', '/committed');document.title='导航后的页面甲'");
    await wait(async () => (await labels()).includes("导航后的页面甲"));
    // A draft in the address field must not replace the committed navigation in migration snapshots.
    await host("(() => {const el=Array.from(document.querySelectorAll('.browser-address-input')).find(el=>el.getBoundingClientRect().width>0); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(el,'https://draft.invalid/');el.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await clickMenu("在新窗口中打开");
    await wait(async () => !!detached && await host("document.querySelectorAll('.browser-tab').length === 1", detached));
    assert.equal(detachedSnapshot[0].url, `${url}/committed`);
    assert.equal(detachedSnapshot[0].title, "导航后的页面甲");
    await host("document.querySelector('.browser-tab-new').click()", detached);
    await wait(async () => (await tabs()).some((tab) => tab.url === "about:blank"));
    const newDetached = (await tabs()).find((tab) => tab.url === "about:blank")!;
    await run("browser_navigate", { tabId: newDetached.tabId, url: `${url}/second` });
    await clickMenu("还原为标签页", detached);
    await wait(async () => (await tabs()).length === 4 && await host("document.querySelectorAll('.browser-webview').length === 4"));
    assert.deepEqual(restoredSnapshot.map((page) => page.url), [`${url}/second`, `${url}/committed`]);
    assert.equal(await host("document.querySelectorAll('.browser-tab-bar').length"), 0);
    assert.equal(await host("document.querySelectorAll('[role=tablist]').length"), 1);
    assert.equal(await host("document.querySelector('.inspect-tab.active .inspect-tab-label').textContent"), "页面乙");

    stage = "narrow panels keep the selected title and plus accessible";
    const lastTab = (await tabs()).find((tab) => tab.url.endsWith("/third"))!;
    const longTitle = "本地项目文档：一个需要省略展示的较长网页标题";
    await (await guest(lastTab.tabId)).executeJavaScript(`document.title=${JSON.stringify(longTitle)}`);
    await wait(async () => (await labels()).includes(longTitle));
    main.setSize(320, 620);
    await host("document.querySelectorAll('.inspect-tab')[4].click()");
    await wait(async () => (await host("document.querySelector('.inspect-tab.active .inspect-tab-label').textContent")) === longTitle);
    await wait(async () => host("(() => {const list=document.querySelector('.inspect-tab-list'),tab=list.querySelector('.active');const a=list.getBoundingClientRect(),b=tab.getBoundingClientRect();return list.scrollWidth>list.clientWidth&&b.right<=a.right+1&&b.left>=a.left-1})()"));
    assert(await host("(() => {const r=document.querySelector('.inspect-tab-add').getBoundingClientRect();return r.right<=innerWidth&&r.width>0})()"));
    assert(await host("(() => {const label=document.querySelector('.inspect-tab.active .inspect-tab-label');return label.scrollWidth>label.clientWidth&&label.closest('button').title.includes(label.textContent)})()"));
    await host("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    if (process.env.TETHER_BROWSER_ARTIFACTS) await writeFile(path.join(process.env.TETHER_BROWSER_ARTIFACTS, "single-tabs-electron.png"), (await main.webContents.capturePage()).toPNG());
    console.log("Workbench smoke passed: one tab bar, titles, Agent/manual/link creation, native background click, preserved input/guest, close, committed URLs, detached multi-page restore and narrow tab overflow.");

    stage = "actual Chat panel expands beyond 480px and adapts to its container";
    main = createWindow(true);
    main.setSize(1440, 620);
    await main.loadFile(process.env.TETHER_WORKBENCH_FIXTURE!, { query: { chat: "true" } });
    await wait(async () => (await labels()).includes("审查"));
    await run("browser_new_tab", { url });
    stage = "tabs occupy the window header and release vertical content space";
    await verifyWorkbenchHeader(main, inlineTabHeight);
    stage = "adaptive widths and automatic sidebar collapse with top header";
    const expandedScreenshot = await verifyAdaptivePanelWidth(main);
    if (process.env.TETHER_BROWSER_ARTIFACTS) await writeFile(path.join(process.env.TETHER_BROWSER_ARTIFACTS, "expanded-panel-electron.png"), expandedScreenshot);

    stage = "collapsible sidebar, native icon actions and wider browser";
    await run("browser_new_tab", { url });
    const sidebarScreenshot = await verifySidebar(main);
    if (process.env.TETHER_BROWSER_ARTIFACTS) await writeFile(path.join(process.env.TETHER_BROWSER_ARTIFACTS, "collapsed-sidebar-electron.png"), sidebarScreenshot);
    }

    stage = "responsive composer controls and all options in the overflow menu";
    main = createWindow(true);
    main.setSize(900, 620);
    await main.loadFile(process.env.TETHER_WORKBENCH_FIXTURE!, { query: { composer: "true" } });
    const composerScreenshots = await verifyComposerToolbar(main);
    if (process.env.TETHER_BROWSER_ARTIFACTS) {
      await writeFile(path.join(process.env.TETHER_BROWSER_ARTIFACTS, "composer-icons-electron.png"), composerScreenshots.icons);
      await writeFile(path.join(process.env.TETHER_BROWSER_ARTIFACTS, "composer-menu-electron.png"), composerScreenshots.menu);
    }
  } catch (error) {
    console.error(`Workbench smoke failed after ${stage}`, error);
    failed = true;
  } finally {
    clearTimeout(watchdog);
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    app.exit(failed ? 1 : 0);
  }
}
void smoke();
