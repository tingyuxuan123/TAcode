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
  const profile = await mkdtemp(path.join(tmpdir(), "tacode-workbench-smoke-"));
  app.setPath("userData", profile);
  const preload = path.join(profile, "preload.cjs");
  await writeFile(preload, `require(${JSON.stringify(path.join(root, "dist-electron/preload/index.cjs"))});\nlocalStorage.setItem('tacode.browserHomepage', JSON.stringify('about:blank'));`);
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
    // 子代理子会话转录：面板只读展示，桩掉主进程读盘通道。
    ipcMain.handle("sessions:read", (_event, sessionPath: string) => ({
      sessionPath,
      messages: [
        { role: "user", content: [{ type: "text", text: "子代理转录内容：分析委派链路" }] },
        { role: "assistant", content: [{ type: "text", text: "报告：委派链路与状态机已核对" }] },
      ],
      totalMessages: 2,
      truncated: false,
    }));
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
    if (!process.env.TACODE_COMPOSER_ONLY) {
    main = createWindow();
    await main.loadFile(process.env.TACODE_WORKBENCH_FIXTURE!);
    await wait(async () => (await labels()).includes("审查"));
    const inlineTabHeight = await host("document.querySelector('.inspect-tabs').getBoundingClientRect().height");

    if (!process.env.TACODE_TITLE_ONLY) {
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
    await wait(async () => host("!!document.querySelector('.panel-add-menu')"));
    await host("Array.from(document.querySelectorAll('.panel-add-item')).find(el => el.textContent === '新建标签页').click()");
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
    if (process.env.TACODE_BROWSER_ARTIFACTS) await writeFile(path.join(process.env.TACODE_BROWSER_ARTIFACTS, "single-tabs-electron.png"), (await main.webContents.capturePage()).toPNG());
    console.log("Workbench smoke passed: one tab bar, titles, Agent/manual/link creation, native background click, preserved input/guest, close, committed URLs, detached multi-page restore and narrow tab overflow.");
    }

    stage = "actual Chat panel expands beyond 480px and adapts to its container";
    main = createWindow(true);
    main.setSize(1440, 620);
    await main.loadFile(process.env.TACODE_WORKBENCH_FIXTURE!, { query: {
      chat: "true",
      title: "请使用 Three.js 制作一个完整的博丽神社微缩三维场景。场景必须建立在一个完整的正方形底座上，底座拥有清晰的石砌侧面。",
    } });
    await wait(async () => (await labels()).includes("审查"));
    await run("browser_new_tab", { url });
    stage = "tabs occupy the window header and release vertical content space";
    await verifyWorkbenchHeader(main, inlineTabHeight, { titleOnly: Boolean(process.env.TACODE_TITLE_ONLY) });
    if (process.env.TACODE_TITLE_ONLY) {
      if (process.env.TACODE_BROWSER_ARTIFACTS) await writeFile(path.join(process.env.TACODE_BROWSER_ARTIFACTS, "session-title-header-electron.png"), (await main.webContents.capturePage()).toPNG());
      return;
    }
    stage = "adaptive widths and automatic sidebar collapse with top header";
    const expandedScreenshot = await verifyAdaptivePanelWidth(main);
    if (process.env.TACODE_BROWSER_ARTIFACTS) await writeFile(path.join(process.env.TACODE_BROWSER_ARTIFACTS, "expanded-panel-electron.png"), expandedScreenshot);

    stage = "collapsible sidebar, native icon actions and wider browser";
    await run("browser_new_tab", { url });
    const sidebarScreenshot = await verifySidebar(main);
    if (process.env.TACODE_BROWSER_ARTIFACTS) await writeFile(path.join(process.env.TACODE_BROWSER_ARTIFACTS, "collapsed-sidebar-electron.png"), sidebarScreenshot);

    stage = "subagent session opens as a side-panel tab and the main conversation stays put";
    await host("document.querySelector('[data-fixture-child-session] .session-row').click()");
    await wait(async () => (await labels()).includes("分析子代理链路"));
    assert.equal(await host("document.querySelector('.inspect-tab.active .inspect-tab-label').textContent"), "分析子代理链路");
    assert(await host("document.querySelector('.conversation').textContent.includes('对话区保持可用')"), "main conversation must stay");
    assert.equal(await host("document.querySelector('.conversation [role=status]').textContent"), "已打开子代理标签");
    // 全出血形态：不再套审查面板的内边距，滚动交给面板自己
    assert.equal(await host("getComputedStyle(document.querySelector('.inspect-body')).paddingTop"), "0px");
    assert.equal(await host("getComputedStyle(document.querySelector('.inspect-body')).overflowY"), "hidden");
    await wait(async () => host("document.querySelector('.child-session-body').textContent.includes('子代理转录内容')"));
    assert.equal(await host("document.querySelector('.child-session-role').textContent"), "explorer");
    assert(await host("document.querySelector('.child-session-head').textContent.includes('48 个步骤')"), "header meta");

    stage = "delegation card in the main conversation opens the same kind of tab";
    await host("document.querySelector('[data-fixture-delegate-turn] .flow-tool-line').click()");
    await wait(async () => host("!!document.querySelector('[data-fixture-delegate-turn] .delegate-task')"));
    await host("document.querySelector('[data-fixture-delegate-turn] .delegate-task').click()");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await host("!!document.querySelector('.delegate-drawer')"), false, "card click must not open the drawer");
    assert((await labels()).includes("分析委派链路"), "card click must open the child-session tab");
    await host("document.querySelector('[data-fixture-delegate-turn] .delegate-task-details').click()");
    await wait(async () => host("!!document.querySelector('.delegate-drawer')"), "info button still opens the drawer");
    await host("document.querySelector('.delegate-drawer .drawer-close').click()");

    stage = "in-process delegation without a session file still opens a tab with its report";
    await host("document.querySelector('[data-fixture-inline-turn] .flow-tool-line').click()");
    await wait(async () => host("!!document.querySelector('[data-fixture-inline-turn] .delegate-task')"));
    await host("document.querySelector('[data-fixture-inline-turn] .delegate-task').click()");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await host("!!document.querySelector('.delegate-drawer')"), false, "in-process delegation must not open the drawer");
    assert((await labels()).includes("跑一遍聚焦测试"), "in-process card must open a tab");
    const visibleHost = "Array.from(document.querySelectorAll('.child-session-host')).filter(el => getComputedStyle(el).display !== 'none')[0]";
    assert(await host(`${visibleHost}.textContent.includes('WorkbenchPanelTab')`), "report fallback");
    assert(await host(`${visibleHost}.textContent.includes('pnpm test')`), "activity fallback");
    // 卡片与侧栏是同一个委派（delegation-1）→ 标签栏只应出现一次，且内容仍是子会话转录。
    assert.equal(await host("Array.from(document.querySelectorAll('.child-session-host')).length"), 2, "两个委派各一个标签（含进程内那张卡片）");
    assert.equal(await host("Array.from(document.querySelectorAll('.inspect-tab-label')).filter(el => el.textContent === '分析委派链路').length"), 1, "同一个委派只出现一次");
    assert(await host(`${visibleHost}.textContent.includes('子代理转录内容')`), "同一标签内容保持一致");

    stage = "report markdown wraps short table labels on one line and keeps a readable scale";
    const layout = await host(`(() => {
      const panel = ${visibleHost};
      const report = panel.querySelector('.child-session-report');
      const cs = (el) => getComputedStyle(el);
      const lineBoxes = (el) => { const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects().length; };
      const wrap = report.querySelector('.md-table-wrap');
      const tight = Array.from(report.querySelectorAll('th.is-tight, td.is-tight'));
      const chip = report.querySelector('.file-chip-name');
      const code = report.querySelector('p code');
      return {
        tightCount: tight.length,
        tightLines: tight.map(lineBoxes),
        tightText: tight.map((el) => el.textContent),
        wrapOverflow: wrap ? wrap.scrollWidth - wrap.clientWidth : null,
        fontSize: parseFloat(cs(report).fontSize),
        lineHeight: parseFloat(cs(report).lineHeight),
        listIndent: parseFloat(cs(report.querySelector('ul')).paddingLeft),
        chipFont: chip ? parseFloat(cs(chip).fontSize) : null,
        codeBg: code ? cs(code).backgroundColor : null,
      };
    })()`);
    assert(layout.tightCount >= 4, `short table labels must be marked: ${JSON.stringify(layout)}`);
    assert(layout.tightLines.every((count: number) => count === 1), `short labels must stay on one line: ${JSON.stringify(layout)}`);
    assert(layout.wrapOverflow !== null && layout.wrapOverflow <= 1, `table must not overflow: ${JSON.stringify(layout)}`);
    assert(layout.fontSize >= 12.5, `report body font too small: ${JSON.stringify(layout)}`);
    assert(layout.lineHeight / layout.fontSize >= 1.5, `report line height too tight: ${JSON.stringify(layout)}`);
    assert(layout.listIndent <= 22, `list indent too deep: ${JSON.stringify(layout)}`);
    assert(layout.chipFont !== null && layout.chipFont >= 11, `file chip too small: ${JSON.stringify(layout)}`);
    assert(layout.codeBg !== null && layout.codeBg !== "rgba(0, 0, 0, 0)", `inline code must keep a background: ${JSON.stringify(layout)}`);
    if (process.env.TACODE_BROWSER_ARTIFACTS) {
      await writeFile(path.join(process.env.TACODE_BROWSER_ARTIFACTS, "report-layout.json"), `${JSON.stringify(layout, null, 2)}\n`);
      await writeFile(path.join(process.env.TACODE_BROWSER_ARTIFACTS, "report-layout-electron.png"), (await main.webContents.capturePage()).toPNG());
    }
    console.log(`Report layout passed: ${layout.tightCount} short labels on one line each, table fits, body ${layout.fontSize}px/${layout.lineHeight}px, list indent ${layout.listIndent}px, chip ${layout.chipFont}px.`);
    console.log("Subagent panel passed: sidebar row and card context open one read-only transcript tab per delegation, main conversation untouched.");

    stage = "creating a subagent auto-opens its session tab and keeps it live";
    const autoBefore = await host("document.querySelectorAll('.child-session-host').length");
    await host("document.querySelector('[data-fixture-start-delegation]').click()");
    await wait(async () => (await host("document.querySelectorAll('.child-session-host').length")) === autoBefore + 1);
    // 首次出现抢焦点（与 Proma 一致）
    assert.equal(await host("document.querySelector('.inspect-tab.active .inspect-tab-label').textContent"), "动态委派：统计行数");
    assert(await host("Array.from(document.querySelectorAll('.child-session-host')).some(el => el.textContent.includes('正在读取 src/main/index.ts'))"), "running step must be visible");
    // 运行期刷新不抢焦点：切到审查标签后让委派完成，焦点必须留在审查
    await host("Array.from(document.querySelectorAll('.inspect-tab')).find(el => el.textContent.includes('审查')).click()");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await host("document.querySelector('[data-fixture-advance-delegation]').click()");
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await host("document.querySelector('.inspect-tab.active .inspect-tab-label').textContent"), "审查", "live refresh must not steal focus");
    assert(await host("Array.from(document.querySelectorAll('.child-session-host')).some(el => el.textContent.includes('已完成') && el.textContent.includes('7 个步骤'))"), "header must follow the delegation status");
    console.log("Subagent auto-open passed: creation opens the child-session tab, live header updates never steal focus.");
    }

    stage = "responsive composer controls and all options in the overflow menu";
    main = createWindow(true);
    main.setSize(900, 620);
    await main.loadFile(process.env.TACODE_WORKBENCH_FIXTURE!, { query: { composer: "true" } });
    const composerScreenshots = await verifyComposerToolbar(main);
    if (process.env.TACODE_BROWSER_ARTIFACTS) {
      await writeFile(path.join(process.env.TACODE_BROWSER_ARTIFACTS, "composer-icons-electron.png"), composerScreenshots.icons);
      await writeFile(path.join(process.env.TACODE_BROWSER_ARTIFACTS, "composer-menu-electron.png"), composerScreenshots.menu);
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
