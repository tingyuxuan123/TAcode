import assert from "node:assert/strict";
import { app, BrowserWindow, type InputEvent } from "electron";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform, release, cpus } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function smoke() {
  const profile = await mkdtemp(path.join(tmpdir(), "tacode-file-review-profile-"));
  app.setPath("userData", profile);
  app.commandLine.appendSwitch("force-device-scale-factor", "2");
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const fixture = process.env.TACODE_FILE_REVIEW_FIXTURE;
  if (!fixture) throw new Error("Missing file/review fixture");
  const artifactDir = process.env.TACODE_FILE_REVIEW_ARTIFACTS ?? await mkdtemp(path.join(tmpdir(), "tacode-file-review-artifacts-"));
  await mkdir(artifactDir, { recursive: true });
  const window = new BrowserWindow({ width: 820, height: 785, useContentSize: true, show: false,
    webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "file-review-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const network: string[] = [];
  const errors: string[] = [];
  const stages: string[] = [];
  let failed = false;
  const watchdog = setTimeout(() => { console.error("File/review smoke timed out"); app.exit(1); }, 90_000);
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
  window.webContents.on("console-message", (event) => { if (event.level === "error") { errors.push(event.message); console.error("[renderer]", event.message); } });
  window.webContents.on("render-process-gone", (_event, details) => { errors.push(`renderer gone: ${details.reason}`); });
  const evaluate = <T = unknown>(source: string): Promise<T> => window.webContents.executeJavaScript(source);
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const wait = async (source: string, label: string, timeout = 10_000) => {
    const start = Date.now();
    while (!(await evaluate(source))) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`); await delay(40); }
  };
  const key = async (keyCode: string, modifiers: string[] = []) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers } as InputEvent);
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers } as InputEvent);
    await delay(70);
  };
  const mod = process.platform === "darwin" ? "meta" : "control";
  const click = async (selector: string) => {
    const position = await evaluate<{ x: number; y: number }>(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error("Missing: " + ${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    window.webContents.sendInputEvent({ type: "mouseDown", ...position, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", ...position, button: "left", clickCount: 1 });
    await delay(80);
  };
  const capture = async (name: string) => {
    await delay(100);
    await writeFile(path.join(artifactDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const stage = (name: string) => { stages.push(name); console.log(`[file/review] ${name}`); };
  try {
    await window.loadFile(fixture);
    await wait("window.fileReviewFixture && document.querySelector('.cm-content') && document.querySelector('.cm-content span')", "editor and lazy language ready");
    await capture("files-default");
    const original = await evaluate<string>("window.fileReviewFixture.state().content");
    await evaluate("window.fileReviewFixture.focusEditor(1, 1)");
    await window.webContents.insertText("// 中文编辑回归\n");
    await wait("window.fileReviewFixture.state().dirty && window.fileReviewFixture.state().content.startsWith('// 中文编辑回归')", "native text editing");
    await key("s", [mod]);
    assert.equal(await evaluate("window.fileReviewFixture.state().saves"), 1);
    assert.equal(await evaluate("window.fileReviewFixture.state().dirty"), false);
    await key("z", [mod]);
    assert.equal(await evaluate("window.fileReviewFixture.state().content"), original, "undo restores exact original text");
    await key("z", [mod, "shift"]);
    assert.match(await evaluate<string>("window.fileReviewFixture.state().content"), /^\/\/ 中文编辑回归/);
    await key("f", [mod]);
    await wait("document.querySelector('.cm-search input')", "native Find shortcut");
    await window.webContents.insertText("buildRenderer");
    await key("Enter");
    assert.ok(await evaluate("document.querySelectorAll('.cm-searchMatch').length > 0"), "search decorates actual matches");
    await capture("files-edit-find");
    await key("Escape");
    stage("CodeMirror native input, save, undo/redo and find");

    await click('.workbench-file-filter input');
    await window.webContents.insertText("App.tsx");
    await wait("document.querySelector('[data-tree-path=\"src/renderer/App.tsx\"]')", "root path search finds nested file");
    await capture("files-filter");
    await click('[data-tree-path="src/renderer/App.tsx"]');
    await wait("window.fileReviewFixture.state().path === 'src/renderer/App.tsx' && document.querySelector('[aria-label=\"src/renderer/App.tsx\"]')", "file navigation");
    await evaluate("window.fileReviewFixture.setReadOnly(true)");
    await wait("document.querySelector('.cm-content').contentEditable === 'false'", "read-only mode");
    const readOnlyText = await evaluate("window.fileReviewFixture.state().content");
    await evaluate("window.fileReviewFixture.focusEditor()");
    await window.webContents.insertText("must not write");
    assert.equal(await evaluate("window.fileReviewFixture.state().content"), readOnlyText);
    await evaluate("window.fileReviewFixture.setReadOnly(false); window.fileReviewFixture.open('src/shared/中文 空格.ts')");
    await wait("document.querySelector('[data-document-id=\"fixture:src/shared/中文 空格.ts\"] .cm-content')", "Chinese path and CRLF");
    await evaluate("window.fileReviewFixture.focusEditor(2, 1)");
    await window.webContents.insertText("// 保留换行\n");
    const crlf = await evaluate<string>("window.fileReviewFixture.state().content");
    assert.ok(crlf.includes("\r\n"));
    assert.ok(!/(?<!\r)\n/.test(crlf), "native insertion preserves CRLF");
    stage("Tree path search, file switching, read-only input and CRLF preservation");

    await evaluate("window.fileReviewFixture.showReview()");
    await wait("window.fileReviewFixture.state().worker?.managerState === 'initialized' && window.fileReviewFixture.state().worker?.diffCacheSize > 0 && document.querySelector('diffs-container')?.shadowRoot?.querySelector('pre')", "offline diff worker and rendering", 20_000);
    const worker = await evaluate<any>("window.fileReviewFixture.state().worker");
    assert.equal(worker.workersFailed, false);
    assert.equal(worker.totalWorkers, 2);
    assert.equal(network.length, 0, "no external assets were requested");
    await window.webContents.setZoomFactor(1);
    window.setContentSize(836, 740);
    await capture("review-unified");
    const rendering = await evaluate<any>(`(() => { const roots = [...document.querySelectorAll('diffs-container')].map(e => e.shadowRoot); return { tokens: roots.reduce((n,r) => n + r.querySelectorAll('span[style]').length, 0), text: roots.map(r => r.textContent).join(''), mountedFiles: roots.length }; })()`);
    assert.ok(rendering.tokens > 20, "syntax tokens are present after worker highlighting");
    assert.ok(rendering.mountedFiles < 9, "multi-file view virtualizes offscreen items");
    stage("Offline local worker pool, syntax highlighting and multi-file virtualization");

    await click('[aria-label="左右对照"]');
    await wait("document.querySelector('[aria-label=\"统一视图\"]')", "split toolbar state");
    // Added-only files have one code column in either layout. Use a real edit.
    await click('[data-tree-path="src/renderer/App.tsx"]');
    await wait("[...document.querySelectorAll('diffs-container')].some(e => e.shadowRoot?.querySelector('[data-diff-type=\"split\"]'))", "split diff layout");
    await capture("review-split");
    await wait("[...document.querySelectorAll('[data-diff-path]')].some(e => e.dataset.diffPath === 'src/renderer/App.tsx' && e.getBoundingClientRect().top < 100 && e.getBoundingClientRect().bottom > 40)", "jump to later file");
    await capture("review-jump");
    await click('[aria-label="统一视图"]');
    await click('[aria-label="折叠全部文件"]');
    await wait("document.querySelectorAll('[data-diff-path]').length === 9", "collapsed files share continuous view");
    await capture("review-collapsed");
    await click('[aria-label="展开全部文件"]');
    await click('.workbench-file-filter input');
    await window.webContents.insertText("i18n");
    await wait("document.querySelectorAll('[data-tree-path]').length === 3 && document.querySelector('[data-diff-path=\"src/shared/i18n.ts\"]')", "filter tree and multi-file diff together");
    await capture("review-filter");
    stage("Unified/split, file jump, collapse/expand and review filtering");

    await click('[aria-label="调整文件树宽度"]');
    const beforeWidth = await evaluate<number>("document.querySelector('.workbench-navigation').getBoundingClientRect().width");
    assert.equal(await evaluate("document.activeElement?.getAttribute('role')"), "separator", "native click focuses divider");
    await key("Left");
    const afterWidth = await evaluate<number>("document.querySelector('.workbench-navigation').getBoundingClientRect().width");
    assert.ok(afterWidth > beforeWidth, "keyboard divider resizes tree");
    await click('[aria-label="隐藏文件树"]');
    assert.equal(await evaluate("document.querySelector('.workbench-navigation') === null"), true);
    await click('[aria-label="显示文件树"]');
    await click('[aria-label="暂存全部"]');
    assert.equal(await evaluate("window.fileReviewFixture.state().lastAction"), "stageAll");
    await evaluate("(() => { const s = document.querySelector('.workbench-scope'); s.value = 'commit'; s.dispatchEvent(new Event('change', {bubbles:true})); })()");
    await wait("document.querySelector('.workbench-review-actions') === null", "historical scope has no mutation actions");
    window.setContentSize(600, 740);
    await capture("review-narrow");
    await evaluate("window.fileReviewFixture.setColorScheme('dark')");
    await wait("document.querySelector('[data-color-scheme=\"dark\"]')", "dark tokens");
    await capture("review-dark");
    await evaluate("window.fileReviewFixture.setLocale('en')");
    await wait("document.querySelector('[aria-label=\"Filter files…\"]')", "English controls");
    stage("Resizable/collapsible tree, action callbacks, read-only scope, narrow/dark/English states");

    assert.deepEqual(errors, [], "renderer must complete without console errors");
    await writeFile(path.join(artifactDir, "result.json"), JSON.stringify({ status: "passed", stages, worker, rendering: { tokens: rendering.tokens, mountedFiles: rendering.mountedFiles }, network, errors,
      device: { platform: platform(), release: release(), cpu: cpus()[0]?.model, versions: process.versions },
      viewport: { files: [820, 785], review: [836, 740], narrow: [600, 740], dpr: await evaluate("devicePixelRatio") } }, null, 2) + "\n");
    console.log(`File/review Electron smoke passed. Artifacts: ${artifactDir}`);
  } catch (error) {
    failed = true;
    console.error("File/review Electron smoke failed", error);
    await capture("failure").catch(() => {});
    await writeFile(path.join(artifactDir, "failure.json"), JSON.stringify({ stages, errors, network, message: String(error), state: await evaluate("window.fileReviewFixture?.state()").catch(() => null) }, null, 2));
    console.error(`Artifacts: ${artifactDir}`);
  } finally {
    clearTimeout(watchdog);
    if (!window.isDestroyed()) window.destroy();
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    app.exit(failed ? 1 : 0);
  }
}
void smoke();
