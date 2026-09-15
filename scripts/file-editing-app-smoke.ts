import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { app, BrowserWindow } from "electron";

const root = process.env.TACODE_FILE_EDIT_APP_DIR!;
const artifacts = process.env.TACODE_FILE_EDIT_ARTIFACTS!;
const a = path.join(root, "project-a"); const b = path.join(root, "project-b");
const profile = path.join(root, "app-data", "TACode"); const home = path.join(root, "home");
for (const directory of [a, b, profile, home, artifacts]) fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(a, "same.txt"), "APP_DISK_A\n"); fs.writeFileSync(path.join(b, "same.txt"), "APP_DISK_B\n");
fs.writeFileSync(path.join(profile, "recent-workspaces.json"), JSON.stringify([a, b].map((file) => ({ path: file, name: path.basename(file), lastOpenedAt: new Date().toISOString() }))));
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ locale: "zh" }));
app.setPath("appData", path.join(root, "app-data"));
process.env.TACODE_HOME = home; process.env.TACODE_CREDENTIALS_STORE = "file";
delete process.env.VITE_DEV_SERVER_URL;
for (const key of Object.keys(process.env)) if (/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN)$/.test(key)) delete process.env[key];
const errors: string[] = []; const stages: string[] = [];
globalThis.fetch = async () => new Response("Offline lifecycle fixture", { status: 503 });
app.on("web-contents-created", (_event, contents) => {
  contents.on("console-message", (event) => { if (event.level === "error") errors.push(event.message); });
  contents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (_details, callback) => callback({ cancel: true }));
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let window: BrowserWindow | undefined;
let stage = "production startup";
const watchdog = setTimeout(() => { console.error(`Full App editing timed out: ${stage}`); console.log("FILE_EDITING_APP_FAILED"); app.exit(1); }, 90_000);
async function smoke() {
  await import(pathToFileURL(process.env.TACODE_PRODUCTION_MAIN!).href);
  const wait = async (code: string, label: string) => {
    const start = Date.now(); while (!await evaluate(code)) { if (Date.now() - start > 12_000) throw new Error(`Timed out at ${stage}: ${label}`); await delay(30); }
  };
  const evaluate = <T = any>(code: string): Promise<T> => window!.webContents.executeJavaScript(code, true);
  while (!(window = BrowserWindow.getAllWindows()[0])) await delay(30);
  await wait("!!document.querySelector('.project-row')", "recent projects"); window.show(); window.focus();
  const visible = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0)`;
  const click = async (selector: string) => {
    window!.focus(); window!.webContents.focus(); await wait("document.visibilityState==='visible'", "visible window");
    const point = await evaluate(`(()=>{const el=${visible(selector)};if(!el)throw Error('Missing control');const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    for (const type of ["mouseDown", "mouseUp"] as const) window!.webContents.sendInputEvent({ type, ...point, button: "left", clickCount: 1 }); await delay(80);
  };
  const mod = process.platform === "darwin" ? "meta" : "control";
  const key = async (keyCode: string, modifiers: string[] = []) => { for (const type of ["keyDown", "keyUp"] as const) window!.webContents.sendInputEvent({ type, keyCode, modifiers }); await delay(60); };
  const command = async (label: string) => {
    await evaluate(`[...document.querySelectorAll('dialog[open] button')].find(el=>el.textContent===${JSON.stringify(label)}).dataset.nativeTarget='true'`);
    await click('dialog[open] [data-native-target=true]');
  };
  const open = async () => {
    await key("p", [mod]); await wait(`${visible('.workbench-file-filter input')}`, "production files panel");
    await click('.workbench-file-filter input'); await window!.webContents.insertText("same.txt"); await wait(`${visible('[data-tree-path="same.txt"]')}`, "file row");
    await click('[data-tree-path="same.txt"]'); await wait(`${visible('.cm-content')}?.contentEditable==='true'`, "production editor");
  };
  const edit = async (text: string) => { await click('.cm-content'); await key("a", [mod]); await window!.webContents.insertText(text); await wait("!!document.querySelector('[data-file-dirty=true]')", "dirty indicator"); };
  const record = (text: string) => { stages.push(text); console.log(`[file/editing/app] ${text}`); };
  const selectProject = (name: string) => evaluate(`document.querySelector(${JSON.stringify(`.project-row[aria-label="${name}"]`)}).click()`);
  stage = "actual App project transitions";
  await selectProject("project-a"); await wait("document.querySelector('.project-row[aria-current=true]')?.getAttribute('aria-label')==='project-a'", "first project bound");
  await open();
  assert.equal(await evaluate(`${visible('[data-file-active=true][data-file-path="same.txt"]')}.dataset.fileProject`), a);
  await edit("APP_UNSAVED_中文\n"); await delay(250);
  await selectProject("project-b"); await wait("!!document.querySelector('dialog[open]')", "App bindProject protection"); await command("取消");
  assert.equal(await evaluate("document.querySelector('.project-row[aria-current=true]').getAttribute('aria-label')"), "project-a");
  await selectProject("project-b"); await wait("!!document.querySelector('dialog[open]')", "App project keep choice"); await command("保留修改并继续");
  await wait("document.querySelector('.project-row[aria-current=true]')?.getAttribute('aria-label')==='project-b'", "App switched project");
  assert.equal(await fsp.readFile(path.join(a, "same.txt"), "utf8"), "APP_DISK_A\n");
  await selectProject("project-a"); await wait("document.querySelector('.project-row[aria-current=true]')?.getAttribute('aria-label')==='project-a'", "return to original project");
  await open(); await wait(`${visible('.cm-content')}?.textContent.includes('APP_UNSAVED_中文')`, "App retained original draft");
  record("Production App bindProject cancels or retains unsaved changes without starting an Agent or changing disk");
  stage = "actual application quit cancellation";
  app.quit(); await wait("!!document.querySelector('dialog[open]')", "production before-quit protection"); await command("取消"); await delay(150);
  assert.equal(window.isDestroyed(), false); assert.equal(app.getPath("userData"), profile); record("Production before-quit waits for user choice and cancellation keeps the App and its file services alive");
  await edit("APP_QUIT_EXACT_中文\nlast input");
  const recovery = path.join(profile, "file-drafts", hash(a), `${hash("same.txt")}.json`);
  // The parent verifies publication independently after the complete production process exits.
  fs.writeFileSync(path.join(artifacts, "app-expected.json"), JSON.stringify({ recovery, disk: path.join(a, "same.txt"), expected: "APP_QUIT_EXACT_中文\nlast input" }));
  stage = "actual application quit with durable keep";
  assert.equal(await evaluate("window.harness.agent.runtimes().then(value=>value.length)"), 0);
  app.quit(); await wait("!!document.querySelector('dialog[open]')", "second production quit protection");
  assert.deepEqual(errors, []);
  await fsp.writeFile(path.join(artifacts, "05-production-app-quit.png"), (await window.webContents.capturePage()).toPNG());
  record("Production App quit approves durable keep only after the final text is checkpointed; the parent verifies a natural process exit");
  await fsp.writeFile(path.join(artifacts, "app.json"), JSON.stringify({ stages, errors, profile, home }, null, 2));
  await command("保留修改并继续");
}
void smoke().catch(async (error) => {
  console.error(error); console.log("FILE_EDITING_APP_FAILED");
  if (window && !window.isDestroyed()) await fsp.writeFile(path.join(artifacts, "app-failure.png"), (await window.webContents.capturePage()).toPNG()).catch(() => {});
  if (window && !window.isDestroyed()) await fsp.writeFile(path.join(artifacts, "app-failure.html"), await window.webContents.executeJavaScript("document.body.outerHTML")).catch(() => {});
  clearTimeout(watchdog); app.exit(1);
});
