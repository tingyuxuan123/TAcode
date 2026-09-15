import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir, platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, protocol, net } from "electron";
import { registerFileIpc } from "../src/main/files/file-ipc";
import { serveProjectPreview } from "../src/main/files/preview-server";
import { resolveWorkspacePreview } from "../src/main/browser/preview-target";
import { WorkspaceFileIndex } from "../src/main/workspace-file-index";
import { WorkspaceWatchers } from "../src/main/workspace-watcher";
import { DOCUMENT_EDIT_BYTES, type FileDocument, type FilePage } from "../src/shared/files";
import { PREVIEW_SCHEME } from "../src/shared/types";

protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function smoke() {
  const directory = process.env.TACODE_FILE_SERVICE_DIRECTORY ?? await fs.mkdtemp(path.join(tmpdir(), "tacode-file-service-"));
  await fs.mkdir(directory, { recursive: true });
  app.setPath("userData", path.join(directory, "profile")); app.on("window-all-closed", () => {});
  const a = path.join(directory, "a"); const b = path.join(directory, "b"); await fs.mkdir(a); await fs.mkdir(b);
  const write = async (root: string, name: string, bytes: string | Buffer) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
  const page = (name: string) => `<!doctype html><meta charset="utf-8"><title>${name}</title><p>${name}</p><img src="pixel.png"><script>window.addEventListener('load',async()=>{localStorage.setItem('project','${name}');parent.postMessage({project:'${name}',api:typeof window.harness,pixel:document.querySelector('img').naturalWidth,asset:await(await fetch('asset.txt')).text(),storage:localStorage.getItem('project')},'*')})</script>`;
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZV5EAAAAASUVORK5CYII=", "base64");
  for (const [root, name] of [[a, "PROJECT_A"], [b, "PROJECT_B"]]) { await write(root, "same.html", page(name)); await write(root, "asset.txt", name); await write(root, "pixel.png", pixel); }
  for (let n = 0; n < 8105; n += 100) await Promise.all(Array.from({ length: Math.min(100, 8105 - n) }, (_, i) => write(a, `deep/file-${String(n + i).padStart(5, "0")}.txt`, "indexed")));
  await write(a, ".hidden/source.txt", "hidden"); await write(a, "node_modules/pkg/source.txt", "ignored");
  await write(a, "document.txt", "\uFEFFbefore\r\n"); await write(a, "large.txt", "x".repeat(DOCUMENT_EDIT_BYTES) + "尾部");
  if (process.platform !== "win32") { await fs.chmod(path.join(a, "document.txt"), 0o755); await fs.symlink(b, path.join(a, "outside")); }
  await app.whenReady();
  const window = new BrowserWindow({ width: 680, height: 420, show: false, webPreferences: {
    preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false,
  } });
  const errors: string[] = []; const network: string[] = []; const stages: string[] = [];
  window.webContents.on("console-message", (event) => { if (event.level === "error") { errors.push(event.message); console.error("[renderer]", event.message); } });
  window.webContents.on("did-fail-load", (_event, code, message, url) => { console.error("[preview load]", code, message, url); });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
  const index = new WorkspaceFileIndex();
  const watchers = new WorkspaceWatchers((root, paths) => { if (paths) for (const file of paths) index.changed(root, file); else index.changed(root); });
  const registration = registerFileIpc({ host: () => window.webContents, index,
    resolveProject: async (root) => { if (root !== a && root !== b) throw new Error("Unopened project"); return root; },
    watchProject: (root) => { if (watchers.watch(root)) index.changed(root); },
  });
  protocol.handle(PREVIEW_SCHEME, (request) => serveProjectPreview(request, registration.service.paths, registration.service.previews));
  const evaluate = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code);
  const api = <T = any>(method: string, request: unknown): Promise<T> => evaluate(`window.harness.files.${method}(${JSON.stringify(request)})`);
  const wait = async (check: () => Promise<boolean> | boolean, label: string) => { const start = Date.now(); while (!await check()) { if (Date.now() - start > 8000) throw new Error(`Timed out: ${label}`); await delay(40); } };
  const request = (name: string, root = a) => ({ projectRoot: root, path: name });
  const stage = (name: string) => { stages.push(name); console.log(`[files/service] ${name}`); };
  const watchdog = setTimeout(() => { console.error("File service smoke timed out"); app.exit(1); }, 60_000);
  try {
    await write(directory, "host.html", "<!doctype html><title>File service test</title><body></body>");
    await window.loadFile(path.join(directory, "host.html"));
    assert.equal(await evaluate("typeof window.require"), "undefined");
    const first = await api<FilePage>("directory", request("deep")); assert.equal(first.total, 8105); assert.equal(first.entries.length, 200);
    const next = await api<FilePage>("directory", { ...request("deep"), cursor: first.cursor }); assert.equal(next.entries[0]?.name, "file-00200.txt");
    const found = await api<FilePage>("search", { ...request(""), query: "deep/file-08001" }); assert.equal(found.entries[0]?.path, "deep/file-08001.txt");
    assert.equal((await api<FilePage>("directory", request(".hidden"))).entries[0]?.path, ".hidden/source.txt");
    assert.equal((await api<FilePage>("search", { ...request("node_modules"), query: "source" })).entries[0]?.path, "node_modules/pkg/source.txt");
    await write(a, "deep/new.txt", "new"); assert.equal((await api("directory", { ...request("deep"), cursor: first.cursor })).error.code, "staleCursor");
    stage("Production preload: stable paging, file 201/8001, hidden and ignored paths, stale cursors");

    const document = await api<FileDocument>("readDocument", request("document.txt")); assert.equal(document.content, "before\r\n");
    const saved = await api("writeDocument", { ...request("document.txt"), expectedVersion: document.version, content: "after\n" }); assert.equal(saved.kind, "saved");
    assert.equal(await fs.readFile(path.join(a, "document.txt"), "utf8"), "\uFEFFafter\r\n");
    if (process.platform !== "win32") assert.equal((await fs.stat(path.join(a, "document.txt"))).mode & 0o777, 0o755);
    assert.equal((await api("writeDocument", { ...request("document.txt"), expectedVersion: document.version, content: "stale" })).error.code, "conflict");
    const large = await api<FileDocument>("readDocument", { ...request("large.txt"), offset: DOCUMENT_EDIT_BYTES, length: 64 });
    assert.equal(large.content, "尾部"); assert.equal(large.status, "truncated"); assert.equal(large.metadata.writable, false);
    assert.equal((await api("writeDocument", { ...request("large.txt"), expectedVersion: large.version, content: "partial" })).error.code, "tooLarge");
    stage("Real atomic saves preserve BOM/CRLF/mode; conflict and partial writes are refused");

    const urlA = await api<string>("previewUrl", request("same.html")); const urlB = await api<string>("previewUrl", request("same.html", b)); assert.notEqual(new URL(urlA).host, new URL(urlB).host);
    const browser = resolveWorkspacePreview("same.html", a, { explicit: true, previewUrl: registration.service.previews.url.bind(registration.service.previews) }); assert.equal(browser?.url, urlA);
    await evaluate(`window.messages=[];window.addEventListener('message',e=>window.messages.push(e.data));for(const url of ${JSON.stringify([urlA, urlB])}){const f=document.createElement('iframe');f.src=url;f.setAttribute('sandbox','allow-scripts allow-same-origin');document.body.append(f)}`);
    await wait(() => evaluate("window.messages.length===2"), "both project previews and relative assets");
    const messages = await evaluate<Array<{ project: string; api: string; pixel: number; asset: string; storage: string }>>("window.messages");
    assert.deepEqual(messages.map((value) => value.project).sort(), ["PROJECT_A", "PROJECT_B"]);
    for (const value of messages) { assert.equal(value.asset, value.project); assert.equal(value.storage, value.project); assert.equal(value.pixel, 1); assert.equal(value.api, "undefined"); }
    assert.equal((await net.fetch(`${PREVIEW_SCHEME}://workspace/same.html`)).status, 403);
    assert.equal((await net.fetch(`${PREVIEW_SCHEME}://workspace-00000000000000000000000000000000/same.html`)).status, 403);
    assert.equal((await net.fetch(`${urlA.slice(0, urlA.lastIndexOf("/"))}/%E0%A4`)).status, 400);
    if (process.platform !== "win32") assert.equal((await api("readDocument", request("outside/asset.txt"))).error.code, "outsideProject");
    assert.equal((await api("readDocument", { projectRoot: directory, path: "a/asset.txt" })).error.code, "outsideProject");
    stage("Two project origins, browser URLs, relative images/fetch/storage and preview authorization");

    await evaluate("window.updates=[];window.off=window.harness.files.onUpdate(u=>window.updates.push(u));null");
    await api("subscribe", { ...request("document.txt"), target: "document", subscriptionId: "document" });
    const started = performance.now(); await write(a, "document.txt", "external");
    await wait(() => evaluate("window.updates.some(u=>u.kind==='changed'&&u.subscriptionId==='document')"), "path-level external update");
    const refreshMs = performance.now() - started;
    assert.equal((await api<FileDocument>("readDocument", request("document.txt"))).content, "external");
    await window.webContents.reload(); await wait(() => registration.service.subscriptions.stats().subscriptions === 0, "reload releases subscriptions");
    await api("subscribe", { ...request("document.txt"), target: "document", subscriptionId: "close" }); window.destroy();
    await wait(() => registration.service.subscriptions.stats().roots === 0, "window destruction releases watchers");
    await registration.idle();
    stage("External path update, renderer reload and destroyed-window resource cleanup");
    assert.deepEqual(network, []); assert.deepEqual(errors, []);
    const artifacts = process.env.TACODE_FILE_SERVICE_ARTIFACTS ?? path.resolve("docs/file-review-reference"); await fs.mkdir(artifacts, { recursive: true });
    await fs.writeFile(path.join(artifacts, "fr-06-result.json"), JSON.stringify({ date: new Date().toISOString(), platform: platform(), os: release(), stages, refreshMs, network, errors, resources: registration.service.subscriptions.stats(), boundary: "Temporary APFS projects; production files IPC/preload/protocol; service acceptance, no FR-07/08 interface" }, null, 2) + "\n");
    console.log(`File service smoke passed, external update ${refreshMs.toFixed(1)} ms`);
  } finally {
    clearTimeout(watchdog); registration.dispose(); await registration.idle(); watchers.close(); if (!window.isDestroyed()) window.destroy();
    if (!process.env.TACODE_FILE_SERVICE_DIRECTORY) await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
void smoke().then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });
