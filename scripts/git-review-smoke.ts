import assert from "node:assert/strict";
import { app, BrowserWindow, ipcMain, type InputEvent } from "electron";
import fs from "node:fs/promises";
import { tmpdir, platform, release, cpus, devNull } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerGitIpc } from "../src/main/git/git-ipc";
import { GitReader } from "../src/main/git/git-reader";

const exec = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function smoke() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "tacode-git-review-smoke-"));
  const profile = path.join(directory, "profile"); await fs.mkdir(profile); app.setPath("userData", profile);
  app.commandLine.appendSwitch("force-device-scale-factor", "2"); app.on("window-all-closed", () => {});
  const fixture = process.env.TACODE_GIT_REVIEW_FIXTURE;
  if (!fixture) throw new Error("Missing Git review fixture");
  const artifacts = process.env.TACODE_GIT_REVIEW_ARTIFACTS ?? await fs.mkdtemp(path.join(tmpdir(), "tacode-git-review-artifacts-"));
  await fs.mkdir(artifacts, { recursive: true });
  const a = path.join(directory, "project-a"); const b = path.join(directory, "project-b"); const fresh = path.join(directory, "fresh");
  for (const root of [a, b, fresh]) await fs.mkdir(root);
  const git = async (cwd: string, args: string[]) => (await exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_DEFAULT_HASH: "sha1",
  } })).stdout.trimEnd();
  const write = async (root: string, file: string, text: string | Buffer) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); };
  for (const root of [a, b]) { await git(root, ["init", "-qb", "main"]); await git(root, ["config", "user.name", "TACode fixture"]); await git(root, ["config", "user.email", "fixture@example.invalid"]); }
  const lines = Array.from({ length: 90 }, (_, index) => `export const value${index + 1} = ${index + 1};`);
  const source = (values: string[]) => values.join("\n") + "\n";
  await write(a, "src/alpha.ts", source(lines)); await write(a, "permissions.sh", "#!/bin/sh\necho ready\n");
  await git(a, ["add", "--all"]); await git(a, ["commit", "-qm", "root"]);
  const rootCommit = await git(a, ["rev-parse", "HEAD"]);
  await git(a, ["branch", "base"]); lines[9] = "export const value10 = 1000;";
  await write(a, "src/alpha.ts", source(lines)); await git(a, ["add", "--all"]); await git(a, ["commit", "-qm", "head"]);
  const head = await git(a, ["rev-parse", "HEAD"]);
  lines[4] = "export const value5 = 500;"; await write(a, "src/alpha.ts", source(lines)); await git(a, ["add", "src/alpha.ts"]);
  lines[64] = "export const value65 = 650;"; await write(a, "src/alpha.ts", source(lines));
  await write(a, "新增 文件.txt", "真实未跟踪文件\n"); await write(a, "empty.txt", "");
  await write(a, "image.bin", Buffer.from([0, 1, 2, 255]));
  await write(a, "large.txt", "large content\n".repeat(Math.ceil(8 * 1024 * 1024 / 14)));
  if (process.platform !== "win32") await fs.chmod(path.join(a, "permissions.sh"), 0o755);
  await write(b, "src/alpha.ts", "PROJECT_B_ONLY\n");
  const allowed = new Set([a, b, fresh]);
  await app.whenReady();
  const window = new BrowserWindow({ width: 836, height: 740, useContentSize: true, show: false,
    webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "git-review-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const session = window.webContents.session;
  let delayNextRead = false; let heldRead = false; let releaseRead: (() => void) | undefined;
  const registration = registerGitIpc({ host: () => window.webContents,
    resolveProject: async (root) => { if (!allowed.has(root)) throw new Error("Folder is not an opened project"); return root; },
    reader: (root) => {
      const reader = new GitReader(root);
      return { inspect: reader.inspect.bind(reader), branches: reader.branches.bind(reader), read: async (query, signal) => {
        const snapshot = await reader.read(query, signal);
        if (delayNextRead && root === await fs.realpath(a)) { delayNextRead = false; heldRead = true; await new Promise<void>((resolve) => { releaseRead = resolve; }); }
        return snapshot;
      } };
    },
  });
  ipcMain.handle("app:get-locale", () => "zh"); ipcMain.handle("app:set-locale", () => {});
  const network: string[] = []; const errors: string[] = []; const stages: string[] = []; const refreshMs: number[] = [];
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
  window.webContents.on("console-message", (event) => { if (event.level === "error") { errors.push(event.message); console.error("[renderer]", event.message); } });
  window.webContents.on("render-process-gone", (_event, details) => { errors.push(`renderer gone: ${details.reason}`); });
  const watchdog = setTimeout(() => { console.error("Git review smoke timed out"); app.exit(1); }, 120_000);
  const evaluate = <T = unknown>(text: string): Promise<T> => window.webContents.executeJavaScript(text);
  const wait = async (test: string | (() => boolean), label: string, timeout = 10_000) => {
    const start = Date.now();
    while (!(typeof test === "string" ? await evaluate(test) : test())) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`); await delay(40); }
  };
  const key = async (keyCode: string, modifiers: string[] = []) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers } as InputEvent);
    if (keyCode === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers } as InputEvent); await delay(60);
  };
  const click = async (selector: string, shadow = false) => {
    const location = await evaluate<{ x: number; y: number }>(`(() => { const e = ${shadow ? "[...document.querySelectorAll('diffs-container')].map(e => e.shadowRoot?.querySelector(" + JSON.stringify(selector) + ")).find(Boolean)" : "document.querySelector(" + JSON.stringify(selector) + ")"}; if (!e) throw new Error('Missing element'); const r = e.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()`);
    window.webContents.sendInputEvent({ type: "mouseDown", ...location, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", ...location, button: "left", clickCount: 1 }); await delay(80);
  };
  const select = (selector: string, value: string) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const state = "document.querySelector('.git-review-panel')?.dataset.reviewState";
  const ready = () => wait(`${state} === 'ready'`, "ready repository snapshot");
  const code = "[...document.querySelectorAll('diffs-container')].map(e => e.shadowRoot?.querySelector('pre')?.textContent ?? '').join('\\n')";
  const hasCode = (text: string) => `(${code}).includes(${JSON.stringify(text)})`;
  const capture = async (name: string) => {
    await delay(140);
    if (await evaluate("Boolean(document.querySelector('diffs-container'))")) {
      await wait("(() => { const w = window.gitReviewFixture.state().workerState; return w?.managerState === 'initialized' && w.activeTasks === 0 && w.queuedTasks === 0; })()", "highlighting before screenshot", 20_000);
    }
    await fs.writeFile(path.join(artifacts, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const stage = (name: string) => { stages.push(name); console.log(`[git/review] ${name}`); };
  let failed = false;
  try {
    await window.loadFile(fixture, { query: { project: a } }); await ready();
    await wait("document.querySelector('[data-tree-path=\"src/alpha.ts\"]')", "real changed-file tree");
    await click('[data-tree-path="src/alpha.ts"]'); await wait(hasCode("value65 = 650"), "index to worktree diff");
    await wait("window.gitReviewFixture.state().workerState?.managerState === 'initialized' && window.gitReviewFixture.state().workerState?.diffCacheSize > 0", "real review worker highlighting", 20_000);
    await wait("[...document.querySelectorAll('diffs-container')].some(e => e.shadowRoot?.querySelector('pre span[style]'))", "syntax colors in the real review");
    await wait("(() => { const view = document.querySelector('.workbench-diff-viewer').getBoundingClientRect(); return [...document.querySelectorAll('diffs-container')].some(host => [...host.shadowRoot.querySelectorAll('[data-line]')].some(line => { const r = line.getBoundingClientRect(); return line.textContent.includes('value65 = 650') && r.top >= view.top && r.bottom <= view.bottom; })); })()", "file click during lazy loading makes its changed line visible");
    assert.equal(await evaluate("document.querySelector('[data-tree-path=\"src/alpha.ts\"]').getAttribute('aria-selected')"), "true", "clamped programmatic scrolling preserves the clicked file selection");
    assert.ok(!(await evaluate(hasCode("value5 = 5;"))), "staged changes are not part of the unstaged diff");
    assert.equal(await evaluate("typeof window.require"), "undefined");
    assert.equal(await evaluate("window.gitReviewFixture.state().workers.active"), 2);
    await capture("git-unstaged");
    stage("Production preload, main Git service, real index/worktree comparison");

    const beforeRows = await evaluate<number>("[...document.querySelectorAll('diffs-container')].reduce((n,e) => n + e.shadowRoot.querySelectorAll('[data-line]').length, 0)");
    await click('[data-expand-button]', true);
    await wait(`(${hasCode("value45 = 45")}) || [...document.querySelectorAll('diffs-container')].reduce((n,e) => n + e.shadowRoot.querySelectorAll('[data-line]').length, 0) > ${beforeRows}`, "expanding omitted original context");
    await click('[aria-label="左右对照"]');
    await wait("[...document.querySelectorAll('diffs-container')].some(e => e.shadowRoot?.querySelector('[data-diff-type=\"split\"]'))", "real split diff");
    await capture("git-split-context");
    stage("Continuous diff, file-tree navigation, split layout and full-context expansion");

    await click('[data-tree-path="image.bin"]');
    await wait("document.querySelector('[data-diff-summary=\"binary\"]')", "binary metadata instead of fake text");
    await capture("git-binary");
    await click('[data-tree-path="large.txt"]');
    await wait("document.querySelector('[data-diff-summary=\"tooLarge\"]')", "oversize metadata");
    await capture("git-large");
    await click('[data-tree-path="empty.txt"]');
    await wait("document.querySelector('[data-diff-summary=\"empty\"]')", "empty file distinct from binary");
    await capture("git-empty");
    stage("Binary, oversized, empty and permission metadata stay separate from source");

    await select('.workbench-scope', "staged"); await ready();
    await wait(hasCode("value5 = 500"), "HEAD to index diff");
    assert.ok(!(await evaluate(hasCode("value65 = 650"))));
    await capture("git-staged");
    await select('.workbench-scope', "commit"); await ready();
    await wait(hasCode("value10 = 1000"), "first parent to commit diff");
    assert.equal(await evaluate("document.querySelector('.workbench-readonly')?.textContent"), "只读");
    await capture("git-commit");
    await click('#review-commit-ref'); window.webContents.selectAll(); await window.webContents.insertText("does-not-exist"); await key("Enter");
    await wait(`${state} === 'error'`, "invalid reference error");
    assert.match(await evaluate<string>("document.querySelector('[role=\"alert\"]').textContent"), /找不到/);
    await capture("git-error");
    await click('#review-commit-ref'); window.webContents.selectAll(); await window.webContents.insertText(rootCommit); await key("Enter"); await ready();
    await wait(hasCode("value1 = 1"), "root commit against empty tree");
    await select('.workbench-scope', "branch");
    await wait(`${state} === 'repository'`, "branch choice before comparison");
    await select('[aria-label="基准分支"]', "refs/heads/base"); await ready();
    await wait(hasCode("value10 = 1000"), "merge-base to HEAD");
    assert.ok(!(await evaluate(hasCode("value65 = 650"))));
    await capture("git-branch");
    stage("Staged, commit, root commit, branch choice, merge base and reference-error recovery");

    await select('.workbench-scope', "unstaged"); await ready(); await click('[data-tree-path="src/alpha.ts"]');
    let started = Date.now(); lines[64] = "export const value65 = 999;"; await write(a, "src/alpha.ts", source(lines));
    await wait(hasCode("value65 = 999"), "automatic external file refresh"); refreshMs.push(Date.now() - started);
    started = Date.now(); await git(a, ["add", "src/alpha.ts"]);
    await wait("!document.querySelector('[data-tree-path=\"src/alpha.ts\"]')", "external index refresh"); refreshMs.push(Date.now() - started);
    stage("External file and index changes refresh the active snapshot");

    delayNextRead = true; await click('[aria-label="刷新"]'); await wait(() => heldRead, "held project A response");
    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(b)})`); await ready(); await wait(hasCode("PROJECT_B_ONLY"), "project B snapshot");
    releaseRead?.(); await delay(400);
    assert.equal(await evaluate("document.querySelector('.git-review-panel').dataset.reviewProject"), b);
    assert.ok(await evaluate(hasCode("PROJECT_B_ONLY"))); assert.ok(!(await evaluate(hasCode("value65"))));
    assert.equal(registration.service.stats().subscriptions, 1);
    stage("Delayed project A response cannot overwrite project B");

    await evaluate("window.gitReviewFixture.setActive(false)"); await wait(() => registration.service.stats().subscriptions === 0, "hidden-tab subscription released");
    await wait("document.querySelectorAll('diffs-container').length === 0", "hidden-tab diff workers unmounted");
    await wait("window.gitReviewFixture.state().workers.active === 0", "native diff workers terminated");
    await write(b, "src/alpha.ts", "PROJECT_B_CHANGED_WHILE_HIDDEN\n");
    await evaluate("window.gitReviewFixture.setActive(true)"); await ready(); await wait(hasCode("PROJECT_B_CHANGED_WHILE_HIDDEN"), "refresh on return");
    assert.equal(await evaluate("window.gitReviewFixture.state().workers.active"), 2);
    await evaluate("window.gitReviewFixture.setHidden(true)"); await wait(() => registration.service.stats().subscriptions === 0, "outer drawer hiding releases subscription");
    await evaluate("window.gitReviewFixture.setHidden(false)"); await ready();
    // Reproduce Chromium's hidden-page frame suspension deterministically.
    await evaluate("window.gitReviewFixture.setPageHidden(true)");
    await wait(() => registration.service.stats().subscriptions === 0, "page hide releases without waiting for a frame");
    await wait("window.gitReviewFixture.state().workers.active === 0", "page-hide workers terminate");
    await evaluate("window.gitReviewFixture.setPageHidden(false)"); await ready();
    stage("Hidden tab/drawer and simulated page frame suspension release reads and workers");

    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(fresh)})`);
    await wait(`${state} === 'notRepository'`, "non-repository empty state"); await capture("git-not-repository");
    await git(fresh, ["init", "-qb", "main"]); await write(fresh, "first.txt", "fresh repository\n"); await ready();
    await wait(hasCode("fresh repository"), "repository initialization observed");
    await evaluate(`(async () => { const off = window.harness.git.onUpdate(u => { if (u.subscriptionId === 'denied') { window.deniedGit = u; off(); } }); await window.harness.git.subscribe({ subscriptionId: 'denied', projectRoot: ${JSON.stringify(directory)}, query: {kind:'unstaged'} }); })()`);
    await wait("window.deniedGit?.result?.kind === 'error'", "unopened project rejection");
    assert.equal(await evaluate("window.deniedGit.result.error.code"), "outsideProject");
    await evaluate("window.harness.git.unsubscribe('denied')");
    stage("Non-repository initialization and explicit opened-project authorization");

    await window.webContents.reload(); await ready();
    assert.equal(registration.service.stats().subscriptions, 1, "reload has one fresh subscription");
    assert.equal(network.length, 0, "all Git, code and worker resources are local");
    assert.deepEqual(errors, [], "renderer stays error free");
    await evaluate("window.gitReviewFixture.setColorScheme('dark'); window.gitReviewFixture.setLocale('en')"); await delay(200);
    window.setContentSize(620, 740); await capture("git-narrow-dark-en");
    window.close(); await wait(() => registration.service.stats().subscriptions === 0, "window close releases resources");
    stage("Renderer reload/window close cleanup and offline dark/English rendering");
    const result = { ok: true, stages, refreshMs, networkRequests: network, rendererErrors: errors, gitHead: head, rootCommit,
      serviceAfterClose: registration.service.stats(), environment: { platform: platform(), release: release(), cpu: cpus()[0]?.model, electron: process.versions.electron, node: process.versions.node, chromium: process.versions.chrome } };
    await fs.writeFile(path.join(artifacts, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, artifacts }, null, 2));
  } catch (error) {
    failed = true; console.error(error);
    if (!window.isDestroyed()) { await capture("failure").catch(() => {}); await fs.writeFile(path.join(artifacts, "failure.html"), await evaluate<string>("document.body.outerHTML")).catch(() => {}); }
    await fs.writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stages, errors, network, service: registration.service.stats(), renderer: window.isDestroyed() ? undefined : await evaluate("window.gitReviewFixture?.state()") }, null, 2));
  } finally {
    clearTimeout(watchdog); releaseRead?.(); registration.dispose(); if (!window.isDestroyed()) window.destroy();
    session.flushStorageData();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); app.exit(failed ? 1 : 0);
  }
}
smoke().catch((error) => { console.error(error); app.exit(1); });
