import { app, BrowserWindow, ipcMain, net, protocol } from "electron";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { BrowserAutomation } from "../src/main/browser/automation";
import { verifyPanelResize } from "./panel-resize-smoke";
import { PREVIEW_SCHEME } from "../src/shared/types";
import type { BrowserParams, BrowserPresentation, BrowserRegistration, BrowserToolResult } from "../src/shared/browser-tools";

// 与主进程一致：预览协议必须是 standard/secure，webview 才能加载相对资源。
protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// Runs real BrowserPanel + Chromium guests against an ephemeral local fixture, never a user profile.
async function smoke() {
app.on("window-all-closed", () => {});
let failed = false;
let lastTool = "startup";
const root = process.cwd();
const profile = await mkdtemp(path.join(tmpdir(), "tether-browser-smoke-"));
app.setPath("userData", profile);
const preload = path.join(profile, "preload.cjs");
await writeFile(preload, `require(${JSON.stringify(path.join(root, "dist-electron/preload/index.cjs"))});\nconst { ipcRenderer } = require('electron');\ntry { localStorage.setItem('tether.browserHomepage', JSON.stringify('about:blank')); } catch {}\nipcRenderer.on('browser:agent-presentation', (_event, value) => { if (value.action === 'open') ipcRenderer.send('smoke:open', value); });`);
const windows: BrowserWindow[] = [];
let main: BrowserWindow;
// 本地预览夹具：一个临时工作区，验证不启动静态服务器也能在面板里看到页面。
const previewRoot = await mkdtemp(path.join(tmpdir(), "tether-browser-preview-"));
await mkdir(path.join(previewRoot, "demo"), { recursive: true });
const previewPage = (heading: string): string => `<!doctype html><meta charset="utf-8"><title>预览页面</title>
<h1 id="heading">${heading}</h1><p id="asset">资源未加载</p><script src="./app.js"></script>`;
const writePreview = (heading: string) => writeFile(path.join(previewRoot, "demo", "index.html"), previewPage(heading));
await writePreview("预览页面");
await writeFile(path.join(previewRoot, "demo", "app.js"), `document.querySelector("#asset").textContent = "相对资源已加载";`);
const automation = new BrowserAutomation(() => main, () => previewRoot);
const page = `<!doctype html><meta charset="utf-8"><title>浏览器操作测试</title>
<style>body{font:18px sans-serif;padding:24px}input,button,select{font-size:18px;margin:6px}#editor{border:1px solid;min-height:30px}#scroller{height:80px;overflow:auto}#hovered{display:none}#hover:hover #hovered{display:block}</style>
<main><h1>本地测试表单</h1><form><label>搜索<input aria-label="搜索"></label><button>提交</button></form><p role="status" id="result">尚未提交</p><p id="trusted"></p>
<label>国家<select aria-label="国家"><option value="">请选择</option><option value="CN">中国</option></select></label>
<div id="editor" contenteditable="true" role="textbox" aria-label="备注"></div><div id="shadow"></div>
<button id="hover">悬浮菜单<span id="hovered">菜单已展开</span></button>
<div id="scroller"><div style="height:900px">内部滚动内容</div></div><div style="height:900px"></div><p>页面底部</p></main>
<script>window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('#trusted').textContent=String(e.isTrusted);window.submits++;setTimeout(()=>document.querySelector('#result').textContent='已提交：'+document.querySelector('input').value,120)};document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow 按钮</button>';</script>`;
const server = createServer(async (request, response) => {
  if (request.url === "/slow") await new Promise((resolve) => setTimeout(resolve, 300));
  response.setHeader("content-type", "text/html; charset=utf-8");
  if (request.url === "/large") { response.end('<button style="position:fixed;left:0;top:0;width:200px;height:2000px" onclick="document.querySelector(\'#result\').textContent=\'大元素已点击\';this.remove()">巨大按钮</button><p id="result">未点击</p>'); return; }
  if (request.url === "/replace") { response.end('<style>button{position:fixed;left:600px;top:120px;width:180px;height:80px}</style><button onclick="document.querySelector(\'#result\').textContent=\'误点B\'">底层按钮B</button><button onmouseenter="this.remove()">浮层按钮A</button><p id="result">未点击B</p>'); return; }
  response.end(request.url === "/slow" ? page.replace("<title>浏览器操作测试</title>", "<title>延迟加载的新文档</title>") : page);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
function open(instanceId: string, url: string) {
  const win = new BrowserWindow({ width: 1000, height: 780, show: true, webPreferences: { preload, sandbox: false, contextIsolation: true, nodeIntegration: false, webviewTag: true } });
  windows.push(win);
  void win.loadFile(path.join(root, "dist/browser-window.html"), { query: { instanceId, url } });
  return win;
}
function json(result: BrowserToolResult): any {
  const content = result.content.find((part) => part.type === "text");
  assert(content?.type === "text");
  return JSON.parse(content.text);
}
const run = async (tool: string, params: BrowserParams = {}, signal = new AbortController().signal) => { lastTool = `${tool} ${JSON.stringify(params)}`; return json(await automation.execute(tool, params, signal)); };
const find = async (name: string, role?: string, tabId?: string) => {
  const result = await run("browser_find", { name, exact: true, ...(role ? { role } : {}), ...(tabId ? { tabId } : {}) });
  assert.equal(result.elements.length, 1, `expected one ${name}: ${JSON.stringify(result)}`);
  return result.elements[0].ref as string;
};
const watchdog = setTimeout(() => { console.error("Browser smoke test timed out"); app.exit(1); }, 60000);
try {
  await app.whenReady();
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    const name = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
    return net.fetch(pathToFileURL(path.join(previewRoot, name)).toString());
  });
  ipcMain.handle("browser:webview-preload-path", () => pathToFileURL(path.join(root, "dist-electron/preload/webview-browser.cjs")).href);
  ipcMain.handle("browser:downloads-list", () => []);
  ipcMain.handle("app:get-locale", () => "zh-CN");
  ipcMain.handle("browser-passwords:find", () => null);
  ipcMain.handle("browser-passwords:save", () => null);
  ipcMain.on("browser:presentation-ready", (event, requestId: string) => automation.presentationReady(event.sender, requestId));
  ipcMain.handle("browser:register-tab", (event, registration: BrowserRegistration) => automation.register(event.sender, registration));
  ipcMain.on("smoke:open", (_event, event: BrowserPresentation) => { if (event.action === "open") open(event.instanceId, event.url); });
  main = open("smoke-main", "about:blank");
  await new Promise<void>((resolve) => main.webContents.once("did-finish-load", resolve));
  // Wait for the actual React panel's first guest registration.
  while ((await run("browser_list_tabs")).tabs.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
  lastTool = "panel resize across native webview";
  await verifyPanelResize(main);
  const first = (await run("browser_list_tabs")).tabs[0].tabId;
  await run("browser_select_tab", { tabId: first });
  // 回归：模型会给可选参数补空串（tabId:""），不得因此让整次调用失败。
  const observed = await run("browser_navigate", { tabId: "", url });
  assert.equal(observed.title, "浏览器操作测试");
  assert(observed.elements.some((item: any) => item.name === "搜索"));
  let ref = await find("搜索", "textbox");
  await run("browser_fill", { ref, text: "中文输入 hello world" });
  ref = await find("提交", "button");
  const clicked = await run("browser_click", { ref, waitKind: "text", waitValue: "已提交：中文输入 hello world" });
  assert.equal(clicked.result.matched, true);
  assert.equal((await run("browser_extract", { selector: "#trusted" })).result.text, "true");
  assert((await run("browser_extract", { selector: "#result" })).result.text.includes("中文输入 hello world"));
  await run("browser_select_option", { ref: await find("国家", "combobox"), value: "CN" });
  await run("browser_fill", { ref: await find("备注", "textbox"), text: "多行备注\n第二行" });
  assert((await run("browser_extract", { selector: "#editor" })).result.text.includes("第二行"));
  await run("browser_fill", { ref: await find("备注", "textbox"), text: "" });
  assert.equal((await run("browser_extract", { selector: "#editor" })).result.text, "");
  await run("browser_dom", { action: "click", selector: "#shadow >>> button" });
  await run("browser_hover", { ref: await find("悬浮菜单", "button") });
  assert.equal((await run("browser_wait_for", { kind: "selector", value: "#hovered" })).result.matched, true);
  assert((await run("browser_scroll", { selector: "#scroller", position: "bottom" })).result.scrollTop > 0);
  const screenshot = await automation.execute("browser_screenshot", {}, new AbortController().signal);
  assert(screenshot.content.some((part) => part.type === "image" && part.data.length > 100));
  await main.webContents.executeJavaScript("document.querySelector('.browser-tab-new').click()");
  while ((await run("browser_list_tabs")).tabs.length < 2) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await run("browser_list_tabs")).workingTabId, first);
  assert((await run("browser_extract", { selector: "#result" })).result.text.includes("中文输入 hello world"));
  await run("browser_fill", { ref: await find("搜索", "textbox"), text: "后台标签恢复" });
  await run("browser_press", { key: "Enter" });
  assert.equal((await run("browser_wait_for", { kind: "text", value: "已提交：后台标签恢复" })).result.matched, true);
  const stale = await find("搜索", "textbox");
  await run("browser_navigate", { url: `${url}/next` });
  await assert.rejects(run("browser_fill", { ref: stale, text: "不得写入" }), /过期|失效/);
  assert.equal((await run("browser_navigate", { url: `${url}/slow` })).title, "延迟加载的新文档");
  const second = (await run("browser_new_tab", { url })).tabId;
  assert.notEqual(first, second);
  const otherRef = await find("搜索", "textbox", first);
  await assert.rejects(run("browser_fill", { tabId: second, ref: otherRef, text: "不得写入" }), /其他标签/);
  assert.equal((await run("browser_list_tabs")).workingTabId, second);
  const timeout = await run("browser_wait_for", { kind: "text", value: "永远不会出现", timeoutMs: 250 });
  assert.equal(timeout.result.matched, false);
  const controller = new AbortController();
  const wait = run("browser_wait_for", { kind: "text", value: "永远不会出现" }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const queued = run("browser_navigate", { url: `${url}/must-not-navigate` }, controller.signal);
  controller.abort();
  await assert.rejects(wait, /取消|aborted/);
  await assert.rejects(queued, /取消|aborted/);
  assert(!(await run("browser_list_tabs")).tabs.find((item: any) => item.tabId === second).url.includes("must-not-navigate"));
  await run("browser_navigate", { url: `${url}/large` });
  assert.equal((await run("browser_click", { ref: await find("巨大按钮", "button"), waitKind: "text", waitValue: "大元素已点击" })).result.matched, true);
  await run("browser_navigate", { url: `${url}/replace` });
  await assert.rejects(run("browser_click", { ref: await find("浮层按钮A", "button") }), /替换|移除/);
  assert.equal((await run("browser_extract", { selector: "#result" })).result.text, "未点击B");
  // 本地文件预览：path → harness-preview，无静态服务器；相对资源可用，文件变更自动刷新。
  const preview = await run("browser_navigate", { path: "demo/index.html" });
  assert.equal(preview.title, "预览页面");
  assert(preview.url.startsWith(`${PREVIEW_SCHEME}://`), `expected preview scheme url, got ${preview.url}`);
  assert.equal((await run("browser_extract", { selector: "#asset" })).result.text, "相对资源已加载");
  await writePreview("预览页面 v2");
  let reloaded = false;
  for (let attempt = 0; attempt < 40 && !reloaded; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    reloaded = (await run("browser_extract", { selector: "#heading" })).result.text === "预览页面 v2";
  }
  assert(reloaded, "preview did not live reload after the file changed");
  await assert.rejects(run("browser_navigate", { path: "demo/missing.html" }), /未找到该工作区文件/);
  await run("browser_close_tab", { tabId: second });
  assert.equal((await run("browser_list_tabs")).workingTabId, null);
  console.log("Browser smoke passed: real React BrowserPanel, navigation, AX refs, trusted click, Chinese fill, contenteditable, select, Shadow DOM, hover, scroll, screenshot, stale/cross-tab refs, waits, cancellation, blank-param tolerance, workspace file preview and live reload, close.");
} catch (error) {
  console.error(`Failed after ${lastTool}`, error);
  failed = true;
} finally {
  clearTimeout(watchdog);
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Temporary, isolated test profile only.
  await rm(profile, { recursive: true, force: true });
  await rm(previewRoot, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}

}
void smoke().catch((error) => { console.error(error); app.exit(1); });
