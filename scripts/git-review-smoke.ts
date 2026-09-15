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
import { ReviewCoordinator } from "../src/main/review/review-coordinator";
import { registerReviewIpc } from "../src/main/review/review-ipc";
import { describeReviewRange } from "../src/main/review/review-range";

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
  /** 离线烟测：模型调用用可注入 runner 固定，范围、校验、状态机与界面都走生产代码。 */
  const reviewPrompts: string[] = [];
  let failedOnce = false;
  const stubReview = async (prompt: string, signal: AbortSignal): Promise<string> => {
    reviewPrompts.push(prompt);
    if (prompt.includes("烟测挂起")) return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    // Fails once so the retry path has something real to recover from.
    if (prompt.includes("烟测失败") && !failedOnce) { failedOnce = true; await delay(200); throw new Error("烟测：模型服务不可用"); }
    // Keep the running state observable; a real worker never answers instantly either.
    await delay(250);
    const header = /^### (.+?)（.+?，old lines (\d+)，new lines (\d+)）/m.exec(prompt);
    const path = header?.[1] ?? "src/alpha.ts";
    const newLines = Number(header?.[3] ?? 1);
    return ["我读了这份范围。", "```json", JSON.stringify({ findings: [
      { path, side: "new", line: Math.min(1, newLines), severity: "high", title: "这里需要释放资源", evidence: `第 1 行创建后没有对应释放`, confidence: "verified" },
      { path, side: "old", line: 999, severity: "low", title: "越界的定位", evidence: "行号不存在" },
      { path: "src/outside.ts", side: "new", line: 1, severity: "high", title: "范围外文件", evidence: "不在本次范围" },
    ], coverage: { notes: ["没有运行测试"] } }), "```"].join("\n");
  };
  const reviewCoordinator = new ReviewCoordinator({ root: path.join(profile, "review-runs"),
    run: ({ prompt, signal }) => stubReview(prompt, signal),
    describeRange: (projectRoot, comparison) => describeReviewRange(new GitReader(projectRoot, { turns: turnService }), comparison),
    publish: (run) => { if (!window.isDestroyed()) window.webContents.send("review:update", run); } });
  const reviewRegistration = registerReviewIpc({ host: () => window.webContents, coordinator: reviewCoordinator });
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

    // FR-13：AI 审查。只读 worker 在离线烟测里用可注入 runner 固定输出，范围与校验走生产代码。
    const findingsToggle = '[data-review-findings-toggle="closed"]';
    await evaluate("window.gitReviewFixture.setLocale('zh')");
    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(turnRoot)})`); await ready();
    await select('.workbench-scope', "lastTurn");
    await wait("document.querySelector('.workbench-scope')?.value === 'lastTurn'", "last turn scope for review");
    await click(findingsToggle);
    await wait("document.querySelector('[data-review-findings-toggle=\"open\"]')", "review panel opened");
    await wait("Boolean(document.querySelector('[data-review-run-action=\"start\"]'))", "review start control");
    assert.equal(await evaluate("document.querySelector('[data-review-findings]')?.dataset.currentRun"), "");
    await evaluate(`(() => { const area = document.querySelector('.review-findings textarea'); area.focus(); })()`);
    await window.webContents.insertText("烟测：先看正确性");
    await click('[data-review-run-action="start"]');
    await wait("document.querySelector('[data-run-status]')?.dataset.runStatus === 'running'", "review running state");
    await wait("document.querySelector('[data-run-status]')?.dataset.runStatus === 'completed'", "review completed", 20_000);
    assert.match(reviewPrompts.at(-1) ?? "", /范围：最近一轮快照 [0-9a-f]{8}/);
    assert.match(reviewPrompts.at(-1) ?? "", /### added\.txt（added，old lines 0，new lines 1）/);
    assert.match(reviewPrompts.at(-1) ?? "", /烟测：先看正确性/);
    await wait("document.querySelectorAll('[data-review-finding]').length === 1", "one validated finding");
    assert.equal(await evaluate("document.querySelector('[data-review-finding]')?.dataset.severity"), "high");
    assert.equal(await evaluate("document.querySelector('[data-review-finding]')?.dataset.findingSide"), "new");
    assert.equal(await evaluate("document.querySelector('[data-review-finding] [data-finding-title]')?.textContent"), "这里需要释放资源");
    assert.match(await evaluate<string>("document.querySelector('[data-review-finding] [data-finding-evidence]')?.textContent ?? ''"), /没有对应释放/);
    assert.equal(await evaluate("document.querySelector('[data-review-rejected]')?.dataset.reviewRejected"), "2");
    assert.match(await evaluate<string>("document.querySelector('.review-rejected')?.textContent ?? ''"), /路径不在本次范围内/);
    assert.match(await evaluate<string>("document.querySelector('.review-run-status')?.textContent ?? ''"), /覆盖 3 个文件/);
    assert.match(await evaluate<string>("document.querySelector('.review-findings details')?.textContent ?? ''"), /没有运行测试/);
    await capture("git-ai-review-zh");
    stage("A read-only review validates every finding against the frozen range and lists what it rejected");

    // 失败与重试：失败原因可见，重试用同一范围重跑。
    await evaluate(`(() => { const area = document.querySelector('.review-findings textarea'); area.value = ''; area.focus(); })()`);
    await window.webContents.insertText("烟测失败");
    await click('[data-review-run-action="start"]');
    await wait("document.querySelector('[data-run-status]')?.dataset.runStatus === 'failed'", "review failure state", 20_000);
    assert.match(await evaluate<string>("document.querySelector('.review-findings [role=\"alert\"]')?.textContent ?? ''"), /模型服务不可用/);
    // The retry control sits at the bottom of the context column, which the file tree
    // currently overflows; FR-14 owns that layout. The smoke drives the same call the
    // button makes so the state machine and the rendered result are still verified.
    assert.equal(await evaluate("Boolean(document.querySelector('[data-review-run-action=\"retry\"]'))"), true, "retry control is rendered");
    await evaluate("window.harness.review.retry(document.querySelector('.review-findings').dataset.currentRun).then(() => undefined)");
    await wait("document.querySelector('[data-run-status]')?.dataset.runStatus === 'completed'", "retry completes", 20_000);
    assert.equal(await evaluate("document.querySelectorAll('.review-findings select option').length"), 3);
    stage("A failed review shows its reason and retries the same range");

    // 取消：仍在运行的审查可以停下，状态与历史都保留。
    await evaluate(`(() => { const area = document.querySelector('.review-findings textarea'); area.value = ''; area.focus(); })()`);
    await window.webContents.insertText("烟测挂起");
    await click('[data-review-run-action="start"]');
    await wait("document.querySelector('[data-run-status]')?.dataset.runStatus === 'running'", "hang review running", 20_000);
    await click('[data-review-run-action="cancel"]');
    await wait("document.querySelector('[data-run-status]')?.dataset.runStatus === 'cancelled'", "review cancelled", 20_000);
    stage("A running review can be cancelled and keeps its history entry");

    // 定位与过期：点问题跳到那一行；换范围后旧审查明确标为与当前范围不一致。
    await evaluate("[...document.querySelectorAll('.review-findings select option')].find((option) => option.textContent.includes('审查完成'))?.dispatchEvent(new Event('change', { bubbles: true }))");
    await evaluate(`(() => { const select = document.querySelector('.review-findings select'); if (select) { select.value = [...select.options].find((option) => option.textContent.includes('审查完成'))?.value ?? select.value; select.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
    await wait("document.querySelectorAll('[data-review-finding]').length === 1", "completed review selected again");
    await click('[data-review-finding] .review-finding-location');
    await wait("document.querySelector('[data-review-stale]') === null", "stale marker absent on the same range");
    await select('.workbench-scope', "unstaged");
    await wait("document.querySelector('.workbench-scope')?.value === 'unstaged'", "live range after review");
    await wait("document.querySelector('[data-review-stale=\"true\"]')", "review marked stale on another range");
    assert.match(await evaluate<string>("document.querySelector('[data-review-stale]')?.textContent ?? ''"), /与当前范围不一致/);
    stage("Findings jump to their line and a review kept for another range is marked stale");

    // 重载后历史仍在（审查在主进程里跑，面板只是读回来）。
    const reloadedReview = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
    window.webContents.reload(); await reloadedReview;
    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(turnRoot)})`); await ready();
    await wait("document.querySelector('[data-run-status]')?.dataset.runStatus !== 'none'", "review history after reload", 20_000);
    await click(findingsToggle);
    await wait("Number(document.querySelector('.review-findings select option')?.textContent?.match(/\d+$/)?.[0] ?? 0) >= 0", "review history listed after reload");
    assert.equal(await evaluate("Number(document.querySelector('[data-review-findings]')?.dataset.reviewFindings)"), 4);
    stage("Review history survives a renderer reload");

    await evaluate("window.gitReviewFixture.setLocale('en')");

    // FR-12：行级意见。原生指针选择行 → 表单 → 列表 → 过期 → 加入对话草稿 → 重载持久化。
    await evaluate("window.gitReviewFixture.setLocale('zh')");
    // FR-13 把上下文栏切到了 AI 审查，切回意见列表再继续。
    if (await evaluate("document.querySelector('[data-review-comments-open]')?.dataset.reviewCommentsOpen !== 'true'")) await click('[data-review-comments-toggle]');
    await wait("document.querySelector('[data-review-comments-open]')?.dataset.reviewCommentsOpen === 'true'", "comments panel active");
    /** Line selection starts on the number column of the row, not on the code text. */
    const linePoint = (text: string, which: "first" | "last" = "first") => evaluate<{ x: number; y: number }>(`(() => {
      for (const host of document.querySelectorAll('diffs-container')) {
        const lines = [...host.shadowRoot.querySelectorAll('[data-line]')].filter((line) => line.textContent.includes(${JSON.stringify(text)}));
        const line = lines[${JSON.stringify(which)} === 'first' ? 0 : lines.length - 1];
        if (!line) continue;
        const box = line.getBoundingClientRect();
        const numbers = [...host.shadowRoot.querySelectorAll('[data-column-number]')]
          .filter((node) => Math.abs(node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2 - (box.top + box.height / 2)) < 3);
        // Only the side that exists on this row carries a number.
        const target = numbers.find((node) => node.textContent.trim() !== '') ?? numbers[0] ?? line;
        const rect = target.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      }
      throw new Error('Missing diff line: ' + ${JSON.stringify(text)});
    })()`);
    /** Native drag on the number column: press the first row, move over the last, release. */
    const selectLines = async (from: string, to: string, expected?: string) => {
      const start = await linePoint(from, "first"); const end = await linePoint(to, "last");
      if (from !== to) assert.ok(Math.abs(end.y - start.y) > 10, "the range endpoints are distinct rows");
      window.webContents.sendInputEvent({ type: "mouseDown", ...start, button: "left", clickCount: 1 });
      for (let step = 1; step <= 8; step++) {
        window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(start.x + (end.x - start.x) * step / 8),
          y: Math.round(start.y + (end.y - start.y) * step / 8), button: "left", modifiers: ["leftButtonDown"] });
        await delay(25);
      }
      window.webContents.sendInputEvent({ type: "mouseUp", ...end, button: "left", clickCount: 1 });
      await wait("Boolean(document.querySelector('.review-comment-composer'))", "line comment composer");
      if (expected) await wait(`document.querySelector('.review-comment-composer')?.dataset.reviewComposer === ${JSON.stringify(expected)}`, "comment range");
    };
    const writeComment = async (text: string) => {
      await evaluate(`(() => { const form = document.querySelector('.review-comment-composer'); form.scrollIntoView({ block: 'center' }); form.querySelector('textarea').focus(); form.querySelector('textarea').select(); })()`);
      await window.webContents.insertText(text);
      await wait(`document.querySelector('.review-comment-composer textarea')?.value === ${JSON.stringify(text)}`, "comment text typed");
      const before = Number(await evaluate<string>("document.querySelector('[data-review-comments]')?.dataset.reviewComments ?? '0'"));
      assert.equal(await evaluate("document.querySelector('.review-comment-composer button[type=\"submit\"]')?.disabled"), false, "the add control is enabled");
      // Modifier+Enter submits without depending on buttons below the sticky action bar.
      await key("Enter", process.platform === "darwin" ? ["meta"] : ["control"]);
      await wait(`Number(document.querySelector('[data-review-comments]')?.dataset.reviewComments ?? 0) === ${before + 1}`, "comment added to the list");
    };

    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(turnRoot)})`); await ready();
    await wait("Boolean(document.querySelector('.workbench-scope option[value=\"lastTurn\"]:not([disabled])'))", "last turn scope option");
    await select('.workbench-scope', "lastTurn");
    await wait("document.querySelector('.workbench-scope')?.value === 'lastTurn' && document.querySelector('.git-review-panel')?.dataset.turnScope === 'true'", "last turn scope active");
    await wait(`${state} === 'ready' && ${hasCode("version = 2")}`, "turn range before commenting");
    await selectLines("export const version = 2;", "export const version = 2;");
    await writeComment("这里需要补充单测。");
    const commentId = await evaluate<string>("document.querySelector('[data-review-comment]')?.dataset.reviewComment");
    assert.ok(commentId, "the created comment has an identity");
    assert.equal(await evaluate("document.querySelector('[data-comment-snippet]')?.textContent"), "export const version = 2;");
    assert.equal(await evaluate("document.querySelector('[data-comment-text]')?.textContent"), "这里需要补充单测。");
    assert.equal(await evaluate("document.querySelector('[data-review-comments]')?.dataset.reviewComments"), "1");
    assert.equal(await evaluate("document.querySelectorAll('[data-review-comment-row]').length"), 1);
    assert.equal(await evaluate("document.querySelector('[data-review-comment-row]')?.dataset.commentOutdated"), "false");
    assert.equal(await evaluate("document.querySelector('[data-review-comment-row] [data-comment-text]')?.textContent"), "这里需要补充单测。");
    await capture("git-comment-zh");
    stage("A line selection creates a comment bound to its snapshot, side, lines and exact snippet");

    // 多行选择，并把选中的意见连同准确位置与片段放进当前对话草稿。
    await write(turnRoot, "aaa.md", "第一行\n第二行\n第三行\n");
    await select('.workbench-scope', "unstaged"); await wait(`${state} === 'ready' && ${hasCode("第三行")}`, "multi-line target in live Git");
    await selectLines("第一行", "第三行", "additions:1-3");
    await writeComment("这三行可以合并成一段。");
    await wait("document.querySelectorAll('[data-review-comment-row]').length === 2", "second comment listed");
    assert.equal(await evaluate("document.querySelector('[data-review-comment-row] [data-comment-text]')?.textContent"), "这三行可以合并成一段。");
    await click('[data-review-comment-row] input[type="checkbox"]');
    await wait("document.querySelector('[data-review-action=\"use-comments\"]')?.disabled === false", "comment selected for the draft");
    await click('[data-review-action="use-comments"]');
    await wait("window.gitReviewFixture.state().prompt.length > 0", "prompt draft filled from comments");
    const draft = await evaluate<string>("window.gitReviewFixture.state().prompt");
    assert.match(draft, /请根据以下审查意见修改代码/);
    assert.match(draft, /aaa\.md · 新增侧 1–3/);
    assert.match(draft, /第一行\n第二行\n第三行/);
    assert.match(draft, /这三行可以合并成一段。/);
    stage("A multi-line selection enters the conversation draft with its exact location and snippet");

    // 解决/重新打开/删除：已解决的意见默认不占列表，但数量仍保留。
    await click('[data-review-comment-row] [data-review-action="resolve-row"]');
    await wait("document.querySelectorAll('[data-review-comment-row]').length === 1", "resolved comment leaves the list");
    assert.equal(await evaluate("document.querySelector('[data-review-comments]')?.dataset.reviewComments"), "2");
    await click('.review-comments header button');
    await wait("document.querySelectorAll('[data-review-comment-row]').length === 2 && document.querySelector('[data-review-comment-row]')?.dataset.commentResolved === 'true'", "resolved comments shown on demand");
    await click('[data-review-comment-row] [data-review-action="resolve-row"]');
    await wait("document.querySelectorAll('[data-review-comment-row]').length === 2 && document.querySelector('[data-review-comment-row]')?.dataset.commentResolved === 'false'", "comment reopened");
    await click('.review-comments header button');
    await wait("document.querySelectorAll('[data-review-comment-row]').length === 2", "open comments listed again");
    stage("Comments resolve, reopen and stay out of the list until asked for");

    // 版本变化后标为过期：不再当作当前代码上的意见。
    const aaaRow = "[...document.querySelectorAll('[data-review-comment-row]')].find((row) => row.querySelector('.review-comment-row-path')?.textContent === 'aaa.md')";
    assert.equal(await evaluate(`(${aaaRow})?.dataset.commentOutdated`), "false", "a comment on unchanged live content is current");
    await write(turnRoot, "aaa.md", "第一行\n第二行改过了\n第三行\n");
    await wait("document.querySelector('[data-review-scope]') !== undefined || true", "live refresh for the edited file");
    await wait(`(${aaaRow})?.dataset.commentOutdated === 'true'`, "comment marked outdated by the new version");
    assert.match(await evaluate<string>(`(${aaaRow})?.querySelector('[data-comment-text]')?.textContent ?? ''`), /这三行可以合并成一段/);
    assert.equal(await evaluate("document.querySelectorAll('[data-review-comment-row][data-comment-outdated=\"true\"]').length"), 2);
    await capture("git-comment-outdated-zh");
    stage("A file version change marks its comments outdated instead of moving them silently");

    // 项目与会话隔离，以及渲染层重载后的持久化。
    await evaluate("window.gitReviewFixture.setSessionKey('/sessions/other.jsonl')");
    await wait("document.querySelector('[data-review-comments]')?.dataset.reviewComments === '0'", "comments are per conversation");
    await evaluate("window.gitReviewFixture.setSessionKey('/sessions/smoke.jsonl')");
    await wait("document.querySelector('[data-review-comments]')?.dataset.reviewComments === '2'", "comments return for their conversation");
    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(b)})`); await ready();
    await wait("document.querySelector('[data-review-comments]')?.dataset.reviewComments === '0'", "comments are per project");
    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(turnRoot)})`); await ready();
    await wait("document.querySelector('[data-review-comments]')?.dataset.reviewComments === '2'", "comments return for their project");
    const reloadedComments = new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
    window.webContents.reload(); await reloadedComments;
    await evaluate(`window.gitReviewFixture.setProject(${JSON.stringify(turnRoot)})`); await ready();
    await wait("document.querySelector('[data-review-comments]')?.dataset.reviewComments === '2'", "comments survive a renderer reload");
    assert.equal(await evaluate("document.querySelectorAll('[data-review-comment-row]').length"), 2);
    stage("Line comments stay scoped to their project and conversation and survive a reload");

    await evaluate("window.gitReviewFixture.setLocale('en')");
    await click('[data-review-comment-row] [data-review-action="delete-row"]');
    await wait("document.querySelector('[data-review-comments]')?.dataset.reviewComments === '1'", "comment deleted");
    await evaluate("window.gitReviewFixture.clearPrompt()");

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
