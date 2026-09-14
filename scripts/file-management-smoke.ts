import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, ipcMain, Menu, shell } from "electron";
import { registerFileIpc } from "../src/main/files/file-ipc";
import { registerGitIpc } from "../src/main/git/git-ipc";
import { WorkspaceFileIndex } from "../src/main/workspace-file-index";
import { WorkspaceWatchers } from "../src/main/workspace-watcher";
import { WindowCloseGuard } from "../src/main/window-close-guard";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function smoke() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-file-management-"));
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-file-management-artifacts-"));
  const a = path.join(directory, "project-a"); const b = path.join(directory, "project-b"); const stages: string[] = []; const errors: string[] = []; const network: string[] = [];
  await fs.mkdir(a); await fs.mkdir(b); await fs.mkdir(path.join(directory, "trash"));
  await fs.mkdir(path.join(a, "dir")); await fs.writeFile(path.join(a, "dir/same.txt"), Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n"));
  await fs.writeFile(path.join(b, "same.txt"), "PROJECT_B\n"); await fs.writeFile(path.join(a, "other.txt"), "OTHER\n");
  const executable = path.join(directory, "editor"); const argsFile = path.join(directory, "editor-args");
  const quoted = `'${argsFile.replaceAll("'", "'\\''")}'`;
  await fs.writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > ${quoted}\n`); await fs.chmod(executable, 0o755);
  app.setPath("userData", path.join(directory, "profile")); app.on("window-all-closed", () => {}); await app.whenReady();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] }]));
  const window = new BrowserWindow({ width: 1460, height: 840, show: true, webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const guard = new WindowCloseGuard(window); let closing = false; const systemOpened: string[] = []; const revealed: string[] = []; let failTrash = false; let nativeTrashMode = false;
  window.webContents.on("console-message", (event) => { if (event.level === "error") { errors.push(event.message); console.error(event.message); } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
  const index = new WorkspaceFileIndex(); const watchers = new WorkspaceWatchers((root, paths) => {
    if (paths) for (const file of paths) index.changed(root, file); else index.changed(root);
    if (!closing && !window.isDestroyed()) window.webContents.send("workspace:changed", { root, paths });
  });
  const resolveProject = async (root: string) => { if (root !== a && root !== b) throw new Error("Unknown project"); return root; };
  const files = registerFileIpc({ host: () => window.webContents, index, resolveProject, draftRoot: path.join(directory, "drafts"),
    watchProject: (root) => { if (watchers.watch(root)) index.changed(root); }, editorCandidates: () => [executable],
    openPath: async (file) => { systemOpened.push(file); return ""; }, reveal: (file) => { revealed.push(file); },
    trash: async (file) => { if (failTrash) throw new Error("fixture native trash failure"); if (nativeTrashMode) await shell.trashItem(file); else await fs.rename(file, path.join(directory, "trash", path.basename(file))); } });
  const git = registerGitIpc({ host: () => window.webContents, resolveProject, recoveryRoot: path.join(directory, "git-recovery") });
  ipcMain.handle("app:get-locale", () => "zh"); ipcMain.handle("app:set-locale", () => {});
  ipcMain.handle("workspace:list", async (_event, root: string, refresh?: boolean) => { await resolveProject(root); if (watchers.watch(root)) index.changed(root); return index.list(root, refresh); });
  const evaluate = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true);
  const fixture = "window.fileWorkbenchFixture"; const editor = `${fixture}.editor()`;
  const visible = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0)`;
  const wait = async (code: string, label: string, timeout = 12_000) => { const start = Date.now(); while (!await evaluate(code)) { if (Date.now() - start > timeout) throw new Error(`Timeout after ${stages.at(-1)}: ${label}`); await delay(30); } };
  const click = async (selector: string, button: "left" | "right" = "left") => {
    window.focus(); window.webContents.focus(); const point = await evaluate(`(()=>{const el=${visible(selector)};if(!el)throw Error('Missing '+${JSON.stringify(selector)});const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    window.webContents.sendInputEvent({ type: "mouseDown", ...point, button, clickCount: 1 }); window.webContents.sendInputEvent({ type: "mouseUp", ...point, button, clickCount: 1 }); await delay(70);
  };
  const mod = process.platform === "darwin" ? "meta" : "control";
  const key = async (keyCode: string, modifiers: string[] = []) => { window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers }); window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers }); await delay(40); };
  const type = async (selector: string, text: string) => { await click(selector); await key("a", [mod]);
    await evaluate(`(()=>{const el=${visible(selector)};if(el instanceof HTMLInputElement)el.select()})()`);
    await window.webContents.insertText(text); await delay(50); };
  const dialog = "dialog[open]";
  const command = async (label: string) => {
    await evaluate(`(()=>{const dialogs=[...document.querySelectorAll('dialog[open]')];const top=dialogs.at(-1);const button=[...top.querySelectorAll('button')].find(el=>el.textContent===${JSON.stringify(label)});if(!button)throw Error('Missing '+${JSON.stringify(label)});button.dataset.nativeTarget='true'})()`);
    await click('dialog[open] [data-native-target="true"]'); await evaluate("document.querySelectorAll('[data-native-target]').forEach(el=>delete el.dataset.nativeTarget)");
  };
  const rootFiles = async () => { await click('[data-panel-id="files"]'); await wait(`${visible('.project-file-tree-tools')}`, "root tree"); };
  const filter = async (name: string) => { await type('[data-file-active="true"] .workbench-file-filter input', name); await wait(`${visible(`[data-tree-path=${JSON.stringify(name)}]`)}`, "filtered row"); };
  const open = async (name: string) => { await rootFiles(); await filter(name); await click(`[data-file-active="true"] [data-tree-path=${JSON.stringify(name)}]`); await wait(`${fixture}.state().tabs.find(tab=>tab.id===${fixture}.state().active)?.path===${JSON.stringify(name)}&&${editor}?.content!==undefined`, "active document"); };
  const menu = async (name: string, action: string) => {
    await filter(name); await click(`[data-file-active="true"] [data-tree-path=${JSON.stringify(name)}]`, "right"); await wait("document.querySelector('.file-action-menu:popover-open')", "native context menu");
    await wait(`document.querySelector('.file-action-menu [data-file-action=${JSON.stringify(action)}]')`, "menu action"); await click(`.file-action-menu [data-file-action=${JSON.stringify(action)}]`);
  };
  const record = (name: string) => { stages.push(name); console.log(`[file/management] ${name}`); };
  const capture = async (name: string) => { await delay(100); await fs.writeFile(path.join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG()); };
  const watchdog = setTimeout(() => { console.error("File management timeout"); app.exit(1); }, 160_000);
  try {
    await window.loadFile(process.env.TACODE_FILE_WORKBENCH_FIXTURE!, { query: { project: a } }); await wait(`!!${fixture}`, "fixture"); await rootFiles();
    await click('[data-file-active="true"] button[aria-label="新建文件夹"]'); await type('[data-file-name]', "目录 空格"); await key("Enter"); await wait("!document.querySelector('dialog[open]')", "folder created");
    assert.equal((await fs.stat(path.join(a, "目录 空格"))).isDirectory(), true);
    await click('[data-file-active="true"] button[aria-label="新建文件"]'); await type('[data-file-name]', "目录 空格/a:2 $(literal).txt"); await key("Enter"); await wait(`${editor}?.content===''`, "new file opens pinned");
    assert.equal(await fs.readFile(path.join(a, "目录 空格/a:2 $(literal).txt"), "utf8"), ""); assert.equal(await evaluate(`${fixture}.state().tabs.find(tab=>tab.id===${fixture}.state().active).preview`), false);
    await type('[data-file-active="true"] .cm-content', "NEW_UTF8_中文\n"); await key("s", [mod]); await wait(`!${fixture}.store.dirty().length`, "new file saved"); record("Native create folder/file with Chinese, spaces and literal colons; empty editor, pin and real save");
    await rootFiles(); await click('[data-file-active="true"] button[aria-label="新建文件"]'); await type('[data-file-name]', "other.txt"); await key("Enter"); await wait("document.querySelector('dialog[open] [role=alert]')", "existing path rejected"); assert.equal(await fs.readFile(path.join(a, "other.txt"), "utf8"), "OTHER\n"); await key("Escape"); record("Existing creation target is rejected without overwriting disk; Escape cancels");

    await open("dir/same.txt"); await evaluate(`${fixture}.setPosition(1200,80)`); await delay(250); await evaluate(`${fixture}.setSession('session-2')`); await open("dir/same.txt"); await evaluate(`${fixture}.setPosition(900,60)`); await delay(250);
    await rootFiles(); await menu("dir", "rename"); await type('[data-file-name]', "moved"); await wait("!document.querySelector('[data-file-apply]').disabled", "captured rename version"); await click('[data-file-apply]'); await wait("!document.querySelector('dialog[open]')", "directory renamed");
    assert.equal(await fs.readFile(path.join(a, "moved/same.txt"), "utf8"), Array.from({ length: 300 }, (_, index) => `line ${index}`).join("\n"));
    assert.equal(await evaluate(`${fixture}.state().tabs.filter(tab=>tab.type==='file'&&tab.workspace===${JSON.stringify(a)}).every(tab=>!tab.path.startsWith('dir/'))`), true);
    await open("moved/same.txt"); await wait(`${editor}.selectionLine===60`, "session-2 position after rename"); await evaluate(`${fixture}.setSession('session-1')`); await open("moved/same.txt"); await wait(`${editor}.selectionLine===80`, "session-1 position after rename");
    record("Directory rename retargets both session tabs and exact reading positions, with actual subtree bytes preserved");

    await type('[data-file-active="true"] .cm-content', "UNSAVED_RENAME\n"); await menu("moved/same.txt", "rename"); await type('[data-file-name]', "renamed.txt"); await click('[data-file-apply]'); await wait("document.querySelectorAll('dialog[open]').length===2", "unsaved rename guard");
    await command("取消"); assert.ok(await fs.stat(path.join(a, "moved/same.txt"))); assert.equal(await evaluate(`${fixture}.store.dirty().length`), 1); await key("Escape");
    await menu("moved/same.txt", "rename"); await type('[data-file-name]', "renamed.txt"); await click('[data-file-apply]'); await wait("document.querySelectorAll('dialog[open]').length===2", "save before rename"); await command("保存并继续");
    await wait("document.querySelector('dialog[open] [role=alert]')", "saved entry confirmation refresh"); await click('[data-file-apply]'); await wait("!document.querySelector('dialog[open]')", "file renamed after confirmation");
    assert.equal(await fs.readFile(path.join(a, "renamed.txt"), "utf8"), "UNSAVED_RENAME\n"); assert.equal((await files.drafts!.list({ projectRoot: a, path: "" })).length, 0);
    record("Dirty rename cancellation retains text; save and version re-confirmation migrate the path and remove old recovery");

    await rootFiles(); await menu("renamed.txt", "trash"); await fs.writeFile(path.join(a, "renamed.txt"), "EXTERNAL_AFTER_CONFIRM\n"); await click('[data-file-apply]'); await wait("document.querySelector('dialog[open] [role=alert]')", "stale trash confirmation");
    assert.equal(await fs.readFile(path.join(a, "renamed.txt"), "utf8"), "EXTERNAL_AFTER_CONFIRM\n"); await key("Escape"); record("External edits invalidate the captured trash confirmation and preserve all disk text");
    failTrash = true; await menu("renamed.txt", "trash"); await click('[data-file-apply]'); await wait("document.querySelector('dialog[open] [role=alert]')", "native trash failure"); assert.ok(await fs.stat(path.join(a, "renamed.txt"))); await capture("trash-failure-zh"); failTrash = false; await key("Escape");
    await menu("renamed.txt", "trash"); await click('[data-file-apply]'); await wait("!document.querySelector('dialog[open]')", "trash succeeded");
    assert.equal(await fs.readFile(path.join(directory, "trash/renamed.txt"), "utf8"), "EXTERNAL_AFTER_CONFIRM\n"); assert.equal(await evaluate(`${fixture}.state().tabs.some(tab=>tab.type==='file'&&tab.workspace===${JSON.stringify(a)}&&tab.path==='renamed.txt')`), false);
    record("Trash failure retains the source; success preserves recoverable bytes and removes both session tabs");

    await open("目录 空格/a:2 $(literal).txt"); await menu("目录 空格/a:2 $(literal).txt", "relative"); assert.equal(clipboard.readText(), "目录 空格/a:2 $(literal).txt");
    await menu("目录 空格/a:2 $(literal).txt", "absolute"); assert.equal(clipboard.readText(), path.join(a, "目录 空格/a:2 $(literal).txt"));
    await wait("document.querySelector('.file-mutation-status')?.textContent.startsWith('已复制绝对路径')", "clipboard feedback");
    await menu("目录 空格/a:2 $(literal).txt", "reveal"); assert.equal(revealed.at(-1), path.join(a, "目录 空格/a:2 $(literal).txt"));
    await menu("目录 空格/a:2 $(literal).txt", "system"); await wait(`${systemOpened.length ? "true" : "!!document.body"}`, "system request"); assert.equal(systemOpened.at(-1), path.join(a, "目录 空格/a:2 $(literal).txt"));
    await evaluate(`${fixture}.setPosition(0,1)`); await menu("目录 空格/a:2 $(literal).txt", "vscode");
    const launched = Date.now(); while (!await fs.access(argsFile).then(() => true, () => false)) { if (Date.now() - launched > 12_000) throw new Error("External CLI did not write its arguments"); await delay(30); }
    assert.deepEqual((await fs.readFile(argsFile, "utf8")).trimEnd().split("\n"), ["--goto", `${a}/目录 空格/a:2 $(literal).txt:1:1`]);
    await wait("document.querySelector('.file-mutation-status')?.textContent.startsWith('已打开')", "CLI completion feedback");
    await fs.rm(argsFile); await click('[data-file-active="true"] button[aria-label="打开"]'); await wait("document.querySelector('.file-action-menu:popover-open')", "Open menu");
    assert.equal(await evaluate("[...document.querySelectorAll('.file-action-menu button')].every(button=>['reveal','system','vscode','cursor'].includes(button.dataset.fileAction))"), true);
    await click('.file-action-menu [data-file-action="cursor"]');
    const cursorStarted = Date.now(); while (!await fs.access(argsFile).then(() => true, () => false)) { if (Date.now() - cursorStarted > 12_000) throw new Error("Cursor CLI did not launch"); await delay(30); }
    assert.deepEqual((await fs.readFile(argsFile, "utf8")).trimEnd().split("\n"), ["--goto", `${a}/目录 空格/a:2 $(literal).txt:1:1`]);
    record("Relative/absolute clipboard paths, explicit-project system/reveal adapters and a real external CLI receive exact special paths and locations");

    await evaluate(`${fixture}.setRoot(${JSON.stringify(b)})`); await open("same.txt"); assert.equal(await evaluate(`${editor}.content`), "PROJECT_B\n"); await evaluate(`${fixture}.setRoot(${JSON.stringify(a)})`);
    await evaluate(`${fixture}.setLocale('en')`); window.setSize(920, 780); await rootFiles(); await filter("other.txt"); await click('[data-file-active="true"] [data-tree-path="other.txt"]', "right"); await wait("document.querySelector('.file-action-menu:popover-open')", "English context menu");
    assert.equal(await evaluate("(()=>{const el=document.querySelector('.file-action-menu');const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&[...el.querySelectorAll('button')].every(button=>button.scrollWidth<=button.clientWidth+1)})()"), true); await capture("menu-en-narrow");
    await key("End"); await key("Home"); await key("Escape"); assert.equal(await evaluate("document.activeElement?.dataset.treePath"), "other.txt");
    record("Same-name projects remain isolated; narrow English menu bounds and native keyboard/focus restoration");
    await menu("other.txt", "rename"); await type('[data-file-name]', "OTHER.txt"); await click('[data-file-apply]'); await wait("!document.querySelector('dialog[open]')", "case-only rename");
    assert.equal((await fs.readdir(a)).includes("OTHER.txt"), true); assert.equal((await fs.readdir(a)).includes("other.txt"), false); assert.equal(await fs.readFile(path.join(a, "OTHER.txt"), "utf8"), "OTHER\n");
    record("Native case-only rename updates the actual case-insensitive APFS directory entry");

    const nativeName = `tacode-fr09-${randomUUID()}.txt`; const nativePath = path.join(a, nativeName); await fs.writeFile(nativePath, "NATIVE_TRASH\n");
    nativeTrashMode = true; await menu(nativeName, "trash"); await click('[data-file-apply]'); await wait("!document.querySelector('dialog[open]')", "actual native Trash");
    await assert.rejects(fs.stat(nativePath), { code: "ENOENT" }); nativeTrashMode = false;
    let nativeTrashRestored = false;
    try { await fs.rename(path.join(os.homedir(), ".Trash", nativeName), nativePath); nativeTrashRestored = true; } catch { /* macOS may deny Trash reads; the disposable file remains recoverable there. */ }
    record("The native menu and production mutation service move a unique temporary file into the actual Electron system Trash");
    assert.deepEqual(errors, []); assert.deepEqual(network, []);
    const closed = new Promise<void>((resolve) => window.once("closed", resolve)); window.close(); await closed; closing = true; watchers.close(); files.dispose(); git.dispose(); guard.dispose(); await files.idle(); await git.idle();
    assert.deepEqual(files.service.subscriptions.stats(), { subscriptions: 0, roots: 0, reads: 0 }); assert.deepEqual(git.service.stats(), { projects: 0, subscriptions: 0, reads: 0 });
    const result = { date: new Date().toISOString(), stages, errors, network, systemOpened, revealed, nativeTrashRestored, resources: files.service.subscriptions.stats(), git: git.service.stats(), artifacts,
      boundary: "Production preload, files/Git IPC and WorkbenchPanels with native Chromium input. Real APFS mutations and external CLI; reversible Trash/system/reveal adapters for failure cases, plus the same native menu/IPC/mutation service with actual Electron system Trash. Installed user editors were not launched." };
    await fs.writeFile(path.join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n"); await fs.writeFile("docs/file-review-reference/fr-09-result.json", JSON.stringify(result, null, 2) + "\n");
    for (const name of ["menu-en-narrow", "trash-failure-zh"]) await fs.copyFile(path.join(artifacts, `${name}.png`), `docs/file-review-reference/fr-09-${name}.png`);
    console.log(JSON.stringify(result, null, 2)); clearTimeout(watchdog); await fs.rm(directory, { recursive: true, force: true }); app.quit();
  } catch (error) { console.error(error); await capture("failure").catch(() => {}); console.error(`Artifacts: ${artifacts}`); clearTimeout(watchdog); if (!window.isDestroyed()) window.destroy(); app.exit(1); }
}
void smoke().catch((error) => { console.error(error); app.exit(1); });
