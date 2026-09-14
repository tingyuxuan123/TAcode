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
import { TurnSnapshotService } from "../src/main/git/turn-snapshot";

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
  const commitProject = path.join(directory, "commit-project"); const commitRemote = path.join(directory, "commit-remote.git");
  for (const root of [a, b, fresh, commitProject]) await fs.mkdir(root);
  const git = async (cwd: string, args: string[]) => (await exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_DEFAULT_HASH: "sha1",
  } })).stdout.trimEnd();
  const write = async (root: string, file: string, text: string | Buffer) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), text); };
  for (const root of [a, b]) { await git(root, ["init", "-qb", "main"]); await git(root, ["config", "user.name", "TACode fixture"]); await git(root, ["config", "user.email", "fixture@example.invalid"]); }
  await git(commitProject, ["init", "-qb", "main"]); await git(commitProject, ["config", "user.name", "TACode fixture"]); await git(commitProject, ["config", "user.email", "fixture@example.invalid"]);
  await write(commitProject, "source.txt", "base\n"); await git(commitProject, ["add", "source.txt"]); await git(commitProject, ["commit", "-qm", "base"]);
  await git(directory, ["init", "--bare", "-q", commitRemote]); await git(commitProject, ["remote", "add", "origin", commitRemote]);
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
  const allowed = new Set([a, b, fresh, commitProject]);
  await app.whenReady();
  const window = new BrowserWindow({ width: 836, height: 740, useContentSize: true, show: false,
    webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "git-review-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const session = window.webContents.session;
  let delayNextRead = false; let heldRead = false; let releaseRead: (() => void) | undefined;
  const turnService = new TurnSnapshotService({ root: path.join(profile, "review-turns"),
    resolveProject: async (root) => { if (!allowed.has(root)) throw new Error("Folder is not an opened project"); return root; },
    publish: (update) => { if (!window.isDestroyed()) window.webContents.send("git:turn", update); } });
  const registration = registerGitIpc({ host: () => window.webContents,
    recoveryRoot: path.join(profile, "git-recovery"), turns: turnService,
    resolveProject: async (root) => { if (!allowed.has(root)) throw new Error("Folder is not an opened project"); return root; },
    reader: (root) => {
      const reader = new GitReader(root, { turns: turnService });
      return { inspect: reader.inspect.bind(reader), branches: reader.branches.bind(reader), read: async (query, signal) => {
        const snapshot = await reader.read(query, signal);
        if (delayNextRead && root === await fs.realpath(a)) { delayNextRead = false; heldRead = true; await new Promise<void>((resolve) => { releaseRead = resolve; }); }
        return snapshot;
      } };
    },
  });
  let delayCommitPreview = false; let heldCommitToken: string | undefined; let releaseCommitPreview: (() => void) | undefined;
  const cancelledCommitTokens = new Set<string>();
  const prepareCommit = registration.commits.prepare.bind(registration.commits);
  registration.commits.prepare = async (...args) => {
    const preview = await prepareCommit(...args);
    if (delayCommitPreview) {
      delayCommitPreview = false; heldCommitToken = preview.token;
      await new Promise<void>((resolve) => { releaseCommitPreview = resolve; });
    }
    return preview;
  };
  const cancelCommit = registration.commits.cancel.bind(registration.commits);
  registration.commits.cancel = (owner, token) => { cancelledCommitTokens.add(token); cancelCommit(owner, token); };
  ipcMain.handle("app:get-locale", () => "zh"); ipcMain.handle("app:set-locale", () => {});
  const network: string[] = []; const errors: string[] = []; const stages: string[] = []; const refreshMs: number[] = [];
  let turnTimings: { files: number; additions: number; deletions: number; baselineMs: number; targetMs: number } | undefined;
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => { network.push(details.url); callback({ cancel: true }); });
  window.webContents.on("console-message", (event) => { if (event.level === "error") { errors.push(event.message); console.error("[renderer]", event.message); } });
  window.webContents.on("render-process-gone", (_event, details) => { errors.push(`renderer gone: ${details.reason}`); });
  const watchdog = setTimeout(() => { console.error("Git review smoke timed out"); app.exit(1); }, 120_000);
  const evaluate = <T = unknown>(text: string): Promise<T> => window.webContents.executeJavaScript(text);
  const wait = async (test: string | (() => boolean | Promise<boolean>), label: string, timeout = 10_000) => {
    const start = Date.now();
    while (!(typeof test === "string" ? await evaluate(test) : await test())) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`); await delay(40); }
  };
  const key = async (keyCode: string, modifiers: string[] = []) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers } as InputEvent);
    if (keyCode === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers } as InputEvent); await delay(60);
  };
  const click = async (selector: string, shadow = false) => {
    await wait(`(() => { const e = ${shadow ? "[...document.querySelectorAll('diffs-container')].map(e => e.shadowRoot?.querySelector(" + JSON.stringify(selector) + ")).find(Boolean)" : "document.querySelector(" + JSON.stringify(selector) + ")"}; return Boolean(e && !e.disabled); })()`, `enabled control: ${selector}`);
    const location = await evaluate<{ x: number; y: number }>(`(() => { const e = ${shadow ? "[...document.querySelectorAll('diffs-container')].map(e => e.shadowRoot?.querySelector(" + JSON.stringify(selector) + ")).find(Boolean)" : "document.querySelector(" + JSON.stringify(selector) + ")"}; if (!e) throw new Error('Missing element'); const r = e.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()`);
    window.webContents.sendInputEvent({ type: "mouseDown", ...location, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", ...location, button: "left", clickCount: 1 }); await delay(80);
  };
  const select = (selector: string, value: string) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const replaceInput = async (selector: string, value: string) => {
    await click(selector);
    await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select(); })()`);
    await window.webContents.insertText(value);
  };
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

    await select('.workbench-scope', "staged"); await wait(`document.querySelector('.workbench-scope')?.value === 'staged' && ${state} === 'ready' && ${hasCode("value5 = 500")}`, "staged comparison");
    assert.ok(!(await evaluate(hasCode("value65 = 650"))));
    await capture("git-staged");
    await select('.workbench-scope', "commit"); await wait(`document.querySelector('.workbench-scope')?.value === 'commit' && ${state} === 'ready' && ${hasCode("value10 = 1000")}`, "commit comparison");
    assert.equal(await evaluate("document.querySelector('.workbench-readonly')?.textContent"), "只读");
    await capture("git-commit");
    await replaceInput('#review-commit-ref', "does-not-exist"); await key("Enter");
    await wait(`${state} === 'error'`, "invalid reference error");
    assert.match(await evaluate<string>("document.querySelector('[role=\"alert\"]').textContent"), /找不到/);
    await capture("git-error");
    await replaceInput('#review-commit-ref', rootCommit); await key("Enter"); await ready();
    await wait(hasCode("value1 = 1"), "root commit against empty tree");
    await select('.workbench-scope', "branch");
    await wait(`${state} === 'repository'`, "branch choice before comparison");
    await select('[aria-label="基准分支"]', "refs/heads/base"); await ready();
    await wait(hasCode("value10 = 1000"), "merge-base to HEAD");
    assert.ok(!(await evaluate(hasCode("value65 = 650"))));
    await capture("git-branch");
    stage("Staged, commit, root commit, branch choice, merge base and reference-error recovery");

    await select('.workbench-scope', "unstaged"); await wait(`document.querySelector('.workbench-scope')?.value === 'unstaged' && ${state} === 'ready'`, "unstaged comparison after history"); await click('[data-tree-path="src/alpha.ts"]');
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
    const c = path.join(directory, "mutation-project"); await fs.mkdir(c); allowed.add(c);
    await git(c, ["init", "-qb", "main"]); await git(c, ["config", "user.name", "TACode fixture"]); await git(c, ["config", "user.email", "fixture@example.invalid"]);
    const original = source(Array.from({ length: 80 }, (_, index) => `export const item${index + 1} = ${index + 1};`));
    const firstEdit = original.replace("item3 = 3;", "item3 = 300;");
    const twoEdits = firstEdit.replace("item63 = 63;", "item63 = 6300;");
    const withUnstaged = twoEdits.replace("item33 = 33;", "item33 = 3300;");
    await write(c, "source.ts", original); await git(c, ["add", "--all"]); await git(c, ["commit", "-qm", "baseline"]); await write(c, "source.ts", twoEdits);
    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(c)})`); await wait(`${state} === 'ready' && document.querySelector('.git-review-panel')?.dataset.reviewProject === ${JSON.stringify(c)}`, "mutation project snapshot");
    const applied = () => wait("document.querySelector('[data-mutation-result=\"applied\"]') && document.querySelector('.git-review-panel').dataset.reviewState === 'ready'", "successful Git action and refreshed snapshot");
    const cIndex = () => git(c, ["show", ":source.ts"]);
    const cWorking = () => fs.readFile(path.join(c, "source.ts"), "utf8");
    await wait("document.querySelectorAll('[data-git-action=\"stage-hunk\"]').length === 2", "two real Git hunk action bars");
    await capture("git-hunk-actions");
    await click('[data-git-action="stage-hunk"]'); await applied();
    assert.equal(await cIndex(), firstEdit.trimEnd()); assert.equal(await cWorking(), twoEdits);
    await select('.workbench-scope', "staged"); await wait("document.querySelector('.workbench-scope')?.value === 'staged' && document.querySelectorAll('[data-git-action=\"unstage-hunk\"]').length > 0", "staged mutation actions");
    await click('[data-git-action="unstage-hunk"]'); await applied();
    assert.equal(await cIndex(), original.trimEnd()); assert.equal(await cWorking(), twoEdits);
    await select('.workbench-scope', "unstaged"); await wait("document.querySelector('.workbench-scope')?.value === 'unstaged' && document.querySelectorAll('[data-git-action=\"stage-file\"]').length > 0", "unstaged mutation actions");
    await click('[data-git-action="stage-file"]'); await applied();
    assert.equal(await cIndex(), twoEdits.trimEnd());
    stage("Native hunk and file actions change the real index and preserve the working copy");

    await write(c, "source.ts", withUnstaged);
    await select('.workbench-scope', "staged"); await wait(`document.querySelector('.workbench-scope')?.value === 'staged' && ${state} === 'ready' && document.querySelectorAll('[data-git-action="discard-hunk"]').length > 0`, "staged discard actions");
    await click('[data-git-action="discard-hunk"]');
    await wait("document.querySelector('dialog[open]')?.textContent.includes('仅还原选定的 1 个代码块')", "concrete hunk discard confirmation");
    assert.equal(await cIndex(), twoEdits.trimEnd()); assert.equal(await cWorking(), withUnstaged);
    await capture("git-discard-confirmation");
    await key("Escape"); await wait("!document.querySelector('dialog[open]')", "Escape cancels without mutation");
    assert.equal(await cIndex(), twoEdits.trimEnd());
    await click('[data-git-action="discard-hunk"]'); await wait("document.querySelector('dialog[open]')", "second confirmation");
    await click('dialog .is-destructive'); await applied();
    assert.equal(await cIndex(), original.replace("item63 = 63;", "item63 = 6300;").trimEnd());
    assert.equal(await cWorking(), withUnstaged.replace("item3 = 300;", "item3 = 3;"));
    await click('[aria-label="还原恢复点"]'); await wait("document.querySelector('.workbench-recovery-list button')", "durable recovery point visible");
    await capture("git-recovery-list");
    await click('.workbench-recovery-list button'); await wait("document.querySelector('dialog[open]')?.textContent.includes('恢复这次还原前的改动')", "recovery confirmation");
    await click('dialog .workbench-dialog-actions button:last-child');
    await wait("document.querySelector('.workbench-recovery-list')?.textContent.includes('已恢复')", "recovery succeeds through production IPC");
    await click('dialog .workbench-dialog-actions button:last-child');
    await wait("!document.querySelector('dialog[open]') && document.querySelectorAll('[data-git-action=\"discard-hunk\"]').length > 0", "staged actions after recovery");
    assert.equal(await cIndex(), twoEdits.trimEnd()); assert.equal(await cWorking(), withUnstaged);
    stage("Discard confirms before writing, preserves extra unstaged edits, and offers durable recovery");

    const overlap = withUnstaged.replace("item3 = 300;", "item3 = 333;"); await write(c, "source.ts", overlap);
    await wait("document.querySelectorAll('[data-git-action=\"discard-hunk\"]:not(:disabled)').length > 0", "discard action available after overlap edit");
    await click('[data-git-action="discard-hunk"]');
    await wait("document.querySelector('.workbench-operation-error')?.textContent.includes('补丁')", "overlapping staged edit is rejected");
    assert.equal(await evaluate("Boolean(document.querySelector('dialog[open]'))"), false);
    assert.equal(await cIndex(), twoEdits.trimEnd()); assert.equal(await cWorking(), overlap);
    await select('.workbench-scope', "unstaged"); await wait(`document.querySelector('.workbench-scope')?.value === 'unstaged' && ${state} === 'ready' && document.querySelectorAll('[data-git-action="stage-file"]').length > 0`, "unstaged actions after overlap");
    const lock = path.join(c, ".git/index.lock"); await fs.writeFile(lock, "another Git process");
    await click('[data-git-action="stage-file"]');
    await wait("document.querySelector('.workbench-operation-error')?.textContent.includes('占用')", "index lock failure shown");
    assert.equal(await fs.readFile(lock, "utf8"), "another Git process"); await fs.unlink(lock);
    await wait("document.querySelectorAll('[data-git-action=\"discard-file\"]:not(:disabled)').length > 0", "discard file action available");
    await click('[data-git-action="discard-file"]'); await wait("document.querySelector('dialog[open]')", "prepared file discard");
    const lateEdit = overlap + "// edited after confirmation opened\n"; await write(c, "source.ts", lateEdit);
    await click('dialog .is-destructive');
    await wait("document.querySelector('.workbench-operation-error')?.textContent.includes('已变化')", "stale confirmation rejected");
    assert.equal(await cWorking(), lateEdit); assert.equal(await cIndex(), twoEdits.trimEnd());
    await capture("git-stale-confirmation");
    stage("Overlapping patches, foreign index locks and edits made during confirmation preserve all changes");

    await write(c, "新增.bin", Buffer.from([0, 1, 255])); await click('[aria-label="刷新"]'); await ready();
    await click('[aria-label="暂存全部"]'); await applied();
    await select('.workbench-scope', "staged"); await ready(); await click('[aria-label="取消暂存全部"]'); await applied();
    assert.equal(await cIndex(), original.trimEnd()); assert.equal(await cWorking(), lateEdit);
    await select('.workbench-scope', "unstaged"); await ready(); await click('[aria-label="还原全部"]');
    await wait("document.querySelector('dialog[open]')?.textContent.includes('新增.bin')", "batch discard names every affected file");
    await click('dialog .is-destructive'); await applied();
    assert.equal(await cWorking(), original); await assert.rejects(fs.stat(path.join(c, "新增.bin")), { code: "ENOENT" });
    await window.webContents.reload(); await ready(); await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(c)})`); await ready();
    await click('[aria-label="还原恢复点"]'); await wait("document.querySelectorAll('.workbench-recovery-list > li').length === 2", "recovery history survives renderer reload");
    await capture("git-recovery-after-reload"); await click('dialog .workbench-dialog-actions button:last-child');
    stage("Batch stage, unstage and discard work with binary additions; recovery history survives reload");

    await evaluate("window.gitReviewFixture.setColorScheme('light'); window.gitReviewFixture.setLocale('zh')");
    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(commitProject)})`); await ready();
    await write(commitProject, "source.txt", "commit-only\n"); await git(commitProject, ["add", "source.txt"]); await click("[aria-label=\"刷新\"]"); await ready();
    await click("[aria-label=\"提交或推送\"]"); await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog[open]'))", "commit dialog opens with staged content");
    const commitDialogText = () => evaluate<string>("document.querySelector('dialog.workbench-commit-dialog')?.textContent ?? ''");
    await wait(async () => (await commitDialogText()).includes("暂存 1 个文件") && (await commitDialogText()).includes("source.txt"), "staged summary and path are visible in commit dialog");
    await capture("git-commit-dialog-form-zh");
    await replaceInput("dialog.workbench-commit-dialog textarea", "commit-only"); await click("dialog.workbench-commit-dialog form button[type=\"submit\"]");
    await wait("document.querySelector('dialog.workbench-commit-dialog .workbench-commit-message')?.textContent === 'commit-only'", "commit message preview");
    await capture("git-commit-dialog-preview-zh");
    await click("dialog.workbench-commit-dialog .is-destructive"); await wait("document.querySelector('[data-commit-result=\"applied\"]')", "commit-only result");
    assert.equal(await git(commitProject, ["log", "-1", "--format=%s"]), "commit-only");
    stage("Commit dialog shows real staged paths and message; commit-only preserves the local Git result");

    await write(commitProject, "source.txt", "commit-and-push\n"); await git(commitProject, ["add", "source.txt"]); await click("[aria-label=\"刷新\"]"); await ready();
    await click("[aria-label=\"提交或推送\"]"); await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog[open]'))", "commit-and-push dialog opens without upstream");
    await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog form select'))", "commit-and-push form loads");
    await select("dialog.workbench-commit-dialog select", "commitAndPush"); await replaceInput("dialog.workbench-commit-dialog textarea", "publish locally");
    await click("dialog.workbench-commit-dialog form button[type=\"submit\"]"); await wait("document.querySelector('dialog.workbench-commit-dialog .workbench-commit-message')?.textContent === 'publish locally'", "commit-and-push preview");
    await wait(async () => (await commitDialogText()).includes("目标：origin / main"), "remote and branch target are visible");
    await click("dialog.workbench-commit-dialog .is-destructive"); await wait("document.querySelector('[data-commit-result=\"applied\"]')", "commit-and-push result"); await ready();
    assert.equal(await git(commitProject, ["rev-parse", "--abbrev-ref", "@{upstream}"]), "origin/main");
    assert.equal(await git(commitRemote, ["rev-parse", "refs/heads/main"]), await git(commitProject, ["rev-parse", "HEAD"]));
    stage("Without an upstream, the dialog accepts an explicit remote and branch and completes commit plus push");

    await click("[aria-label=\"提交或推送\"]"); await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog[open]'))", "push-only dialog opens");
    await wait(async () => (await commitDialogText()).includes("仅推送"), "push-only action is available with no staged changes");
    await click("dialog.workbench-commit-dialog form button[type=\"submit\"]"); await wait("document.querySelector('dialog.workbench-commit-dialog')?.textContent.includes('确认推送当前分支？')", "push preview");
    await evaluate("document.querySelector('dialog.workbench-commit-dialog .is-destructive')?.click()");
    await wait("Boolean(document.querySelector('[data-commit-result=\"applied\"]') || document.querySelector('dialog.workbench-commit-dialog .workbench-operation-error'))", "push-only result");
    if (await evaluate<boolean>("Boolean(document.querySelector('dialog.workbench-commit-dialog .workbench-operation-error'))")) throw new Error(`Push-only failed: ${await commitDialogText()}`);
    stage("Push-only handles an already configured upstream without requiring a commit message");

    await git(commitProject, ["branch", "release", "HEAD~1"]);
    const oldRelease = await git(commitProject, ["rev-parse", "release"]); await git(commitProject, ["push", "-q", "origin", "release"]);
    await click("[aria-label=\"提交或推送\"]"); await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog form input'))", "alternate push target form");
    await replaceInput("dialog.workbench-commit-dialog form input", " release ");
    await click("dialog.workbench-commit-dialog form button[type=\"submit\"]");
    await wait(async () => (await commitDialogText()).includes("目标：origin / release"), "normalized alternate branch is previewed");
    await click("dialog.workbench-commit-dialog .is-destructive"); await wait("document.querySelector('[data-commit-result=\"applied\"]')", "alternate target push result");
    assert.equal(await git(commitRemote, ["rev-parse", "refs/heads/release"]), await git(commitProject, ["rev-parse", "HEAD"]));
    assert.equal(await git(commitProject, ["rev-parse", "release"]), oldRelease);
    await git(commitProject, ["branch", "--set-upstream-to=origin/main"]); await click("[aria-label=\"刷新\"]"); await ready();
    stage("An alternate remote branch receives current HEAD even when a stale local branch has the same name");

    const commitHook = path.join(commitProject, ".git", "hooks", "pre-commit");
    await fs.writeFile(commitHook, "#!/bin/sh\necho smoke hook blocked >&2\nexit 1\n", { mode: 0o755 });
    await write(commitProject, "source.txt", "hook-rejected\n"); await git(commitProject, ["add", "source.txt"]); await click("[aria-label=\"刷新\"]"); await ready();
    await click("[aria-label=\"提交或推送\"]"); await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog[open]'))", "hook failure dialog opens");
    await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog form select'))", "hook failure form loads");
    await select("dialog.workbench-commit-dialog select", "commit"); await replaceInput("dialog.workbench-commit-dialog textarea", "hook rejection"); await click("dialog.workbench-commit-dialog form button[type=\"submit\"]");
    await wait("document.querySelector('dialog.workbench-commit-dialog .workbench-commit-message')?.textContent === 'hook rejection'", "hook rejection preview");
    await click("dialog.workbench-commit-dialog .is-destructive"); await wait("document.querySelector('dialog.workbench-commit-dialog .workbench-operation-error')?.textContent.includes('hook')", "hook rejection is visible");
    assert.equal(await git(commitProject, ["log", "-1", "--format=%s"]), "publish locally");
    await fs.rm(commitHook); await click("dialog.workbench-commit-dialog .workbench-dialog-actions button:first-child"); await wait("!document.querySelector('dialog.workbench-commit-dialog[open]')", "close hook error dialog");
    stage("Commit hook rejection is classified in the dialog and does not create a commit");

    const otherRemote = path.join(directory, "commit-remote-other"); await git(directory, ["clone", "-q", "--branch", "main", commitRemote, otherRemote]);
    await git(otherRemote, ["config", "user.name", "Other fixture"]); await git(otherRemote, ["config", "user.email", "other@example.invalid"]);
    await write(otherRemote, "remote.txt", "remote wins\n"); await git(otherRemote, ["add", "remote.txt"]); await git(otherRemote, ["commit", "-qm", "remote change"]); await git(otherRemote, ["push", "-q"]);
    assert.notEqual(await git(commitRemote, ["rev-parse", "refs/heads/main"]), await git(commitProject, ["rev-parse", "HEAD"]), "remote fixture is ahead before rejection test");
    await fs.rm(commitHook, { force: true });
    await write(commitProject, "source.txt", "push-rejected\n"); await git(commitProject, ["add", "source.txt"]); await click("[aria-label=\"刷新\"]"); await ready();
    await click("[aria-label=\"提交或推送\"]"); await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog[open]'))", "push rejection dialog opens");
    await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog form select'))", "push rejection form loads");
    await select("dialog.workbench-commit-dialog select", "commitAndPush"); await replaceInput("dialog.workbench-commit-dialog textarea", "push rejection"); await click("dialog.workbench-commit-dialog form button[type=\"submit\"]");
    await wait("document.querySelector('dialog.workbench-commit-dialog .workbench-commit-message')?.textContent === 'push rejection'", "push rejection preview");
    await click("dialog.workbench-commit-dialog .is-destructive"); await wait("document.querySelector('dialog.workbench-commit-dialog .workbench-operation-error')?.textContent.includes('远端拒绝')", "non-fast-forward rejection is visible");
    await wait("document.querySelector('dialog.workbench-commit-dialog .workbench-operation-error')?.textContent.includes('提交已创建')", "partial local commit result is visible");
    await capture("git-commit-dialog-partial-error-zh");
    assert.equal(await git(commitProject, ["log", "-1", "--format=%s"]), "push rejection");
    await click("dialog.workbench-commit-dialog .workbench-dialog-actions button:first-child"); await wait("!document.querySelector('dialog.workbench-commit-dialog[open]')", "close push rejection dialog");
    stage("Non-fast-forward push rejection keeps the local commit and exposes the partial result");

    await fs.writeFile(commitHook, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    await write(commitProject, "source.txt", "cancelled\n"); await git(commitProject, ["add", "source.txt"]); await click("[aria-label=\"刷新\"]"); await ready();
    await click("[aria-label=\"提交或推送\"]"); await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog[open]'))", "cancel dialog opens");
    await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog form select'))", "cancel form loads");
    await select("dialog.workbench-commit-dialog select", "commit"); await replaceInput("dialog.workbench-commit-dialog textarea", "cancelled commit"); await click("dialog.workbench-commit-dialog form button[type=\"submit\"]");
    await wait("document.querySelector('dialog.workbench-commit-dialog .workbench-commit-message')?.textContent === 'cancelled commit'", "cancel preview");
    await click("dialog.workbench-commit-dialog .is-destructive"); await wait("document.querySelector('dialog.workbench-commit-dialog .is-destructive')?.textContent.includes('正在执行')", "in-flight commit is visible");
    await click("dialog.workbench-commit-dialog .workbench-dialog-actions button:first-child"); await wait("document.querySelector('dialog.workbench-commit-dialog .workbench-operation-error')?.textContent.includes('Git 操作已取消')", "cancelled commit result is visible");
    assert.equal(await git(commitProject, ["log", "-1", "--format=%s"]), "push rejection");
    await fs.rm(commitHook, { force: true }); await click("dialog.workbench-commit-dialog .workbench-dialog-actions button:first-child"); await wait("!document.querySelector('dialog.workbench-commit-dialog[open]')", "close cancelled commit dialog");
    stage("An in-flight commit can be cancelled from the confirmation dialog and leaves the index unchanged");

    await click("[aria-label=\"提交或推送\"]"); await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog form select'))", "delayed preparation form");
    await select("dialog.workbench-commit-dialog select", "commit"); await replaceInput("dialog.workbench-commit-dialog textarea", "cancel late preview");
    delayCommitPreview = true;
    await click("dialog.workbench-commit-dialog form button[type=\"submit\"]"); await wait(() => Boolean(heldCommitToken), "prepared token awaits renderer response");
    await click("dialog.workbench-commit-dialog form .workbench-dialog-actions button:first-child");
    await wait("!document.querySelector('dialog.workbench-commit-dialog[open]')", "close during preparation");
    releaseCommitPreview?.(); await wait(() => cancelledCommitTokens.has(heldCommitToken!), "late preview token is cancelled");
    assert.equal((await registration.commits.apply(window.webContents.id, heldCommitToken!)).kind, "error");
    assert.equal(await git(commitProject, ["log", "-1", "--format=%s"]), "push rejection");
    assert.equal(await evaluate("Boolean(document.querySelector('dialog.workbench-commit-dialog[open]'))"), false);
    stage("Closing during preparation cancels a late confirmation token without reopening the dialog or writing Git");

    const postCommitHook = path.join(commitProject, ".git", "hooks", "post-commit");
    await fs.writeFile(postCommitHook, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    await click("[aria-label=\"提交或推送\"]"); await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog form select'))", "post-commit cancellation form");
    await select("dialog.workbench-commit-dialog select", "commit"); await replaceInput("dialog.workbench-commit-dialog textarea", "cancel after HEAD changed");
    await click("dialog.workbench-commit-dialog form button[type=\"submit\"]"); await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog .workbench-commit-message'))", "post-commit cancellation preview");
    await click("dialog.workbench-commit-dialog .is-destructive");
    await wait(async () => await git(commitProject, ["log", "-1", "--format=%s"]) === "cancel after HEAD changed", "HEAD changes while post-commit hook waits");
    await click("dialog.workbench-commit-dialog .workbench-dialog-actions button:first-child");
    await wait("document.querySelector('dialog.workbench-commit-dialog .workbench-operation-error')?.textContent.includes('Git 操作已取消')", "post-commit cancellation result");
    await wait("document.querySelector('dialog.workbench-commit-dialog .workbench-operation-error')?.textContent.includes('提交已创建')", "completed local commit remains visible after cancellation");
    assert.equal(await git(commitProject, ["diff", "--cached", "--name-only"]), "");
    await fs.rm(postCommitHook); await click("dialog.workbench-commit-dialog form .workbench-dialog-actions button:first-child");
    stage("Cancelling a post-commit hook retains HEAD and reports the completed local commit");

    await evaluate("window.gitReviewFixture.setColorScheme('dark'); window.gitReviewFixture.setLocale('en')"); window.setContentSize(420, 740);
    await click("[aria-label=\"Commit or push\"]"); await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog form input'))", "narrow English commit form");
    await select("dialog.workbench-commit-dialog select", "commitAndPush"); await replaceInput("dialog.workbench-commit-dialog textarea", "Update repository metadata");
    await capture("git-commit-dialog-narrow-dark-en");
    assert.equal(await evaluate("(() => { const d = document.querySelector('dialog.workbench-commit-dialog'); return d.scrollWidth <= d.clientWidth && [...d.querySelectorAll('input, textarea, select, button')].every(e => { const r = e.getBoundingClientRect(); const p = d.getBoundingClientRect(); return r.left >= p.left && r.right <= p.right; }); })()"), true, "commit controls fit a narrow window");
    await click("dialog.workbench-commit-dialog form .workbench-dialog-actions button:first-child"); window.setContentSize(836, 740);

    const scopedProject = path.join(commitProject, "scoped"); await fs.mkdir(scopedProject); allowed.add(scopedProject);
    await write(scopedProject, "inside.txt", "inside project\n"); await write(commitProject, "source.txt", "outside project\n"); await git(commitProject, ["add", "--all"]);
    const beforeScopedCommit = await git(commitProject, ["rev-parse", "HEAD"]);
    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(scopedProject)})`); await ready();
    await click("[aria-label=\"Commit or push\"]"); await wait("Boolean(document.querySelector('dialog.workbench-commit-dialog form select'))", "subproject commit form");
    await select("dialog.workbench-commit-dialog select", "commit"); await replaceInput("dialog.workbench-commit-dialog textarea", "Only scoped content");
    await click("dialog.workbench-commit-dialog form button[type=\"submit\"]");
    await wait("document.querySelector('dialog.workbench-commit-dialog .workbench-operation-error')?.textContent.includes('repository root')", "staged changes outside subproject block commit");
    assert.equal(await git(commitProject, ["rev-parse", "HEAD"]), beforeScopedCommit);
    assert.equal(await git(commitProject, ["diff", "--cached", "--name-only"]), "scoped/inside.txt\nsource.txt");
    await click("dialog.workbench-commit-dialog form .workbench-dialog-actions button:first-child");
    stage("A subproject commit refuses staged changes outside its preview and retains the complete index");

    // FR-11：最近一轮审查。真实 turn 边界（agent_start → 工具写入 → agent_settled）产生不可变快照。
    await evaluate("window.gitReviewFixture.setColorScheme('light'); window.gitReviewFixture.setLocale('zh')");
    const turnRoot = path.join(directory, "turn-project"); await fs.mkdir(turnRoot); allowed.add(turnRoot);
    await git(turnRoot, ["init", "-qb", "main"]); await git(turnRoot, ["config", "user.name", "TACode fixture"]); await git(turnRoot, ["config", "user.email", "fixture@example.invalid"]);
    await write(turnRoot, "app.ts", "export const version = 1;\n"); await write(turnRoot, "keep.txt", "keep me\n");
    await git(turnRoot, ["add", "--all"]); await git(turnRoot, ["commit", "-qm", "base"]);
    await write(turnRoot, "before.txt", "changed before the turn\n");
    const turnSession = path.join(directory, "turn-session.jsonl");
    const turnEvents = (event: Record<string, unknown>) => turnService.observe({ __runtimeId: "turn-runtime", __sessionId: turnSession, ...event }, turnRoot);
    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(turnRoot)})`); await ready();
    await select('.workbench-scope', "unstaged"); await wait(`${state} === 'ready' && ${hasCode("changed before the turn")}`, "pre-turn live changes");

    turnEvents({ type: "agent_start" }); await turnService.idle();
    await write(turnRoot, "app.ts", "export const version = 2;\n");
    await write(turnRoot, "added.txt", "added by the turn\n");
    await fs.rm(path.join(turnRoot, "keep.txt"));
    turnEvents({ type: "tool_execution_start", toolCallId: "call-watch", toolName: "exec_command", args: { cmd: "pnpm dev --watch" } });
    turnEvents({ type: "tool_execution_end", toolCallId: "call-watch", toolName: "exec_command", result: { details: { running: true, processId: "dev-42" } } });
    turnEvents({ type: "agent_settled" }); await turnService.idle();
    await wait("Boolean(document.querySelector('.workbench-scope option[value=\"lastTurn\"]:not([disabled])'))", "last turn scope enabled", 5_000);
    await select('.workbench-scope', "lastTurn");
    await wait(`${state} === 'ready' && ${hasCode("version = 2")}`, "recorded turn comparison");
    assert.equal(await evaluate("document.querySelector('.workbench-scope').value"), "lastTurn");
    assert.ok(!(await evaluate(hasCode("changed before the turn"))), "pre-turn changes are not part of the turn");
    assert.equal(await evaluate("Boolean(document.querySelector('[data-tree-path=\"added.txt\"]'))"), true);
    assert.equal(await evaluate("Boolean(document.querySelector('[data-tree-path=\"keep.txt\"]'))"), true);
    assert.equal(await evaluate("Boolean(document.querySelector('[data-tree-path=\"before.txt\"]'))"), false, "files the turn did not touch stay out of the recorded range");
    assert.equal(await evaluate("document.querySelector('.workbench-readonly')?.textContent"), "只读");
    const turnSummary = await evaluate<string>("document.querySelector('[data-turn-snapshot]')?.textContent ?? ''");
    assert.match(turnSummary, /本轮快照 · 3 个文件/);
    assert.equal(await evaluate("document.querySelector('[data-turn-snapshot]')?.dataset.turnSnapshot?.length"), 64);
    assert.match(await evaluate<string>("document.querySelector('.workbench-turn-note')?.textContent ?? ''"), /pnpm dev --watch/);
    const turnRecord = await turnService.latest(turnRoot);
    assert.equal(turnRecord.kind, "turn");
    if (turnRecord.kind === "turn") {
      turnTimings = { files: turnRecord.snapshot.files, additions: turnRecord.snapshot.additions, deletions: turnRecord.snapshot.deletions,
        baselineMs: Math.round(turnRecord.snapshot.baselineMs), targetMs: Math.round(turnRecord.snapshot.targetMs) };
      assert.ok(turnRecord.snapshot.targetTree.length >= 40 && turnRecord.snapshot.baseTree !== turnRecord.snapshot.targetTree);
    }
    await capture("git-last-turn-zh");
    stage("A settled turn records only its own immutable file changes and marks unfinished commands");

    await write(turnRoot, "later.txt", "written after the turn\n");
    await select('.workbench-scope', "unstaged"); await wait(`${state} === 'ready' && ${hasCode("written after the turn")}`, "later changes appear in live Git");
    await select('.workbench-scope', "lastTurn"); await wait(`${state} === 'ready' && ${hasCode("version = 2")}`, "recorded turn restored");
    assert.ok(!(await evaluate(hasCode("written after the turn"))));
    assert.equal(await evaluate("Boolean(document.querySelector('[data-tree-path=\"later.txt\"]'))"), false, "later changes never rewrite the recorded turn");
    assert.equal(await evaluate("Boolean(document.querySelector('[data-tree-path=\"added.txt\"]'))"), true);
    stage("Later disk changes enter live Git without rewriting the recorded turn");

    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(b)})`); await ready();
    await select('.workbench-scope', "lastTurn");
    await wait("document.querySelector('.git-review-panel')?.dataset.turnState === 'missing'", "missing snapshot notice");
    const missingNotice = await evaluate<string>("document.querySelector('[data-turn-notice=\"missing\"]')?.textContent ?? ''");
    assert.match(missingNotice, /没有记录到最近一轮的快照/);
    assert.match(missingNotice, /未暂存\/已暂存范围仍显示当前改动/);
    assert.equal(await evaluate("document.querySelectorAll('diffs-container').length"), 0, "missing history never falls back to current content");
    await capture("git-last-turn-missing-zh");
    stage("A project without a recorded turn says so instead of showing current content");

    const expiredRoot = path.join(directory, "expired-project"); await fs.mkdir(expiredRoot); allowed.add(expiredRoot);
    await git(expiredRoot, ["init", "-qb", "main"]); await git(expiredRoot, ["config", "user.name", "TACode fixture"]); await git(expiredRoot, ["config", "user.email", "fixture@example.invalid"]);
    await write(expiredRoot, "value.txt", "one\n"); await git(expiredRoot, ["add", "--all"]); await git(expiredRoot, ["commit", "-qm", "base"]);
    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(expiredRoot)})`); await ready();
    turnService.observe({ type: "agent_start", __runtimeId: "turn-expired", __sessionId: turnSession }, expiredRoot); await turnService.idle();
    await write(expiredRoot, "value.txt", "two\n");
    turnService.observe({ type: "agent_settled", __runtimeId: "turn-expired", __sessionId: turnSession }, expiredRoot); await turnService.idle();
    await select('.workbench-scope', "lastTurn"); await wait(`${state} === 'ready' && ${hasCode("two")}`, "recorded turn before collection");
    await fs.rm(path.join(expiredRoot, ".git", "objects"), { recursive: true, force: true });
    await git(expiredRoot, ["init", "-qb", "main"]);
    await click('[aria-label="刷新"]');
    await wait("document.querySelector('.git-review-panel')?.dataset.turnState === 'expired'", "collected objects reported as expired");
    assert.match(await evaluate<string>("document.querySelector('[data-turn-notice=\"expired\"]')?.textContent ?? ''"), /已被回收/);
    assert.equal(await evaluate("document.querySelectorAll('diffs-container').length"), 0);
    stage("Collected snapshot objects are reported as expired, never as current content");

    await evaluate("window.gitReviewFixture.setLocale('en')");

    // Keep actual text changes visible for the narrow dark-theme artifact.
    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(c)})`); await ready();
    await write(c, "source.ts", twoEdits); await click('[aria-label="Refresh"]'); await ready(); await wait(hasCode("item63 = 6300"), "final dark view has real source changes");
    assert.equal(network.length, 0, "all Git, code and worker resources are local");
    assert.deepEqual(errors, [], "renderer stays error free");
    await evaluate("window.gitReviewFixture.setColorScheme('dark'); window.gitReviewFixture.setLocale('en')"); await delay(200);
    window.setContentSize(620, 740); await capture("git-narrow-dark-en");
    window.close(); await wait(() => registration.service.stats().subscriptions === 0, "window close releases resources");
    stage("Renderer reload/window close cleanup and offline dark/English rendering");
    const result = { ok: true, stages, refreshMs, turnTimings, networkRequests: network, rendererErrors: errors, gitHead: head, rootCommit,
      serviceAfterClose: registration.service.stats(), environment: { platform: platform(), release: release(), cpu: cpus()[0]?.model, electron: process.versions.electron, node: process.versions.node, chromium: process.versions.chrome } };
    await fs.writeFile(path.join(artifacts, "result.json"), JSON.stringify(result, null, 2));
    if (process.env.TACODE_GIT_REVIEW_REPORT) await fs.writeFile(path.resolve(process.env.TACODE_GIT_REVIEW_REPORT), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, artifacts }, null, 2));
  } catch (error) {
    failed = true; console.error(error);
    if (!window.isDestroyed()) { await capture("failure").catch(() => {}); await fs.writeFile(path.join(artifacts, "failure.html"), await evaluate<string>("document.body.outerHTML")).catch(() => {}); }
    await fs.writeFile(path.join(artifacts, "failure.json"), JSON.stringify({ error: String(error), stages, errors, network, service: registration.service.stats(), renderer: window.isDestroyed() ? undefined : await evaluate("window.gitReviewFixture?.state()") }, null, 2));
  } finally {
    clearTimeout(watchdog); releaseRead?.(); releaseCommitPreview?.(); registration.dispose(); await registration.idle(); if (!window.isDestroyed()) window.destroy();
    session.flushStorageData();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); app.exit(failed ? 1 : 0);
  }
}
smoke().catch((error) => { console.error(error); app.exit(1); });
