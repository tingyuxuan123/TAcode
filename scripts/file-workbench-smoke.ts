import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { registerFileIpc } from "../src/main/files/file-ipc";
import { registerGitIpc } from "../src/main/git/git-ipc";
import { WorkspaceFileIndex } from "../src/main/workspace-file-index";
import { WorkspaceWatchers } from "../src/main/workspace-watcher";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function smoke() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "tacode-file-workbench-"));
  const artifacts = process.env.TACODE_FILE_WORKBENCH_ARTIFACTS ?? await fs.mkdtemp(path.join(tmpdir(), "tacode-file-workbench-artifacts-"));
  await fs.mkdir(artifacts, { recursive: true });
  app.setPath("userData", path.join(directory, "profile")); app.on("window-all-closed", () => {});
  const a = path.join(directory, "project-a"); const b = path.join(directory, "project-b");
  const write = async (root: string, name: string, content: string) => { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); };
  const content = Array.from({ length: 600 }, (_, i) => `PROJECT_A line ${String(i).padStart(3, "0")} const value = ${i};`).join("\n");
  await write(a, "same.txt", content); await write(b, "same.txt", "PROJECT_B same path"); await write(a, "other.ts", "export const other = 1;\n");
  await write(a, "colon.txt:12", "LITERAL_COLON"); await write(a, ".hidden/nested/source.txt", "HIDDEN_CONTENT"); await write(a, "node_modules/pkg/source.txt", "IGNORED_CONTENT");
  await write(a, "a:1", "LITERAL_SHORT_COLON");
  for (let n = 0; n < 8105; n += 100) await Promise.all(Array.from({ length: Math.min(100, 8105 - n) }, (_, i) => write(a, `deep/file-${String(n + i).padStart(5, "0")}.txt`, `INDEXED_${n + i}`)));
  const git = async (root: string, args: string[]) => promisify(execFile)("git", ["-C", root, ...args]);
  for (const root of [a, b]) { await git(root, ["init", "--initial-branch=main"]); await git(root, ["config", "user.name", "Fixture"]); await git(root, ["config", "user.email", "fixture@example.test"]); await git(root, ["add", "same.txt"]); await git(root, ["commit", "-m", "fixture"]); }
  await write(a, "same.txt", content + "\nGIT_CHANGE");
  await app.whenReady();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] }]));
  const window = new BrowserWindow({ width: 1460, height: 840, show: true, webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const errors: string[] = []; const network: string[] = []; const stages: string[] = [];
  window.webContents.on("console-message", (event) => { if (event.level === "error") { errors.push(event.message); console.error("[renderer]", event.message); } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
  const index = new WorkspaceFileIndex(); let closing = false;
  const watchers = new WorkspaceWatchers((root, paths) => { if (paths) for (const value of paths) index.changed(root, value); else index.changed(root); if (!closing && !window.isDestroyed()) window.webContents.send("workspace:changed", { root, paths }); });
  const resolveProject = async (root: string) => { if (root !== a && root !== b) throw new Error("Unknown project"); return root; };
  const files = registerFileIpc({ host: () => window.webContents, index, resolveProject, watchProject: (root) => { if (watchers.watch(root)) index.changed(root); } });
  const review = registerGitIpc({ host: () => window.webContents, resolveProject, recoveryRoot: path.join(directory, "recovery") });
  const reads: Array<{ root: string; path: string }> = []; const readDocument = files.service.readDocument.bind(files.service);
  files.service.readDocument = (request) => { reads.push({ root: request.projectRoot, path: request.path }); return readDocument(request); };
  ipcMain.handle("app:get-locale", () => "zh"); ipcMain.handle("app:set-locale", () => {});
  ipcMain.handle("workspace:list", async (_event, root: string, refresh?: boolean) => { await resolveProject(root); if (watchers.watch(root)) index.changed(root); return index.list(root, refresh); });
  const evaluate = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true);
  let stage = "startup";
  const wait = async (code: string, label: string, timeout = 10_000) => { const start = Date.now(); while (!await evaluate(code)) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${stage}: ${label}`); await delay(35); } };
  const select = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0)`;
  const point = (selector: string, fraction = .5) => evaluate<{ x: number; y: number }>(`(()=>{const el=${select(selector)};if(!el)throw Error('Missing selector');const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width*${fraction}),y:Math.round(r.top+r.height/2)}})()`);
  const click = async (selector: string, button: "left" | "right" = "left", twice = false) => {
    window.focus(); window.webContents.focus();
    await wait("document.visibilityState==='visible'", "native input visibility");
    const p = await point(selector); window.webContents.sendInputEvent({ type: "mouseDown", ...p, button, clickCount: 1 }); window.webContents.sendInputEvent({ type: "mouseUp", ...p, button, clickCount: 1 });
    if (twice) { await delay(50); window.webContents.sendInputEvent({ type: "mouseDown", ...p, button, clickCount: 2 }); window.webContents.sendInputEvent({ type: "mouseUp", ...p, button, clickCount: 2 }); }
    await delay(80);
  };
  const key = async (name: string, modifiers: string[] = []) => { const keyCode = name.replace(/^Arrow/, ""); window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers }); window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers }); await delay(50); };
  const search = async (value: string) => { await click(".workbench-file-filter input"); await evaluate(`${select(".workbench-file-filter input")}.select()`); await key("Backspace"); if (value) await window.webContents.insertText(value); await delay(80); };
  const row = (name: string) => `[data-tree-path=${JSON.stringify(name)}]`;
  const activePanel = `[...document.querySelectorAll('[data-file-active="true"]')].find(el=>el.dataset.filePath)`;
  const body = `${activePanel}?.querySelector('.cm-content')`;
  const tabs = () => evaluate<Array<{ id: string; path: string; preview: boolean }>>("[...document.querySelectorAll('[data-file-preview]')].map(el=>({id:el.dataset.panelId,path:el.querySelector('.inspect-tab-label').textContent,preview:el.dataset.filePreview==='true'}))");
  const tabSelector = (id: string) => `[data-panel-id=${JSON.stringify(id)}]`;
  const ready = (marker: string) => wait(`${body}?.textContent.includes(${JSON.stringify(marker)})`, marker);
  const capture = async (name: string) => { await delay(120); await fs.writeFile(path.join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG()); };
  const record = (name: string) => { stage = name; stages.push(name); console.log(`[files/workbench] ${name}`); };
  const watchdog = setTimeout(() => { console.error(`File workbench timed out: ${stage}`); app.exit(1); }, 180_000);
  let refreshMs = 0;
  try {
    await window.loadFile(process.env.TACODE_FILE_WORKBENCH_FIXTURE!, { query: { project: a } });
    await wait(`${select(row("same.txt"))}`, "production tree");
    assert.equal(await evaluate("typeof window.require"), "undefined");
    await search("file-08001"); await wait(`${select(row("deep/file-08001.txt"))}`, "8001"); await click(row("deep/file-08001.txt")); await ready("INDEXED_8001");
    await search("file-00200"); await wait(`${select(row("deep/file-00200.txt"))}`, "201"); await click(row("deep/file-00200.txt"), "left", true); await ready("INDEXED_200"); assert.equal((await tabs()).length, 1);
    await wait("document.querySelector('[data-file-preview=" + JSON.stringify("false") + "]')", "pinned");
    await search("same.txt"); await click(row("same.txt")); await ready("PROJECT_A"); assert.equal((await tabs()).length, 2); await capture("01-file-tree-tabs");
    record("Complete production index: file 201/8001, preview replacement and native double-click pin");

    await search("colon.txt:12"); await click(row("colon.txt:12")); await ready("LITERAL_COLON"); assert.ok(reads.some((request) => request.path === "colon.txt:12"));
    await click('[data-tool-id="read-colon"] .flow-tool-line'); await ready("LITERAL_COLON");
    assert.equal((await tabs()).filter((tab) => tab.path === "colon.txt:12").length, 1);
    assert.equal(reads.some((request) => request.path === "colon.txt"), false);
    await search("a:1"); await click(row("a:1")); await ready("LITERAL_SHORT_COLON");
    await search(""); await click(row(".hidden")); await wait(`${select(row(".hidden/nested"))}`, "hidden nested"); await click(row(".hidden/nested")); await wait(`${select(row(".hidden/nested/source.txt"))}`, "hidden source"); await click(row(".hidden/nested/source.txt")); await ready("HIDDEN_CONTENT");
    await search("node_modules"); await click(row("node_modules")); await wait(`${select(row("node_modules/pkg"))}`, "ignored package"); await click(row("node_modules/pkg")); await wait(`${select(row("node_modules/pkg/source.txt"))}`, "ignored source"); await click(row("node_modules/pkg/source.txt")); await ready("IGNORED_CONTENT");
    await search("other.ts"); await evaluate(`${select(".workbench-tree-row")}.focus()`); await key("Home"); await key("End"); await key("Enter"); await ready("export const other");
    record("Hidden/ignored directory expansion, literal colon filename and native tree keyboard open");

    await evaluate("window.fileWorkbenchFixture.setHidden(true)"); await wait("document.querySelector('.inspect').getBoundingClientRect().width===0", "closed drawer");
    await click(".file-chip"); await ready("PROJECT_A"); await wait("window.fileWorkbenchFixture.editor().selectionLine===120", "Markdown line/column");
    assert.equal(await evaluate("window.fileWorkbenchFixture.editor().column"), 3);
    await click('[data-tool-id="read-file"] .flow-tool-line'); await ready("PROJECT_A");
    await click(".changes button"); await ready("PROJECT_A");
    assert.equal((await tabs()).filter((tab) => tab.path === "same.txt").length, 1);
    await click('[data-panel-id="review"]'); await wait("document.querySelector('[data-review-state=ready]')", "Git snapshot"); await search("same.txt"); await wait("document.querySelector('[data-diff-path=" + JSON.stringify("same.txt") + "]')", "Git diff header");
    await click('[data-diff-path="same.txt"] button[aria-label="打开"]'); await ready("PROJECT_A");
    record("Markdown, process rows, change summary and real Git review share one project/path tab and open the drawer");

    let currentTabs = await tabs(); const same = currentTabs.find((tab) => tab.path === "same.txt")!; const indexed = currentTabs.find((tab) => tab.path === "file-00200.txt")!;
    await click(tabSelector(same.id), "right"); await wait("document.querySelector('.file-tab-menu')", "tab menu"); await capture("02-tab-context-menu");
    await click('.file-tab-menu button:first-child'); assert.equal((await tabs()).find((tab) => tab.id === same.id)?.preview, false);
    // Native pointer capture exercises a drop before the first file without an OS drag session.
    const start = await point(tabSelector(same.id)); const end = await point(tabSelector(indexed.id), .2);
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...start });
    for (let i = 1; i <= 12; i++) { window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(start.x + (end.x - start.x) * i / 12), y: Math.round(start.y + (end.y - start.y) * i / 12), button: "left", modifiers: ["leftButtonDown"] }); await delay(30); }
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...end }); await delay(100);
    assert.equal((await tabs())[0]?.id, same.id, JSON.stringify(await evaluate("window.fileWorkbenchFixture.nativeEvents")));
    await click(tabSelector(same.id)); await evaluate(`${select(tabSelector(same.id))}.focus()`); await key("ArrowRight", ["control", "shift"]);
    assert.equal((await tabs())[1]?.id, same.id, JSON.stringify(await evaluate("window.fileWorkbenchFixture.nativeEvents")));
    record("Native tab menu pin, drag reorder and keyboard reorder");

    await click(tabSelector(same.id)); await ready("PROJECT_A");
    await evaluate("window.fileWorkbenchFixture.setPosition(3000, 150)");
    await click('button[aria-label="在文件树中定位"]'); await wait(`${select(row("same.txt"))}`, "locate clears filter");
    await click('.workbench-divider'); await key("ArrowLeft"); await key("ArrowLeft");
    const width = await evaluate(`${activePanel}.querySelector('[role=separator]').getAttribute('aria-valuenow')`);
    await search(""); await evaluate(`(()=>{const tree=${activePanel}.querySelector('.workbench-tree-list');tree.scrollTop=84;tree.dispatchEvent(new Event('scroll'))})()`);
    await delay(250); const beforePosition = await evaluate("window.fileWorkbenchFixture.editor()");
    const before = performance.now(); await write(a, "same.txt", content + "\nEXTERNAL_CHANGE");
    await wait("window.fileWorkbenchFixture.editor().content.endsWith('EXTERNAL_CHANGE')", "external revalidation", 2000); refreshMs = performance.now() - before;
    assert.ok(refreshMs < 1100, `external update took ${refreshMs}ms`);
    await wait(`window.fileWorkbenchFixture.editor().top===${beforePosition.top}`, "append scroll settled");
    const afterPosition = await evaluate("window.fileWorkbenchFixture.editor()"); assert.equal(afterPosition.top, beforePosition.top); assert.equal(afterPosition.from, beforePosition.from);
    await write(a, "same.txt", content.replaceAll("line", "text") + "\nEXTERNAL_REPLACEMENT");
    await wait("window.fileWorkbenchFixture.editor().content.endsWith('EXTERNAL_REPLACEMENT')", "whole-document replacement");
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    assert.equal(await evaluate("window.fileWorkbenchFixture.editor().top"), beforePosition.top);
    assert.equal(await evaluate("window.fileWorkbenchFixture.editor().from"), beforePosition.from);
    await click(".file-chip"); await wait("window.fileWorkbenchFixture.editor().selectionLine===120", "repeated location");
    await evaluate("window.fileWorkbenchFixture.setPosition(3000, 150)");
    await evaluate(`(()=>{const tree=${activePanel}.querySelector('.workbench-tree-list');tree.scrollTop=84;tree.dispatchEvent(new Event('scroll'))})()`); await delay(250);
    const savedPosition = await evaluate("window.fileWorkbenchFixture.editor()"); await capture("03-file-scroll-selection");
    record("Locate/filter reset, width/selection/scroll persistence and timely external update");

    await evaluate(`window.fileWorkbenchFixture.setRoot(${JSON.stringify(b)})`); await wait("window.fileWorkbenchFixture.state().root===" + JSON.stringify(b), "project b");
    assert.equal((await tabs()).length, 0); await click('[data-panel-id="files"]'); await wait(`${select(row("same.txt"))}`, "b tree"); await click(row("same.txt")); await ready("PROJECT_B");
    await evaluate("window.fileWorkbenchFixture.setSession('session-2')"); await delay(150); assert.equal((await tabs()).length, 0);
    await click('[data-panel-id="files"]'); await wait(`${select(row("same.txt"))}`, "session2"); await click(row("same.txt")); await ready("PROJECT_B");
    await evaluate("window.fileWorkbenchFixture.setSession('session-1')"); await ready("PROJECT_B");
    await evaluate(`window.fileWorkbenchFixture.setRoot(${JSON.stringify(a)})`); await ready("PROJECT_A");
    await wait(`window.fileWorkbenchFixture.editor().top===${savedPosition.top}`, "project reading position restored");
    assert.equal(await evaluate("window.fileWorkbenchFixture.editor().top"), savedPosition.top); assert.equal(await evaluate(`${activePanel}.querySelector('[role=separator]').getAttribute('aria-valuenow')`), width);
    await evaluate("window.fileWorkbenchFixture.setSession('session-2')"); await delay(150); assert.equal((await tabs()).length, 0);
    await click('[data-panel-id="files"]'); await search("same.txt"); await click(row("same.txt")); await ready("PROJECT_A");
    await write(a, "same.txt", content.replaceAll("line", "text") + "\nSESSION_TWO_CHANGE");
    await wait("window.fileWorkbenchFixture.editor().content.endsWith('SESSION_TWO_CHANGE')", "second session disk update");
    await evaluate("window.fileWorkbenchFixture.setSession('session-1')"); await ready("PROJECT_A");
    await wait(`window.fileWorkbenchFixture.editor().top===${savedPosition.top}`, "hidden session reading position preserved");
    assert.equal(await evaluate("window.fileWorkbenchFixture.editor().from"), savedPosition.from);
    await delay(250); currentTabs = await tabs();
    await evaluate("location.reload()"); await wait("!!window.fileWorkbenchFixture", "reload fixture"); await ready("PROJECT_A");
    await wait(`window.fileWorkbenchFixture.editor().top===${savedPosition.top}`, `reload reading position restored to ${savedPosition.top}`);
    assert.deepEqual(await tabs(), currentTabs); assert.equal(await evaluate("window.fileWorkbenchFixture.editor().top"), savedPosition.top); assert.equal(await evaluate("window.fileWorkbenchFixture.editor().from"), savedPosition.from);
    assert.equal(await evaluate(`${activePanel}.querySelector('[role=separator]').getAttribute('aria-valuenow')`), width);
    await wait(`${activePanel}.querySelector('.workbench-tree-list').scrollTop===84`, "tree scroll restore");
    record("Two same-name projects/sessions stay isolated; reload restores tab order, active file, width and reading positions");

    await click(tabSelector(same.id), "right"); await wait("document.querySelector('.file-tab-menu')", "close others menu");
    await evaluate("[...document.querySelectorAll('.file-tab-menu button')].find(el=>el.textContent.includes('关闭其他文件标签')).click()");
    assert.equal((await tabs()).length, 1); assert.ok(await evaluate("document.querySelector('[data-panel-id=files]')&&document.querySelector('[data-panel-id=review]')"));
    await evaluate("window.fileWorkbenchFixture.setLocale('en')"); await wait("document.querySelector('button[aria-label=" + JSON.stringify("Locate in file tree") + "]')", "English toolbar");
    window.setSize(1000, 720); await capture("04-narrow-english");
    const overflowing = await evaluate("[...document.querySelectorAll('.workbench-toolbar button')].filter(el=>{const r=el.getBoundingClientRect(),p=el.closest('.workbench-toolbar').getBoundingClientRect();return r.width>0&&(r.left<p.left-1||r.right>p.right+1)}).length"); assert.equal(overflowing, 0);
    const activeReads = reads.length; await evaluate("window.fileWorkbenchFixture.setHidden(true)"); await wait("document.querySelector('.inspect').getBoundingClientRect().width===0", "hidden panel");
    await delay(100); await write(a, "same.txt", "HIDDEN_REFRESH"); await delay(450); assert.equal(reads.length, activeReads);
    await evaluate("window.fileWorkbenchFixture.setHidden(false)"); await ready("HIDDEN_REFRESH");
    await wait("window.fileWorkbenchFixture.state().hidden===false", "reshown");
    window.destroy(); await files.idle(); await review.idle(); await delay(100);
    assert.equal(files.service.subscriptions.stats().subscriptions, 0); assert.equal(files.service.subscriptions.stats().roots, 0); assert.equal(review.service.stats().subscriptions, 0);
    record("Close other files preserves tool panels; English/narrow layout, hidden pause/reactivation and owner cleanup");
    assert.deepEqual(network, []); assert.deepEqual(errors, []);
    const result = { date: new Date().toISOString(), platform: platform(), os: release(), stages, refreshMs, errors, network, resources: files.service.subscriptions.stats(), git: review.service.stats(), artifacts, boundary: "Production preload/files+Git IPC and WorkbenchPanels with native Chromium mouse/keyboard; temporary APFS projects. Text remains read-only pending FR-08." };
    await fs.writeFile(path.join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n"); await fs.writeFile(path.resolve("docs/file-review-reference/fr-07-result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    if (!window.isDestroyed()) { await capture("failure").catch(() => {}); await fs.writeFile(path.join(artifacts, "failure.html"), await evaluate<string>("document.body.outerHTML")).catch(() => {}); }
    const position = !window.isDestroyed() ? await evaluate("(()=>{const editor=window.fileWorkbenchFixture?.editor();return editor?{top:editor.top,from:editor.from,to:editor.to}:null})()").catch(() => null) : null;
    await fs.writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ stage, error: String(error), position, errors, resources: files.service.subscriptions.stats(), artifacts }, null, 2)); console.error(`Artifacts: ${artifacts}; position: ${JSON.stringify(position)}`); throw error;
  } finally { clearTimeout(watchdog); closing = true; files.dispose(); review.dispose(); await files.idle(); await review.idle(); watchers.close(); if (!window.isDestroyed()) window.destroy(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
void smoke().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
