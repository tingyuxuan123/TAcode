import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, protocol, type WebFrameMain } from "electron";
import { registerFileIpc } from "../src/main/files/file-ipc";
import { registerGitIpc } from "../src/main/git/git-ipc";
import { serveProjectPreview } from "../src/main/files/preview-server";
import { WorkspaceFileIndex } from "../src/main/workspace-file-index";
import { WorkspaceWatchers } from "../src/main/workspace-watcher";
import { WindowCloseGuard } from "../src/main/window-close-guard";
import { DOCUMENT_EDIT_BYTES, DOCUMENT_PAGE_BYTES, type FileDocument } from "../src/shared/files";
import { PREVIEW_SCHEME } from "../src/shared/types";
protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function smoke() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-file-formats-"));
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), "tacode-file-formats-artifacts-"));
  const a = path.join(directory, "project-a"); const b = path.join(directory, "project-b");
  const stages: string[] = []; const errors: string[] = []; const network: string[] = []; const opened: string[] = [];
  const write = async (root: string, name: string, bytes: string | Buffer) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
  const bitmap = (changed = false) => {
    const bytes = Buffer.alloc(320 * 240 * 4);
    for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) { const n = (y * 320 + x) * 4;
      bytes[n] = changed ? 200 : Math.floor(y * 255 / 240); bytes[n + 1] = x < 160 ? 190 : 40; bytes[n + 2] = changed ? 40 : Math.floor(x * 255 / 320); bytes[n + 3] = 255; }
    return nativeImage.createFromBitmap(bytes, { width: 320, height: 240, scaleFactor: 1 }).toPNG();
  };
  const markdown = '# 文件预览\n\n![相对图片](image.png)\n\n[相对文件](other.txt)\n\n| 名称 | 状态 |\n| --- | --- |\n| Markdown | 可用 |\n\n```ts\nconst value = 1;\n```\n\n' + Array.from({ length: 120 }, (_, i) => `## Section ${i}\n\n正文 ${i}\n`).join("\n");
  const html = (name: string) => `<!doctype html><meta charset="utf-8"><title>${name}</title><style>body{margin:24px;font:16px system-ui;color:#202123}img{width:320px;height:240px}section{height:2400px;background:#f4f4f5}</style><h1>${name}</h1><img src="image.png"><p id="asset"></p><section>HTML_SCROLL</section><script>addEventListener('load',async()=>{document.querySelector('#asset').textContent=await(await fetch('asset.txt')).text();localStorage.setItem('project','${name}');window.previewState={name:'${name}',api:typeof harness,node:typeof require,parentBlocked:false};try{window.previewState.parentBlocked=parent.harness===undefined}catch{window.previewState.parentBlocked=true}})</script>`;
  for (const [root, name] of [[a, "PROJECT_A"], [b, "PROJECT_B"]]) {
    await write(root, "nested/page.html", html(name)); await write(root, "nested/asset.txt", name); await write(root, "nested/image.png", bitmap(root === b));
  }
  await write(a, "nested/document.md", markdown); await write(a, "nested/other.txt", "LOCAL_LINK\n");
  await write(a, "shape.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#16a34a"/><circle cx="200" cy="100" r="60" fill="#dc2626"/><script>parent.svgExecuted=true</script></svg>');
  await write(a, "archive.bin", Buffer.from([0, 1, 2, 3, 4])); await write(a, "renamed.bin", bitmap()); await write(a, "empty.txt", ""); await write(a, "invalid.txt", Buffer.from([255, 128]));
  const largeBody = Array.from({ length: 65000 }, (_, i) => `${String(i).padStart(5, "0")} 汉字😀 ${"line ".repeat(22)}\n`).join("") + "LARGE_TAIL_尾部";
  assert.ok(Buffer.byteLength(largeBody) > DOCUMENT_EDIT_BYTES); await write(a, "large.txt", largeBody);
  const boundary = "a\n".repeat(DOCUMENT_EDIT_BYTES / 2); await write(a, "boundary.txt", boundary);
  app.setPath("userData", path.join(directory, "profile")); app.on("window-all-closed", () => {}); await app.whenReady();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] }]));
  const window = new BrowserWindow({ width: 1460, height: 860, show: true, webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  const guard = new WindowCloseGuard(window); let closing = false; let failRead = false;
  window.webContents.on("console-message", (event) => { if (event.level === "error") { errors.push(event.message); console.error(event.message); } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
  const index = new WorkspaceFileIndex(); const watchers = new WorkspaceWatchers((root, paths) => {
    if (paths) for (const file of paths) index.changed(root, file); else index.changed(root);
    if (!closing && !window.isDestroyed()) window.webContents.send("workspace:changed", { root, paths });
  });
  const resolveProject = async (root: string) => { if (root !== a && root !== b) throw new Error("Unknown project"); return root; };
  const files = registerFileIpc({ host: () => window.webContents, index, resolveProject, draftRoot: path.join(directory, "drafts"),
    watchProject: (root) => { if (watchers.watch(root)) index.changed(root); }, openPath: async (file) => { opened.push(file); return ""; } });
  const read = files.service.readDocument.bind(files.service); const reads: Array<{ path: string; offset?: number }> = [];
  files.service.readDocument = (request) => { reads.push(request); if (failRead) { failRead = false; return Promise.reject(new Error("fixture read failure")); } return read(request); };
  const marker = (html: string) => ["REACTIVATED_HTML", "EXTERNAL_HTML", "UNSAVED_HTML", "PROJECT_B", "PROJECT_A", "HTML_SCROLL"].find((name) => html.includes(name)) ?? "unknown";
  // Snapshot lifecycle trace: kept in memory and printed only when a stage fails.
  const timeline: string[] = [];
  const renderHtml = files.service.renderHtml.bind(files.service);
  files.service.renderHtml = (request, owner, active) => { const result = renderHtml(request, owner, active);
    void Promise.resolve(result).then((preview) => timeline.push(`render owner=${owner} id=${preview.id.slice(0, 8)} body=${marker(request.html)}`),
      (error) => timeline.push(`render rejected ${String(error)}`)); return result; };
  const releaseHtml = files.service.previews.releaseHtml.bind(files.service.previews);
  files.service.previews.releaseHtml = (owner, id) => { timeline.push(`release owner=${owner} id=${id?.slice(0, 8) ?? "all"}`); return releaseHtml(owner, id); };
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    const snapshot = new URL(request.url).searchParams.get("tacode-html-preview");
    try { const response = await serveProjectPreview(request, files.service.paths, files.service.previews);
      if (snapshot) timeline.push(`serve id=${snapshot.slice(0, 8)} status=${response.status}`); return response;
    } catch (error) { timeline.push(`serve id=${snapshot?.slice(0, 8) ?? "asset"} rejected ${String(error)}`); throw error; }
  });
  const git = registerGitIpc({ host: () => window.webContents, resolveProject, recoveryRoot: path.join(directory, "git-recovery") });
  ipcMain.handle("app:get-locale", () => "zh"); ipcMain.handle("app:set-locale", () => {});
  ipcMain.handle("workspace:list", async (_event, root: string, refresh?: boolean) => { await resolveProject(root); if (watchers.watch(root)) index.changed(root); return index.list(root, refresh); });
  const evaluate = <T = any>(code: string): Promise<T> => window.webContents.executeJavaScript(code, true);
  const fixture = "window.fileWorkbenchFixture"; const editor = `${fixture}.editor()`;
  const visible = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0)`;
  const wait = async (code: string, label: string, timeout = 15000) => { const start = Date.now(); while (!await evaluate(code)) { if (Date.now() - start > timeout) throw new Error(`Timeout after ${stages.at(-1)}: ${label}`); await delay(30); } };
  const click = async (selector: string) => {
    window.focus(); window.webContents.focus(); const point = await evaluate(`(()=>{const el=${visible(selector)};if(!el)throw Error('Missing '+${JSON.stringify(selector)});const r=el.getBoundingClientRect(),clip=el.closest('.cm-scroller')?.getBoundingClientRect();const left=Math.max(r.left,clip?.left??0,0),right=Math.min(r.right,clip?.right??innerWidth,innerWidth),top=Math.max(r.top,clip?.top??0,0),bottom=Math.min(r.bottom,clip?.bottom??innerHeight,innerHeight);if(right<=left||bottom<=top)throw Error('Clipped '+${JSON.stringify(selector)});return {x:Math.round((left+right)/2),y:Math.round((top+bottom)/2)}})()`);
    window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 }); window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 }); await delay(70);
  };
  const mod = process.platform === "darwin" ? "meta" : "control";
  const key = async (keyCode: string, modifiers: string[] = []) => { window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    if (keyCode === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers }); await delay(50); };
  const type = async (selector: string, text: string) => { await click(selector); await key("a", [mod]); await evaluate(`(()=>{const el=${visible(selector)};if(el instanceof HTMLInputElement)el.select()})()`); await window.webContents.insertText(text); await delay(50);
    if (selector.includes('.cm-content')) await wait(`${editor}?.content===${JSON.stringify(text)}`, "exact native editor input"); };
  const activeSelector = '[data-file-active="true"]';
  const open = async (name: string) => {
    await click('[data-panel-id="files"]'); await wait(`${visible('.project-file-tree-tools')}`, "root files");
    await type(`${activeSelector} .workbench-file-filter input`, name); await wait(`${visible(`[data-tree-path=${JSON.stringify(name)}]`)}`, "file row");
    await click(`${activeSelector} [data-tree-path=${JSON.stringify(name)}]`);
    await wait(`${fixture}.state().tabs.find(tab=>tab.id===${fixture}.state().active)?.path===${JSON.stringify(name)}&&!${fixture}.store.snapshot(${fixture}.state().root,${JSON.stringify(name)}).loading`, "opened document");
  };
  const source = async () => { await click(`${activeSelector} button[aria-label="源码"]`); await wait(`${editor}!==null`, "source editor"); };
  const project = async (root: string) => { await evaluate(`${fixture}.setRoot(${JSON.stringify(root)})`); await wait(`${fixture}.state().root===${JSON.stringify(root)}&&${fixture}.state().filesScope===JSON.stringify([${JSON.stringify(root)},${fixture}.state().session])`, "project scope applied"); };
  const preview = async (kind: string) => { await click(`${activeSelector} button[aria-label="预览"]`); await wait(`${visible(`[data-file-preview=${JSON.stringify(kind)}]`)}`, "rendered preview"); };
  const frame = async (): Promise<WebFrameMain> => {
    if (await evaluate(`${visible(`${activeSelector} .file-html-preview .file-preview-overlay`)}!==undefined`)) throw new Error("Preview is loading");
    const url = await evaluate<string>(`${visible(`${activeSelector} .file-html-preview iframe`)}?.src`);
    const found = window.webContents.mainFrame.frames.find((frame) => frame.url === url); if (!found) throw new Error("Missing preview frame"); return found;
  };
  const frameWait = async (code: string) => { const start = Date.now(); while (true) { try { if (await (await frame()).executeJavaScript(code)) return; } catch {} if (Date.now() - start > 15000) {
      try { console.error("Frame state:", await (await frame()).executeJavaScript("({title:document.querySelector('h1')?.textContent,top:scrollY,left:scrollX,ready:document.readyState,bridge:document.querySelector('script')?.textContent})")); } catch (error) { console.error(String(error)); }
      console.error("Frame URLs:", window.webContents.mainFrame.framesInSubtree.map((frame) => frame.url));
      console.error("Preview panels:", await evaluate(`[...document.querySelectorAll('.project-file-panel')].map(panel=>({path:panel.dataset.filePath,active:panel.dataset.fileActive,size:[panel.clientWidth,panel.clientHeight],
        preview:Boolean(panel.querySelector('.file-html-preview')),suspended:Boolean(panel.querySelector('.file-preview-suspended')),notice:panel.querySelector('.file-html-preview .file-document-notice')?.textContent,
        frames:[...panel.querySelectorAll('iframe')].map((el)=>({src:el.src,attribute:el.getAttribute('src'),connected:el.isConnected,size:[Math.round(el.getBoundingClientRect().width),Math.round(el.getBoundingClientRect().height)],loading:el.getAttribute('loading'),href:(()=>{try{return el.contentWindow.location.href}catch{return 'cross-origin'}})()}))}))`));
      console.error("Renderer state:", await evaluate(`${fixture}.state()`));
      console.error("HTML snapshot timeline:", timeline);
      console.error("Stored view:", await evaluate("Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith('tacode:file-view:')).map(key=>[key,JSON.parse(localStorage.getItem(key))]))"));
      throw new Error(`Frame timeout: ${code}`); } await delay(50); } };
  const capture = async (name: string) => { await delay(100); await fs.writeFile(path.join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG()); };
  const record = (name: string) => { stages.push(name); console.log(`[file/formats] ${name}`); };
  const watchdog = setTimeout(() => { console.error("File formats timeout"); app.exit(1); }, 200000);
  try {
    await window.loadFile(process.env.TACODE_FILE_WORKBENCH_FIXTURE!, { query: { project: a } }); await wait(`!!${fixture}`, "fixture");
    await open("nested/document.md"); await wait(`${visible('[data-file-preview="markdown"] img')}?.naturalWidth===320`, "relative Markdown bitmap");
    assert.equal(await evaluate(`${visible('[data-file-preview="markdown"] table')}!==undefined`), true);
    assert.equal(await evaluate(`new URL(${visible('[data-file-preview="markdown"] img')}.src).host`), new URL(files.service.previews.url(a, "nested/image.png")).host);
    await capture("markdown-zh"); await source(); assert.equal(await evaluate(`${editor}.content`), markdown);
    const editedMarkdown = markdown.replace("文件预览", "未保存预览"); await type(`${activeSelector} .cm-content`, editedMarkdown); await preview("markdown");
    await wait(`${visible('[data-file-preview="markdown"] h1')}?.textContent==='未保存预览'`, "unsaved Markdown"); assert.equal(await fs.readFile(path.join(a, "nested/document.md"), "utf8"), markdown);
    await key("s", [mod]); await wait(`!${fixture}.store.dirty().length`, "save from preview"); assert.equal(await fs.readFile(path.join(a, "nested/document.md"), "utf8"), editedMarkdown);
    record("Markdown GFM/code and project-relative images render exact current text; source editing and preview Mod-S save real disk");
    await evaluate(`${visible('[data-file-preview="markdown"]')}.scrollTop=1200`); await delay(200);
    await write(a, "nested/document.md", editedMarkdown + "\nEXTERNAL_MARKDOWN"); await wait(`${visible('[data-file-preview="markdown"]')}?.textContent.includes('EXTERNAL_MARKDOWN')`, "Markdown external refresh");
    assert.equal(await evaluate(`${visible('[data-file-preview="markdown"]')}.scrollTop`), 1200);
    await source(); await preview("markdown"); await wait(`${visible('[data-file-preview="markdown"]')}.scrollTop===1200`, "Markdown mode scroll restore");
    await evaluate(`${visible('[data-file-preview="markdown"]')}.scrollTop=0`); await click('[data-file-preview="markdown"] a'); await wait(`${editor}?.content===${JSON.stringify("LOCAL_LINK\n")}`, "project-relative link");
    record("Markdown refresh and source/preview changes preserve reading position; relative links open the correct project file");

    await open("nested/page.html"); await wait(`${editor}!==null`, "HTML source default"); await preview("html"); await frameWait("window.previewState&&document.querySelector('#asset').textContent==='PROJECT_A'&&document.querySelector('img').naturalWidth===320");
    assert.deepEqual(await (await frame()).executeJavaScript("window.previewState"), { name: "PROJECT_A", api: "undefined", node: "undefined", parentBlocked: true });
    const htmlAOrigin = new URL((await frame()).url).host; await capture("html-zh");
    await source(); const dirtyHtml = html("PROJECT_A").replace("<h1>PROJECT_A</h1>", "<h1>UNSAVED_HTML</h1>"); await type(`${activeSelector} .cm-content`, dirtyHtml); await preview("html"); await frameWait("document.querySelector('h1').textContent==='UNSAVED_HTML'&&document.querySelector('#asset').textContent==='PROJECT_A'");
    assert.equal(await fs.readFile(path.join(a, "nested/page.html"), "utf8"), html("PROJECT_A"));
    await key("s", [mod]); await wait(`!${fixture}.store.dirty().length&&!${fixture}.store.snapshot(${JSON.stringify(a)},'nested/page.html').saving`, "HTML preview save"); await frameWait("document.querySelector('h1').textContent==='UNSAVED_HTML'");
    record("HTML snapshots run scripts, relative images/fetch and project storage; no Node/workbench bridge; unsaved preview never writes disk");
    await (await frame()).executeJavaScript("scrollTo(0,1500)"); await delay(250);
    await write(a, "nested/page.html", dirtyHtml.replace("UNSAVED_HTML", "EXTERNAL_HTML")); await frameWait("document.querySelector('h1').textContent==='EXTERNAL_HTML'&&scrollY===1500");
    await source(); await preview("html"); await frameWait("scrollY===1500");
    record("HTML disk refresh and source/preview changes preserve exact scroll");
    await project(b); await open("nested/page.html"); await preview("html"); await frameWait("window.previewState?.name==='PROJECT_B'&&document.querySelector('#asset').textContent==='PROJECT_B'&&localStorage.getItem('project')==='PROJECT_B'");
    assert.notEqual(new URL((await frame()).url).host, htmlAOrigin); await project(a); await open("nested/page.html");
    if (await evaluate(`${visible(`${activeSelector} .file-view-modes button[aria-label="预览"]`)}.getAttribute('aria-pressed')==='false'`)) await preview("html");
    await frameWait("localStorage.getItem('project')==='PROJECT_A'&&scrollY===1500");
    await evaluate(`${fixture}.setHidden(true)`); await delay(250); await files.idle(); assert.deepEqual(files.service.previews.stats(), { htmlSnapshots: 0, htmlBytes: 0 });
    const hiddenReads = reads.length; await write(a, "nested/page.html", dirtyHtml.replace("UNSAVED_HTML", "REACTIVATED_HTML")); await delay(350); assert.equal(reads.length, hiddenReads);
    await evaluate(`${fixture}.setHidden(false)`); await frameWait("document.querySelector('h1').textContent==='REACTIVATED_HTML'&&scrollY===1500");
    record("HTML external refresh/mode/re-activation preserve exact scroll, same-name project assets/storage remain isolated, hidden snapshots and reads release");

    await open("renamed.bin"); await wait(`${visible('[data-file-preview="image"] img')}?.naturalWidth===320`, "signature-detected bitmap");
    assert.equal(await evaluate(`${visible('[data-file-preview="image"] img')}.naturalHeight`), 240);
    await click('button[aria-label="放大"]'); await click('button[aria-label="放大"]'); assert.equal(await evaluate(`${visible('[data-file-preview="image"] img')}.style.width`), "480px");
    await click('button[aria-label="适应窗口"]'); await capture("image-zh");
    const imageRect = await evaluate(`(()=>{const r=${visible('[data-file-preview="image"] img')}.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()`);
    const pixels = (await window.webContents.capturePage(imageRect)).toBitmap(); assert.ok(new Set(Array.from(pixels)).size > 100);
    await write(a, "renamed.bin", bitmap(true)); const imageVersion = (await read({ projectRoot: a, path: "renamed.bin" })).version;
    await wait(`${visible('[data-file-preview="image"] img')}.src.includes(${JSON.stringify(imageVersion)})&&${visible('[data-file-preview="image"] img')}.complete&&${visible('[data-file-preview="image"] img')}.naturalWidth===320`, "bitmap refresh");
    assert.notEqual(Buffer.compare(pixels, (await window.webContents.capturePage(imageRect)).toBitmap()), 0);
    await open("shape.svg"); await wait(`${visible('[data-file-preview="image"] img')}?.naturalWidth===400`, "SVG render"); assert.equal(await evaluate("window.svgExecuted"), undefined);
    await source(); const svg = await evaluate<string>(`${editor}.content`); await type(`${activeSelector} .cm-content`, svg.replace("#16a34a", "#2563eb")); await preview("image"); await wait(`${visible('[data-file-preview="image"] img')}?.naturalWidth===400`, "dirty SVG render");
    assert.equal(await fs.readFile(path.join(a, "shape.svg"), "utf8"), svg); await key("s", [mod]); await wait(`!${fixture}.store.dirty().length`, "SVG save");
    await click(`${activeSelector} button[aria-label="刷新"]`); await wait(`${visible('[data-file-preview="image"] .workbench-empty[role="status"]')}===undefined`, "unchanged SVG refresh is settled");
    record("Signature-detected bitmap and SVG previews render nonblank assets, native zoom/fit work, SVG scripts stay inert and source/dirty preview/save stay accurate");
    await open("archive.bin"); await wait(`${visible('[data-file-preview="binary"]')}`, "binary summary"); assert.equal(await evaluate(`${visible('[data-file-preview="binary"]')}.textContent.includes('5 B')`), true);
    await click(`${activeSelector} button[aria-label="打开"]`); await click('.file-action-menu [data-file-action="system"]'); assert.deepEqual(opened, [path.join(a, "archive.bin")]);
    await open("invalid.txt"); await wait(`${visible('[data-file-preview="binary"]')}?.textContent.includes('UTF-8')`, "invalid encoding summary"); await open("empty.txt"); await wait(`${editor}?.content===''`, "empty editable file");
    failRead = true; await click(`${activeSelector} button[aria-label="刷新"]`); await wait(`${visible('.file-document-notice[role="alert"]')}`, "read error"); await click('.file-document-notice button'); await wait(`!${fixture}.store.snapshot(${JSON.stringify(a)},'empty.txt').error`, "read retry");
    await fs.rm(path.join(a, "empty.txt")); await wait(`${visible('.workbench-empty')}?.textContent.includes('不存在')`, "missing file");
    record("Binary/invalid encoding show type and exact size with explicit-project Open; empty/loading/failure/retry/deleted states remain distinct");

    await open("large.txt"); await wait(`${editor}!==null`, "first large chunk"); assert.ok(Buffer.byteLength(await evaluate<string>(`${editor}.content`)) <= DOCUMENT_PAGE_BYTES);
    assert.equal(await evaluate(`${visible('.cm-content')}.getAttribute('contenteditable')`), "false");
    const chunks: string[] = []; let chunkCount = 0;
    while (true) {
      chunks.push(await evaluate<string>(`${editor}.content`)); chunkCount++;
      const disabled = await evaluate<boolean>(`${visible('button[aria-label="下一段"]')}.disabled`); if (disabled) break;
      await click('button[aria-label="下一段"]'); await wait(`${visible('.file-page-tools input')}?.disabled===false&&${editor}!==null`, "next chunk");
    }
    assert.equal(chunks.join(""), largeBody); assert.ok(chunkCount > 24); assert.ok(chunks.at(-1)!.endsWith("LARGE_TAIL_尾部"));
    const base = await files.service.readDocument({ projectRoot: a, path: "large.txt" });
    const refused = await evaluate(`window.harness.files.writeDocument(${JSON.stringify({ projectRoot: a, path: "large.txt", expectedVersion: base.version, content: "partial" })})`);
    assert.equal(refused.error.code, "tooLarge"); assert.equal(await fs.readFile(path.join(a, "large.txt"), "utf8"), largeBody);
    record("Every oversized UTF-8 chunk including the tail is reachable with no gaps; native read-only and production partial-write refusal protect disk");
    await click('button[aria-label="开头"]'); await wait(`${editor}?.content.startsWith('00000')&&${visible('.file-page-tools input')}.disabled===false`, "first chunk restored");
    await evaluate(`${fixture}.setPosition(1200,80)`); await delay(250); await click('button[aria-label="下一段"]'); await wait(`${visible('.file-page-tools input')}.disabled===false`, "second page");
    await click('button[aria-label="上一段"]'); await wait(`${editor}?.top===1200&&${editor}?.selectionLine===80`, "previous page exact position");
    await type('.file-page-tools input', String(DOCUMENT_PAGE_BYTES)); await key("Enter"); await wait(`${visible('.file-page-tools input')}.disabled===false&&${visible('.file-page-tools')}.dataset.fileOffset==='262144'`, "actual byte-offset jump");
    await key("Enter"); assert.equal(await evaluate(`${visible('.file-page-tools input')}.disabled`), false);
    await evaluate(`${fixture}.setPosition(1000,60)`); await delay(250); await write(a, "large.txt", largeBody.replace("LARGE_TAIL_尾部", "CHANGED_TAIL_尾部"));
    const changedVersion = (await read({ projectRoot: a, path: "large.txt" })).version;
    await wait(`${visible('.file-page-tools')}.dataset.filePageVersion===${JSON.stringify(changedVersion)}&&!${visible('.file-page-tools input')}.disabled`, "large version refresh");
    assert.equal(await evaluate(`${editor}.top`), 1000); assert.equal(await evaluate(`${editor}.selectionLine`), 60);
    const reloaded = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve())); window.webContents.reload(); await reloaded;
    await wait(`!!${fixture}&&${editor}?.selectionLine===60&&${editor}?.top===1000&&${visible('.file-page-tools')}?.dataset.fileOffset==='262144'`, "large persisted page and position reload");
    await evaluate(`${fixture}.setLocale('en')`); window.setSize(920, 780); await capture("large-en-narrow");
    assert.equal(await evaluate("[...document.querySelectorAll('.file-page-tools')].filter(el=>el.clientHeight>0).every(el=>el.scrollWidth<=el.clientWidth+1)"), true);
    record("Chunk navigation stores separate exact positions; byte jump, external version refresh, renderer reload and narrow English bounds preserve the selected page");
    await evaluate(`${fixture}.setLocale('zh')`); window.setSize(1460, 860); await open("boundary.txt"); await wait(`${editor}?.content.length===4194304`, "exact 4 MiB complete editor", 30000);
    assert.equal(await evaluate(`${visible('.cm-content')}.getAttribute('contenteditable')`), "true");
    await click(`${activeSelector} .cm-content`); await key("Home", [mod]); await key("Right", ["shift"]); await window.webContents.insertText("b"); await key("s", [mod]); await wait(`!${fixture}.store.dirty().length`, "exact-boundary save", 30000);
    assert.equal(await fs.readFile(path.join(a, "boundary.txt"), "utf8"), "b" + boundary.slice(1));
    record("The exact 4 MiB production CodeMirror document is complete, editable and saves a real native change without truncation");
    assert.deepEqual(errors, []); assert.deepEqual(network, []);
    window.destroy(); closing = true; watchers.close(); files.dispose(); git.dispose(); guard.dispose(); await files.idle(); await git.idle();
    assert.deepEqual(files.service.subscriptions.stats(), { subscriptions: 0, roots: 0, reads: 0 }); assert.deepEqual(files.service.previews.stats(), { htmlSnapshots: 0, htmlBytes: 0 });
    const result = { date: new Date().toISOString(), stages, chunkCount, errors, network, resources: files.service.subscriptions.stats(), previews: files.service.previews.stats(), git: git.service.stats(), artifacts,
      boundary: "Production preload/files+Git IPC, WorkbenchPanels and project preview protocol; native Chromium input, real APFS files, bitmap pixel checks, isolated HTML frames and exact 4 MiB save. The system Open adapter records the absolute path." };
    await fs.writeFile(path.join(artifacts, "result.json"), JSON.stringify(result, null, 2) + "\n"); await fs.writeFile("docs/file-review-reference/fr-10-result.json", JSON.stringify(result, null, 2) + "\n");
    for (const name of ["markdown-zh", "html-zh", "image-zh", "large-en-narrow"]) await fs.copyFile(path.join(artifacts, `${name}.png`), `docs/file-review-reference/fr-10-${name}.png`);
    console.log(JSON.stringify(result, null, 2)); clearTimeout(watchdog); await fs.rm(directory, { recursive: true, force: true }); app.quit();
  } catch (error) { console.error(error); await capture("failure").catch(() => {}); await fs.writeFile(path.join(artifacts, "failure.html"), await evaluate<string>("document.body.outerHTML")).catch(() => {}); console.error(`Artifacts: ${artifacts}`); clearTimeout(watchdog); window.destroy(); app.exit(1); }
}
void smoke().catch((error) => { console.error(error); app.exit(1); });
