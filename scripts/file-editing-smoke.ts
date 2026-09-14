import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { registerFileIpc } from "../src/main/files/file-ipc";
import { registerGitIpc } from "../src/main/git/git-ipc";
import { WorkspaceFileIndex } from "../src/main/workspace-file-index";
import { WorkspaceWatchers } from "../src/main/workspace-watcher";
import { WindowCloseGuard } from "../src/main/window-close-guard";
import type { DocumentWriteResult } from "../src/shared/files";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function smoke() {
  const directory = process.env.TACODE_FILE_EDIT_DIR!; const artifacts = process.env.TACODE_FILE_EDIT_ARTIFACTS!;
  const phase = process.env.TACODE_FILE_EDIT_PHASE!; const a = path.join(directory, "project-a"); const b = path.join(directory, "project-b");
  const restart = phase === "restart"; const stages: string[] = []; const errors: string[] = []; const network: string[] = [];
  await fs.mkdir(artifacts, { recursive: true }); app.setPath("userData", path.join(directory, "profile")); app.on("window-all-closed", () => {});
  if (!restart) {
    for (const root of [a, b]) await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(a, "same.txt"), Buffer.from("\uFEFForiginal\r\nsecond line\r\n")); await fs.chmod(path.join(a, "same.txt"), 0o755);
    await fs.writeFile(path.join(a, "other.ts"), "export const other = 1;\n"); await fs.writeFile(path.join(b, "same.txt"), "PROJECT_B\n");
    await fs.writeFile(path.join(a, "large.txt"), "x".repeat(4 * 1024 * 1024 + 10));
  }
  await app.whenReady(); Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] }]));
  const window = new BrowserWindow({ width: 1460, height: 840, show: true, webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const guard = new WindowCloseGuard(window); let closing = false;
  window.webContents.on("console-message", (event) => { if (event.level === "error") { errors.push(event.message); console.error("[renderer]", event.message); } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
  const index = new WorkspaceFileIndex();
  const watchers = new WorkspaceWatchers((root, paths) => { if (paths) for (const file of paths) index.changed(root, file); else index.changed(root); if (!closing && !window.isDestroyed()) window.webContents.send("workspace:changed", { root, paths }); });
  const resolveProject = async (root: string) => { if (root !== a && root !== b) throw new Error("Unknown project"); return root; };
  const files = registerFileIpc({ host: () => window.webContents, index, resolveProject, draftRoot: path.join(directory, "file-drafts"), watchProject: (root) => { if (watchers.watch(root)) index.changed(root); } });
  const git = registerGitIpc({ host: () => window.webContents, resolveProject, recoveryRoot: path.join(directory, "git-recovery") });
  let failSave = false; let holdSave = false; let releaseSave: (() => void) | undefined; let failRecovery = false;
  const originalWrite = files.service.writeDocument.bind(files.service);
  files.service.writeDocument = async (...args): Promise<any> => {
    if (failSave) return { kind: "error", error: { code: "readOnly", message: "fixture permission failure" } };
    const result = await originalWrite(...args);
    if (holdSave) { holdSave = false; await new Promise<void>((resolve) => { releaseSave = resolve; }); }
    return result;
  };
  const originalCheckpoint = files.drafts!.write.bind(files.drafts!);
  files.drafts!.write = (...args) => failRecovery ? Promise.reject(new Error("fixture recovery disk full")) : originalCheckpoint(...args);
  ipcMain.handle("app:get-locale", () => "zh"); ipcMain.handle("app:set-locale", () => {});
  ipcMain.handle("workspace:list", async (_event, root: string, refresh?: boolean) => { await resolveProject(root); if (watchers.watch(root)) index.changed(root); return index.list(root, refresh); });
  const evaluate = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true);
  const store = "window.fileWorkbenchFixture.store";
  const state = (root = a, name = "same.txt") => `${store}.snapshot(${JSON.stringify(root)},${JSON.stringify(name)})`;
  const editor = "window.fileWorkbenchFixture.editor()";
  const visible = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0)`;
  const wait = async (code: string, label: string, timeout = 10_000) => { const start = Date.now(); while (!await evaluate(code)) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${stages.at(-1)}: ${label}`); await delay(30); } };
  const click = async (selector: string, button: "left" | "right" = "left") => {
    window.focus(); window.webContents.focus(); await wait("document.visibilityState==='visible'", "visibility");
    const point = await evaluate(`(()=>{const el=${visible(selector)};if(!el)throw Error('Missing selector');const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    window.webContents.sendInputEvent({ type: "mouseDown", ...point, button, clickCount: 1 }); window.webContents.sendInputEvent({ type: "mouseUp", ...point, button, clickCount: 1 }); await delay(60);
  };
  const mod = process.platform === "darwin" ? "meta" : "control";
  const key = async (keyCode: string, modifiers: string[] = []) => { window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers }); window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers }); await delay(50); };
  const replace = async (text: string) => { await click('[data-file-active="true"] .cm-content'); await key("a", [mod]); await window.webContents.insertText(text); await delay(60); };
  const open = async (name: string) => {
    await click('[data-panel-id="files"]'); await click(".workbench-file-filter input"); await evaluate(`${visible(".workbench-file-filter input")}.select()`); await key("Backspace"); await window.webContents.insertText(name);
    await wait(`${visible(`[data-tree-path=${JSON.stringify(name)}]`)}`, "file row"); await click(`[data-tree-path=${JSON.stringify(name)}]`); await wait(`${editor}?.content!==undefined`, "editor");
  };
  const dialogButton = async (label: string) => {
    await evaluate(`(()=>{const buttons=[...document.querySelectorAll('dialog[open] button')];const button=buttons.find(el=>el.textContent===${JSON.stringify(label)});if(!button)throw Error('Missing dialog command');button.dataset.nativeTarget='true'})()`);
    await click('dialog[open] [data-native-target="true"]'); await evaluate("document.querySelectorAll('[data-native-target]').forEach(el=>delete el.dataset.nativeTarget)");
  };
  const record = (name: string) => { stages.push(name); console.log(`[file/editing] ${name}`); };
  const capture = async (name: string) => { await delay(100); await fs.writeFile(path.join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG()); };
  const watchdog = setTimeout(() => { console.error("File editing timeout", stages.at(-1)); app.exit(1); }, 180_000);
  try {
    await window.loadFile(process.env.TACODE_FILE_WORKBENCH_FIXTURE!, { query: { project: a } }); await wait("!!window.fileWorkbenchFixture", "fixture");
    if (restart) {
      await wait(`${state()}.dirty&&${state()}.restored`, "durable unsaved draft after full process restart"); await open("same.txt");
      assert.equal(await evaluate(`${editor}.content`), "RESTART_RECOVERY_中文\nlast unsaved input");
      assert.equal(await fs.readFile(path.join(a, "same.txt"), "utf8"), "DISK_BEFORE_RESTART\n");
      assert.equal(await evaluate(`${state()}.dirty`), true); await capture("08-restart-recovered"); record("A separate Electron process restores exact unsaved text, base version, pinned tab and disk isolation");
      window.close(); await wait("!!document.querySelector('dialog[open]')", "native close guard after restart"); await dialogButton("取消"); assert.equal(window.isDestroyed(), false);
      const closed = new Promise<void>((resolve) => window.once("closed", () => resolve())); window.close(); await wait("!!document.querySelector('dialog[open]')", "second close guard"); await dialogButton("放弃修改"); await closed;
      await delay(50); await files.idle(); assert.equal((await files.drafts!.list({ projectRoot: a, path: "" })).length, 0); record("Native close cancellation and explicit discard remove recovery without writing disk");
    } else {
      await open("same.txt"); await wait(`${visible('[data-file-active="true"] .cm-content')}?.contentEditable==='true'`, "editable text");
      await replace("中文编辑\r\nsecond line\r\n"); await key("z", [mod]); assert.equal(await evaluate(`${editor}.content`), "original\r\nsecond line\r\n");
      await key("z", [mod, "shift"]); assert.equal(await evaluate(`${editor}.content`), "中文编辑\r\nsecond line\r\n");
      await key("Enter"); assert.ok(await evaluate(`${editor}.content.includes(${JSON.stringify("\r\n")})`));
      await key("s", [mod]); await wait(`!${state()}.dirty&&!${state()}.saving`, "real saved text");
      const bytes = await fs.readFile(path.join(a, "same.txt")); assert.ok(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
      assert.ok(!/(?<!\r)\n/.test(bytes.toString("utf8"))); if (process.platform !== "win32") assert.equal((await fs.stat(path.join(a, "same.txt"))).mode & 0o777, 0o755);
      record("Native edit/newline, undo/redo and Mod-S write real UTF-8 text while preserving BOM, CRLF and permissions");

      await replace("find target\r\nfind target\r\n"); await key("f", [mod]); await wait("document.querySelector('.cm-search input[name=search]')", "find panel"); await window.webContents.insertText("find target");
      await click('.cm-search input[name="replace"]'); await window.webContents.insertText("replaced"); await click('.cm-search button[name="replaceAll"]');
      await wait(`${editor}.content===${JSON.stringify("replaced\r\nreplaced\r\n")}`, "replace all"); await key("Escape"); await click('[data-file-active="true"] .cm-content'); await key("g", [mod]); await wait("document.querySelector('.cm-goto-line input')", "goto line");
      await key("a", [mod]); await window.webContents.insertText("2"); await key("Enter"); await wait(`${editor}.selectionLine===2`, "line navigation"); await capture("01-edit-find-replace"); record("Production editor Find/Replace and goto-line shortcuts operate on the actual text");

      failSave = true; await key("s", [mod]); await wait(`${state()}.saveError?.code==='readOnly'`, "save failure"); assert.equal(await evaluate(`${state()}.dirty`), true); failSave = false;
      holdSave = true; await key("s", [mod]); await delay(100); await wait(`${state()}.saving`, "pending save");
      await window.webContents.insertText("INPUT_DURING_SAVE"); while (!releaseSave) await delay(30); releaseSave(); releaseSave = undefined;
      await wait(`!${state()}.saving&&${state()}.dirty`, "newer edit retained"); assert.ok(await evaluate(`${state()}.draft.content.includes('INPUT_DURING_SAVE')`));
      assert.equal((await fs.readFile(path.join(a, "same.txt"), "utf8")).includes("INPUT_DURING_SAVE"), false);
      await key("s", [mod]); await wait(`!${state()}.dirty&&!${state()}.saving`, "second save"); record("Save failure retains changes; input during a held real save remains dirty and saves against the new disk version");

      await replace("LOCAL_CONFLICT\r\n"); await fs.writeFile(path.join(a, "same.txt"), "EXTERNAL_ONE\n"); await wait(`${state()}.document.content===${JSON.stringify("EXTERNAL_ONE\n")}`, "external update");
      assert.equal(await evaluate(`${editor}.content`), "LOCAL_CONFLICT\r\n"); await key("s", [mod]); await wait("document.querySelector('.file-conflict-dialog[open]')", "comparison");
      await wait("[...document.querySelectorAll('.file-conflict-dialog .cm-content')].length===2&&document.querySelector('.file-conflict-dialog .cm-content').textContent.includes('EXTERNAL_ONE')", "loaded comparison text");
      assert.equal(await evaluate("document.querySelectorAll('.file-conflict-dialog .cm-content')[1].textContent.includes('LOCAL_CONFLICT')"), true);
      assert.equal(await evaluate("[...document.querySelectorAll('.file-conflict-dialog .cm-content')].every(el=>el.contentEditable==='false')"), true);
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.file-conflict-dialog')).backgroundColor"), "rgb(255, 255, 255)"); await capture("02-conflict-comparison");
      await evaluate("window.fileWorkbenchFixture.setLocale('en')"); window.setSize(920, 840); await wait("document.querySelector('.file-conflict-dialog h2')?.textContent==='Resolve file version conflict'", "English comparison"); await delay(150);
      assert.equal(await evaluate("(()=>{const dialog=document.querySelector('.file-conflict-dialog');const r=dialog.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&[...dialog.querySelectorAll('button')].every(el=>{const b=el.getBoundingClientRect();return b.left>=r.left&&b.right<=r.right&&el.scrollWidth<=el.clientWidth+1})})()"), true);
      await capture("02b-conflict-en-narrow"); window.setSize(1460, 840); await evaluate("window.fileWorkbenchFixture.setLocale('zh')"); await wait("document.querySelector('.file-conflict-dialog h2')?.textContent==='解决文件版本冲突'", "Chinese comparison restored");
      await fs.writeFile(path.join(a, "same.txt"), "EXTERNAL_TWO\n"); await wait(`${state()}.document.content===${JSON.stringify("EXTERNAL_TWO\n")}`, "second external update");
      assert.equal(await evaluate("[...document.querySelectorAll('dialog[open] button')].find(el=>el.textContent==='覆盖所示磁盘版本').disabled"), true);
      await dialogButton("刷新比较"); await dialogButton("覆盖所示磁盘版本"); await wait("!document.querySelector('dialog[open]')", "explicit version overwrite");
      assert.equal(await fs.readFile(path.join(a, "same.txt"), "utf8"), "LOCAL_CONFLICT\r\n"); record("External writes preserve local text; comparison shows exact versions and refuses an outdated overwrite");

      await replace("DELETE_PROTECTED\r\n"); await fs.unlink(path.join(a, "same.txt")); await wait(`${state()}.document.status==='missing'`, "external deletion"); assert.equal(await evaluate(`${editor}.content`), "DELETE_PROTECTED\r\n");
      await key("s", [mod]); await wait("document.querySelector('.file-conflict-dialog[open]')", "missing conflict");
      assert.equal(await evaluate("[...document.querySelectorAll('dialog[open] button')].find(el=>el.textContent==='覆盖所示磁盘版本').disabled"), true); await dialogButton("取消");
      await fs.writeFile(path.join(a, "same.txt"), "DISK_RETURNED\n"); await wait(`${state()}.document.content===${JSON.stringify("DISK_RETURNED\n")}`, "file returned"); await click('[data-file-active="true"] .cm-content'); await key("s", [mod]); await wait("document.querySelector('.file-conflict-dialog[open]')", "use disk comparison"); await dialogButton("放弃修改，使用磁盘版本");
      await wait(`!${state()}.dirty`, "discard local version"); record("Deleted files retain editable recovery text; explicit use-disk resolution discards only by user choice");

      await replace("CLOSE_SAVE\n"); const tab = await evaluate("document.querySelector('[data-file-dirty=true]').dataset.panelId");
      await click(`[data-panel-id=${JSON.stringify(tab)}] .inspect-tab-close`); await wait("document.querySelector('dialog[open]')", "close unsaved"); await key("Escape"); assert.ok(await evaluate(`document.querySelector('[data-panel-id='+${JSON.stringify(JSON.stringify(tab))}+']')`));
      await click(`[data-panel-id=${JSON.stringify(tab)}] .inspect-tab-close`); await wait("document.querySelector('dialog[open]')", "close save choice"); await dialogButton("保存并继续"); await wait(`!document.querySelector('[data-panel-id='+${JSON.stringify(JSON.stringify(tab))}+']')`, "saved tab closes");
      assert.equal(await fs.readFile(path.join(a, "same.txt"), "utf8"), "CLOSE_SAVE\n"); record("Closing an unsaved file supports Escape cancellation and save-before-close");

      await open("same.txt"); await replace("KEEP_CURRENT_DIRTY\n"); await open("other.ts"); await replace("export const other = 2;\n");
      const keepTab = await evaluate("window.fileWorkbenchFixture.state().tabs.find(tab=>tab.type==='file'&&tab.path==='same.txt').id");
      const closeOthers = async () => {
        await click(`[data-panel-id=${JSON.stringify(keepTab)}]`, "right"); await wait("document.querySelector('.file-tab-menu')", "close other files menu");
        await evaluate("[...document.querySelectorAll('.file-tab-menu button')].find(el=>el.textContent.includes('关闭其他文件标签')).dataset.nativeTarget='true'");
        await click('.file-tab-menu [data-native-target=true]'); await wait("document.querySelector('dialog[open]')", "bulk unsaved guard");
      };
      await closeOthers(); assert.equal(await evaluate("document.querySelector('dialog[open] .workbench-confirm-paths').textContent"), "other.ts");
      await dialogButton("取消"); assert.equal(await evaluate("window.fileWorkbenchFixture.state().tabs.filter(tab=>tab.type==='file').length"), 2);
      await closeOthers(); await dialogButton("保存并继续"); await wait("window.fileWorkbenchFixture.state().tabs.filter(tab=>tab.type==='file').length===1", "saved other tabs close");
      assert.equal(await fs.readFile(path.join(a, "other.ts"), "utf8"), "export const other = 2;\n"); assert.equal(await evaluate(`${state()}.dirty`), true);
      assert.equal(await fs.readFile(path.join(a, "same.txt"), "utf8"), "CLOSE_SAVE\n"); record("Close-other-files cancellation and save protect the selected dirty tab and write only the closing files");

      await open("same.txt"); await replace("PROJECT_SWITCH_DRAFT\n"); await evaluate(`window.fileWorkbenchFixture.setRoot(${JSON.stringify(b)});undefined`); await wait("document.querySelector('dialog[open]')", "switch project guard"); await dialogButton("取消"); assert.equal(await evaluate("window.fileWorkbenchFixture.state().root"), a);
      failRecovery = true; await replace("RECOVERY_FAILURE_KEPT\n"); await evaluate(`window.fileWorkbenchFixture.setRoot(${JSON.stringify(b)});undefined`); await wait("document.querySelector('dialog[open]')", "recovery failed transition"); await dialogButton("保留修改并继续");
      await wait("document.querySelector('dialog[open] [role=alert]')", "checkpoint failure stays open"); assert.equal(await evaluate("window.fileWorkbenchFixture.state().root"), a); await capture("03-recovery-failure"); failRecovery = false;
      await dialogButton("保留修改并继续"); await wait(`window.fileWorkbenchFixture.state().root===${JSON.stringify(b)}`, "retained project switch"); await open("same.txt"); assert.equal(await evaluate(`${editor}.content`), "PROJECT_B\n");
      await evaluate(`window.fileWorkbenchFixture.setRoot(${JSON.stringify(a)});undefined`); await wait(`window.fileWorkbenchFixture.state().root===${JSON.stringify(a)}`, "return to project"); await open("same.txt"); assert.equal(await evaluate(`${editor}.content`), "RECOVERY_FAILURE_KEPT\n"); record("Project switch cancellation, durable keep, recovery failure blocking and identical-path project isolation");

      await open("large.txt"); await wait(`${visible('[data-file-active="true"] .cm-content')}?.contentEditable==='false'`, "truncated read-only"); const partial = await evaluate(`${editor}.content`); await click('[data-file-active="true"] .cm-content'); await window.webContents.insertText("must not edit"); assert.equal(await evaluate(`${editor}.content`), partial);
      await open("same.txt"); await replace("RELOAD_DRAFT\n"); window.webContents.reload(); await wait("document.querySelector('dialog[open]')", "cancel reload guard"); await dialogButton("取消");
      const cancelClose = guard.request("close"); await wait("document.querySelector('dialog[open]')", "close guard still ready after cancelled reload"); await dialogButton("取消"); assert.equal(await cancelClose, false);
      await fs.writeFile(path.join(a, "same.txt"), "AFTER_CANCELLED_RELOAD\n"); await wait(`${state()}.document.content===${JSON.stringify("AFTER_CANCELLED_RELOAD\n")}`, "subscription survives cancelled reload");
      window.webContents.reload(); await wait("document.querySelector('dialog[open]')", "reload unsaved guard"); await dialogButton("保留修改并继续");
      await wait("!!window.fileWorkbenchFixture", "reloaded fixture"); await wait(`${state()}.restored&&${state()}.dirty`, "restored after reload"); await open("same.txt"); assert.equal(await evaluate(`${editor}.content`), "RELOAD_DRAFT\n"); record("Partial large files stay read-only; native renderer reload checkpoints and restores unsaved text");

      await fs.writeFile(path.join(a, "same.txt"), "DISK_BEFORE_RESTART\n"); await wait(`${state()}.document.content===${JSON.stringify("DISK_BEFORE_RESTART\n")}`, "restart disk baseline");
      await click('[data-file-active="true"] .cm-content'); await key("s", [mod]); await wait("document.querySelector('.file-conflict-dialog[open]')", "restart resolution"); await dialogButton("放弃修改，使用磁盘版本"); await wait(`!${state()}.dirty`, "restart clean baseline");
      await replace("RESTART_RECOVERY_中文\nlast unsaved input");
      const quit = guard.request("quit"); await wait("document.querySelector('dialog[open]')", "application quit guard"); await dialogButton("保留修改并继续"); assert.equal(await quit, true);
      await files.idle(); assert.equal((await files.drafts!.list({ projectRoot: a, path: "" }))[0]?.content, "RESTART_RECOVERY_中文\nlast unsaved input");
      await capture("04-retained-before-process-exit"); record("Quit waits for the exact unsaved recovery checkpoint before the first Electron process exits");
    }
    closing = true; if (!window.isDestroyed()) window.destroy(); await delay(100); await files.idle(); await git.idle();
    assert.deepEqual(errors, []); assert.deepEqual(network, []); assert.equal(files.service.subscriptions.stats().subscriptions, 0); assert.equal(files.service.subscriptions.stats().roots, 0);
    await fs.writeFile(path.join(artifacts, `${phase}.json`), JSON.stringify({ phase, stages, errors, network, resources: files.service.subscriptions.stats(), git: git.service.stats(), artifacts }, null, 2) + "\n");
  } catch (error) { if (!window.isDestroyed()) { await capture(`${phase}-failure`).catch(() => {}); await fs.writeFile(path.join(artifacts, `${phase}-failure.html`), await evaluate("document.body.outerHTML")).catch(() => {}); } console.error(`Artifacts: ${artifacts}`); throw error; }
  finally { clearTimeout(watchdog); releaseSave?.(); closing = true; files.dispose(); git.dispose(); guard.dispose(); await delay(30); await files.idle(); await git.idle(); watchers.close(); if (!window.isDestroyed()) window.destroy(); }
}
function exit(code: number) {
  console.log(`FILE_EDITING_EXIT ${code}`);
  app.exit(code);
}
void smoke().then(() => exit(0), (error) => { console.error(error); exit(1); });
