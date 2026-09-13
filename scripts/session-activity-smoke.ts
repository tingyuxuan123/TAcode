import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { AgentActivityStore } from "../src/main/agent-activity";
import { AgentHost } from "../src/main/agent-host";
import { AgentManager } from "../src/main/agent-manager";
import { readSessionTranscript } from "../src/main/session-transcript";
import { SessionMaintenance } from "../src/main/session-maintenance";
import { SessionIndex } from "../src/main/session-index";
import { initializeTacodeHome } from "../src/runtime/home";
import { listTacodeThreads } from "../src/runtime/state";
import type { AgentEvent, AgentSnapshot, SessionSummary } from "../src/shared/types";
import { testComposerDrafts, type ComposerSmokeControls } from "./composer-drafts-smoke";
import { testImeInput } from "./ime-smoke";

/** 真实 App + preload + Electron IPC + Host 行协议；生成事件由本地夹具驱动，不访问模型服务。 */
async function smoke() {
  const root = await mkdtemp(path.join(tmpdir(), "tacode-activity-smoke-"));
  const project = path.join(root, "project");
  await mkdir(project);
  process.env.TACODE_HOME = path.join(root, "home");
  app.setPath("userData", path.join(root, "electron"));
  app.on("window-all-closed", () => {});
  let main: BrowserWindow | undefined;
  let stage = "startup";
  const rendererErrors: string[] = [];
  const replies: Array<{ runtimeId: string; id: string; confirmed?: boolean }> = [];
  const pendingPrompts = new Map<string, () => void>();
  const sessionReads = new Set<Promise<unknown>>();
  let closing = false;
  let holdNextList = false;
  let releaseList: (() => void) | undefined;
  let holdMutation = false;
  let releaseMutation: (() => void) | undefined;
  const mutationBarrier = async () => {
    if (holdMutation) { holdMutation = false; await new Promise<void>((resolve) => { releaseMutation = resolve; }); }
  };
  const sessionIndex = new SessionIndex({ onChanged: () => { if (!closing) main?.webContents.send("sessions:changed"); } });
  const starts = new Map<string, number>();
  const draftSmoke = process.env.TACODE_COMPOSER_SMOKE === "1";
  const imeSmoke = process.env.TACODE_IME_SMOKE === "1";
  const navigationSmoke = process.env.TACODE_NAVIGATION_SMOKE === "1";
  const historySmoke = process.env.TACODE_HISTORY_SMOKE === "1";
  const startupSmoke = process.env.TACODE_STARTUP_SMOKE === "1";
  const listSmoke = process.env.TACODE_SESSION_LIST_SMOKE === "1";
  const startupBaseline = process.env.TACODE_STARTUP_BASELINE === "1";
  const startupCount = Number(process.env.TACODE_STARTUP_COUNT ?? 0);
  let startupAt = 0;
  let windowShownMs = 0;
  const startupMaintenance = new SessionMaintenance({
    onStatus: (status) => main?.webContents.send("sessions:maintenance", status),
    onChanged: () => main?.webContents.send("sessions:changed"),
  });
  const controls: ComposerSmokeControls = { configured: true, failStart: false, prompt: draftSmoke || imeSmoke ? "reject" : "approval", submitted: [] };
  const renames: string[] = [];
  const activity = new AgentActivityStore((value) => main?.webContents.send("agent:activity", value));
  const now = new Date().toISOString();
  const sessionDirectory = startupSmoke || listSmoke ? path.join(root, "home", "sessions") : project;
  const sessions: SessionSummary[] = (startupSmoke ? Array.from({ length: startupCount }, (_, i) => String(i)) : ["A", "B"]).map((name) => ({
    id: name, title: `会话 ${name}`, path: path.join(sessionDirectory, `${name}.jsonl`), storagePath: path.join(sessionDirectory, `${name}.jsonl`),
    cwd: project, createdAt: now, updatedAt: now, messageCount: 2, pinned: false, archived: false,
  }));
  const transcript = (file: string) => [
    { role: "user", content: [{ type: "text", text: `${path.basename(file)} 的问题` }], timestamp: Date.parse(now) + 1 },
    { role: "assistant", content: [{ type: "text", text: `${path.basename(file)} 的回复` }], stopReason: "stop", timestamp: Date.parse(now) + 2 },
  ];
  const writeTranscript = (file: string, count = 2) => writeFile(file, Array.from({ length: count }, (_, index) => ({
    type: "message", id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
    message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: `${path.basename(file)} 历史记录 ${index}` }], timestamp: 1789000000000 + index },
  })).map((entry) => JSON.stringify(entry)).join("\n"));
  let delayedHistory: string | undefined;
  let releaseHistory: (() => void) | undefined;
  const emit = (host: AgentHost, event: Record<string, unknown>) => (host as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify(event));
  const manager = new AgentManager({ createHost: (runtimeId) => {
    const host = new AgentHost(
      (event) => { activity.observe(event); main?.webContents.send("agent:event", event); },
      (message, sessionKey, id) => {
        activity.fail(id ?? runtimeId, sessionKey, message, !host.isRunning());
        main?.webContents.send("agent:error", { message, __sessionId: sessionKey, __runtimeId: id ?? runtimeId });
      },
    );
    host.start = async (options): Promise<AgentSnapshot> => {
      // 模拟真实 start 的销毁语义，防止“复用”测试掩盖后台进程被重启。
      await host.stop();
      starts.set(runtimeId, (starts.get(runtimeId) ?? 0) + 1);
      host.sessionKey = options.sessionPath;
      const internals = host as unknown as { child: unknown };
      internals.child = {
        exitCode: null,
        stdin: { destroyed: false, write: (line: string) => {
          const request = JSON.parse(line);
          if (request.type === "extension_ui_response") {
            replies.push({ ...request, runtimeId });
            if (request.id === "approve-a-2") pendingPrompts.get(runtimeId)?.();
          } else if (request.type === "prompt") {
            controls.submitted.push(request);
            const complete = (accepted: boolean) => {
              if (accepted) emit(host, { type: "agent_start" });
              emit(host, { type: "response", id: request.id, success: accepted, data: {}, error: accepted ? undefined : "fixture rejected send" });
              pendingPrompts.delete(runtimeId);
            };
            if (controls.prompt === "approval") pendingPrompts.set(runtimeId, () => complete(true));
            else if (controls.prompt === "delay") controls.completePrompt = complete;
            else queueMicrotask(() => complete(controls.prompt === "accept"));
          }
          else queueMicrotask(() => emit(host, {
            type: "response", id: request.id, success: !(controls.failSetup && request.type === "set_model"),
            error: controls.failSetup && request.type === "set_model" ? "fixture model setup failed" : undefined,
            data: request.type === "get_state" ? { sessionFile: host.sessionKey, isStreaming: host.isInTurn(), model: { id: "fixture" }, thinkingLevel: "off" }
              : request.type === "get_messages" ? { messages: transcript(host.sessionKey!) }
                : request.type === "get_available_models" ? { models: [{ id: "fixture", provider: "openai", input: ["text", "image"] }] }
                  : request.type === "get_available_thinking_levels" ? { levels: ["off"] }
                    : request.type === "get_commands" ? { commands: [] }
                      : request.type === "get_session_stats" ? { sessionFile: host.sessionKey } : {},
          }));
          return true;
        } },
      };
      return host.snapshot();
    };
    return host;
  } });
  const evaluate = <T = unknown>(script: string): Promise<T> => main!.webContents.executeJavaScript(script, true);
  const wait = async (condition: () => Promise<unknown>, timeout = 12_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out at ${stage}`);
  };
  const select = async (name: string) => {
    const label = JSON.stringify(`会话 ${name}`);
    await wait(() => evaluate(`Array.from(document.querySelectorAll('.session-row')).some(el => el.getAttribute('aria-label') === ${label})`));
    await evaluate(`Array.from(document.querySelectorAll('.session-row')).find(el => el.getAttribute('aria-label') === ${label}).click()`);
    await wait(() => evaluate(`document.querySelector('.session-row[aria-current=page]')?.getAttribute('aria-label') === ${label} && !document.querySelector('.session-loading') && !!document.querySelector('.conversation .user') && !!document.querySelector('[contenteditable=true]')`));
  };
  const badge = (name: string, state: string) => evaluate(`Boolean(Array.from(document.querySelectorAll('.session-row')).find(el => el.getAttribute('aria-label') === ${JSON.stringify(`会话 ${name}`)})?.querySelector('[data-session-state=${state}]'))`);
  const screenshot = async (name: string) => {
    const output = process.env.TACODE_UX_ARTIFACT_DIR;
    if (!output || !main) return;
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, name), (await main.webContents.capturePage()).toPNG());
  };
  const watchdog = setTimeout(() => { console.error(`Activity smoke timed out: ${stage}`); app.exit(1); }, 90_000);
  try {
    await app.whenReady();
    if (startupSmoke || listSmoke) {
      await mkdir(sessionDirectory, { recursive: true });
      await Promise.all(sessions.map((session) => writeFile(session.path, [
        { type: "session", version: 3, id: session.id, cwd: project, timestamp: "2026-09-13T00:00:00Z" },
        { type: "message", id: "u", parentId: null, message: { role: "user", content: session.title } },
        { type: "message", id: "a", parentId: "u", message: { role: "assistant", content: "已有记录" } },
        ...(listSmoke ? [{ type: "session_info", name: session.title }] : []),
      ].map((entry) => JSON.stringify(entry)).join("\n") + (listSmoke ? "\n" : ""))));
      startupAt = performance.now();
      await initializeTacodeHome({ deferHistory: !startupBaseline });
      if (listSmoke) { await sessionIndex.reconcile(); sessionIndex.startWatching(); }
    }
    ipcMain.handle("app:get-locale", () => "zh");
    ipcMain.handle("app:build-status", () => ({ restartRequired: false }));
    ipcMain.handle("app:config-notices", () => []);
    ipcMain.handle("app:version", () => "test");
    ipcMain.handle("providers:list", () => []);
    ipcMain.handle("providers:defaults", () => ({ defaultProviderId: null, defaultModelId: null }));
    ipcMain.handle("vision:config", () => ({ profiles: [], activeProfileId: "" }));
    ipcMain.handle("app:log-diagnostic", () => {});
    ipcMain.handle("workspace:recent", () => [{ path: project, name: "project", updatedAt: now }]);
    ipcMain.handle("workspace:list", () => imeSmoke ? ["src/", "src/App.tsx", "src/中文.ts"] : []);
    ipcMain.handle("workspace:read", (_event, file) => ({ path: file, content: "", binary: false }));
    ipcMain.handle("sessions:list", () => {
      if (closing) return [];
      const job = (async () => {
        const rows = listSmoke ? sessionIndex.store.list().map((thread) => ({ ...thread, path: thread.sessionPath })) : startupSmoke
          ? (await listTacodeThreads({}, startupBaseline || startupMaintenance.ready)).map((thread) => ({ ...thread, path: thread.sessionPath })) : sessions;
        if (holdNextList) { holdNextList = false; await new Promise<void>((resolve) => { releaseList = resolve; }); }
        return rows;
      })();
      sessionReads.add(job);
      return job.finally(() => { sessionReads.delete(job); });
    });
    ipcMain.handle("sessions:maintenance", () => startupSmoke && !startupBaseline ? startupMaintenance.snapshot() : { state: "ready", completed: 0, total: 0 });
    ipcMain.handle("sessions:maintain", () => startupMaintenance.run());
    ipcMain.handle("sessions:read", async (_event, file, options) => {
      if (file === delayedHistory) await new Promise<void>((resolve) => { releaseHistory = resolve; });
      return historySmoke ? readSessionTranscript(project, file, options) : { sessionPath: file, messages: transcript(file), totalMessages: 2, truncated: false };
    });
    ipcMain.handle("sessions:rename", async (_event, id, title) => {
      await mutationBarrier();
      if (listSmoke) {
        const row = sessionIndex.store.get(id)!;
        await appendFile(row.storagePath, JSON.stringify({ type: "session_info", name: title }) + "\n");
        await sessionIndex.store.indexSession(row.sessionPath);
        sessionIndex.changed();
      }
      renames.push(title);
      const session = sessions.find((row) => row.id === id);
      if (session) session.title = title;
    });
    ipcMain.handle("sessions:pin", async (_event, id, pinned) => {
      await mutationBarrier();
      sessionIndex.store.setPinned(id, pinned);
      sessionIndex.changed();
    });
    ipcMain.handle("sessions:remove", async (_event, id) => {
      await mutationBarrier();
      await sessionIndex.store.archive(id);
      sessionIndex.changed();
    });
    ipcMain.handle("delegations:list", () => []);
    ipcMain.handle("skills:list", () => ({ skills: [], projectTrusted: true }));
    ipcMain.handle("auth:status", () => [{ id: "openai", serviceId: "fixture", serviceVersion: "1", preferred: true, configured: controls.configured, defaultModel: "fixture", models: ["fixture"] }]);
    ipcMain.handle("agent:runtimes", () => manager.list());
    ipcMain.handle("agent:activities", () => activity.list());
    ipcMain.handle("agent:acknowledge-activity", (_event, id, version) => activity.acknowledge(id, version));
    ipcMain.handle("agent:replay", (_event, id, seq) => manager.replay(id, seq));
    ipcMain.handle("agent:command", (_event, type, data, id) => manager.command(id, type, data));
    ipcMain.handle("agent:stop", (_event, id) => manager.stop(id));
    ipcMain.handle("agent:deactivate", () => manager.deactivate());
    ipcMain.handle("agent:attach", async (_event, id) => {
      const snapshot = await manager.resume(id);
      return { ...snapshot, cwd: project, activity: activity.bind(id, manager.findRuntime(id)?.sessionKey) };
    });
    ipcMain.handle("agent:ui-response", (_event, id, response, runtimeId) => manager.respondToUi(runtimeId, id, response));
    ipcMain.handle("agent:start", async (_event, options) => {
      if (controls.failStart) throw new Error("fixture worker startup failed");
      const sessionPath = options.sessionPath ?? path.join(project, "new.jsonl");
      const snapshot = await manager.start({ ...options, sessionPath, cwd: project, serviceKey: "fixture:1" });
      return { ...snapshot, cwd: project, activity: activity.bind(snapshot.runtimeId, sessionPath) };
    });
    main = new BrowserWindow({
      width: 1440, height: 960, show: !startupSmoke, backgroundColor: "#f6f4f0",
      webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    if (startupSmoke) main.once("ready-to-show", () => {
      main!.show();
      windowShownMs = performance.now() - startupAt;
      if (!startupBaseline) void startupMaintenance.run();
    });
    main.webContents.on("console-message", (_event, level, message) => { if (level >= 3) rendererErrors.push(`${stage}: ${message}`); });
    main.webContents.on("render-process-gone", (_event, details) => { console.error("Fixture renderer exited", details); app.exit(1); });
    // 活动/输入回归从已有 worker 开始；纯阅读回归单独验证零 worker。
    if (historySmoke) {
      controls.configured = false;
      for (const session of sessions) await writeTranscript(session.path, session.id === "A" ? 460 : 2);
    } else if (!startupSmoke && !listSmoke) for (const session of sessions) await manager.start({ cwd: project, sessionPath: session.path, provider: "openai", permission: "auto", sandbox: "read-only", serviceKey: "fixture:1" });
    manager.deactivate();
    await main.loadFile(process.env.TACODE_ACTIVITY_FIXTURE!);
    main.focus();
    if (listSmoke) {
      stage = "session list actions preserve optimistic results through delayed responses";
      await wait(() => evaluate("document.querySelectorAll('.home-recent').length === 2"));
      await evaluate("document.querySelector('.project-row').click()");
      await wait(() => evaluate("document.querySelectorAll('.session-row').length === 2"));
      const row = (name: string) => `Array.from(document.querySelectorAll('.session-row')).find(el => el.getAttribute('aria-label') === ${JSON.stringify(name)})`;
      const menu = async (name: string, action: string) => {
        await evaluate(`${row(name)}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 250 }))`);
        await wait(() => evaluate("!!document.querySelector('.session-menu')"));
        await evaluate(`Array.from(document.querySelectorAll('.session-menu button')).find(el => el.textContent.trim() === ${JSON.stringify(action)}).click()`);
      };
      const delayList = async () => {
        releaseList = undefined;
        holdNextList = true;
        main!.webContents.send("sessions:changed");
        await wait(async () => Boolean(releaseList));
      };
      await delayList();
      holdMutation = true;
      await menu("会话 A", "置顶");
      await wait(async () => Boolean(releaseMutation));
      await wait(() => evaluate(`!!${row("会话 A")}?.querySelector('svg')`));
      releaseList!();
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      assert.equal(await evaluate(`!!${row("会话 A")}?.querySelector('svg')`), true);
      releaseMutation!();
      await wait(async () => sessionIndex.store.get("A")?.pinned);
      stage = "rename and external rename remain visible";
      await menu("会话 A", "重命名");
      await wait(() => evaluate("!!document.querySelector('.session-rename')"));
      await main.webContents.insertText("中文新标题");
      main.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      main.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      await wait(() => evaluate(`!!${row("中文新标题")}`));
      await wait(async () => sessionIndex.store.get("A")?.title === "中文新标题");
      await evaluate("new Promise(resolve => setTimeout(resolve, 300))");
      await appendFile(sessionIndex.store.get("A")!.storagePath, JSON.stringify({ type: "session_info", name: "外部标题" }) + "\n");
      await wait(() => evaluate(`!!${row("外部标题")}`));
      await delayList();
      holdMutation = true;
      releaseMutation = undefined;
      await menu("外部标题", "移除");
      await wait(async () => Boolean(releaseMutation));
      await wait(() => evaluate(`!${row("外部标题")}`));
      releaseList!();
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      assert.equal(await evaluate(`!!${row("外部标题")}`), false);
      releaseMutation!();
      await wait(async () => sessionIndex.store.get("A")?.archived);
      assert.equal(manager.list().length, 0);
      assert.deepEqual(rendererErrors.filter((message) => !message.includes("ResizeObserver loop completed") && !message.includes("Electron Security Warning")), []);
      console.log("Session list smoke passed: shared SQLite, pin/rename/archive, delayed pre-mutation replies, no workers.");
      return;
    }
    if (startupSmoke) {
      stage = "sidebar remains usable while history is organized";
      await wait(() => evaluate("!!document.querySelector('.project-row:not([disabled])')"));
      const sidebarReadyMs = performance.now() - startupAt;
      await evaluate("document.querySelector('.project-row').click()");
      stage = "composer becomes editable during organization";
      await wait(() => evaluate("!!document.querySelector('.prompt-input[contenteditable=true]')"));
      const composerReadyMs = performance.now() - startupAt;
      stage = "typing remains responsive during organization";
      const typingAt = performance.now();
      await evaluate("document.querySelector('.prompt-input').focus()");
      await main.webContents.insertText("整理期间可以继续输入");
      await wait(() => evaluate("document.querySelector('.prompt-input').textContent.includes('整理期间可以继续输入')"));
      const inputMs = performance.now() - typingAt;
      if (!startupBaseline) await startupMaintenance.run();
      const rows = await listTacodeThreads({}, false);
      assert.equal(rows.length, startupCount);
      await wait(async () => windowShownMs > 0);
      assert.equal(manager.list().length, 0);
      assert.deepEqual(rendererErrors.filter((message) => !message.includes("ResizeObserver loop completed") && !message.includes("Electron Security Warning")), []);
      console.log("STARTUP_RESULT " + JSON.stringify({ mode: startupBaseline ? "blocking" : "deferred", sessions: startupCount, windowShownMs, sidebarReadyMs, composerReadyMs, inputMs, organizedMs: performance.now() - startupAt }));
      return;
    }
    if (historySmoke) {
      stage = "read histories without model configuration or workers";
      await wait(() => evaluate("document.querySelectorAll('.home-recent').length === 2"));
      await evaluate("document.querySelector('.home-recent').click()");
      for (const name of ["A", "B", "A"]) await select(name);
      assert.equal(manager.list().length, 0);
      assert.equal(await evaluate("!!document.querySelector('.modal')"), false);
      stage = "page back to the first recorded message";
      let pages = 0;
      while (await evaluate("!!document.querySelector('.session-history-controls button')")) {
        await evaluate("document.querySelector('.session-history-controls button').click()");
        await wait(() => evaluate("!document.querySelector('.session-history-controls button[disabled]')"));
        if (++pages > 6) throw new Error("History cursor did not advance");
      }
      assert.equal(pages, 4);
      await evaluate("document.querySelector('.conversation').scrollTop = 0");
      await wait(() => evaluate("document.querySelector('.conversation .user')?.textContent.includes('A.jsonl 历史记录 0')"));
      await screenshot("full-history.png");
      stage = "late history response cannot replace final selection";
      await select("B");
      delayedHistory = sessions[0].path;
      await evaluate("Array.from(document.querySelectorAll('.session-row')).find(el => el.getAttribute('aria-label') === '会话 A').click()");
      await wait(async () => Boolean(releaseHistory));
      await select("B");
      releaseHistory!();
      delayedHistory = undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await evaluate("document.querySelector('.session-row[aria-current=page]')?.getAttribute('aria-label')"), "会话 B");
      assert.equal(manager.list().length, 0);
      stage = "missing history is retryable and differs from empty";
      await select("A");
      await rm(sessions[1].path);
      await evaluate("Array.from(document.querySelectorAll('.session-row')).find(el => el.getAttribute('aria-label') === '会话 B').click()");
      await wait(() => evaluate("!!document.querySelector('.session-history-controls [role=alert]')"));
      await writeTranscript(sessions[1].path);
      await evaluate("document.querySelector('.session-history-controls [role=alert] button').click()");
      await wait(() => evaluate("!document.querySelector('.session-history-controls [role=alert]') && !!document.querySelector('.conversation .user')"));
      await select("A");
      await writeTranscript(sessions[1].path, 0);
      await evaluate("Array.from(document.querySelectorAll('.session-row')).find(el => el.getAttribute('aria-label') === '会话 B').click()");
      await wait(() => evaluate("!!document.querySelector('.session-pane-empty') && !document.querySelector('.session-history-controls [role=alert]')"));
      await writeTranscript(sessions[1].path);
      await select("B");
      stage = "continue starts one worker and later reading attaches without configuration";
      controls.configured = true;
      controls.prompt = "accept";
      await evaluate("document.querySelector('.prompt-input').focus()");
      await main.webContents.insertText("继续 B");
      await evaluate("document.querySelector('.prompt button[type=submit]').click()");
      await wait(async () => controls.submitted.length === 1);
      const host = manager.findBySession(sessions[1].path)!;
      assert.equal(manager.list().length, 1);
      await select("A");
      controls.configured = false;
      emit(host, { type: "extension_ui_request", id: "history-approval", method: "confirm", title: "B 仍在运行并等待确认" });
      await select("B");
      await wait(() => evaluate("document.querySelector('.approval')?.textContent.includes('B 仍在运行')"));
      assert.equal(manager.list().length, 1);
      assert.equal(starts.get(host.runtimeId), 1);
      assert.equal(await evaluate("!!document.querySelector('.modal')"), false);
      assert.deepEqual(rendererErrors.filter((message) => !message.includes("ResizeObserver loop completed") && !message.includes("Electron Security Warning")), []);
      console.log("History smoke passed: no-model reading, zero browse workers, full pagination, stale read isolation, missing/retry state, lazy continuation and live approval reattachment.");
      return;
    }
    stage = "open A";
    await wait(() => evaluate("document.querySelectorAll('.home-recent').length === 2"));
    await evaluate("document.querySelector('.home-recent').click()");
    await select("A");
    const a = manager.findBySession(sessions[0].path)!;
    if (!draftSmoke && !imeSmoke) emit(a, { type: "agent_start" });
    if (process.env.TACODE_CHECKPOINT_SMOKE === "1") {
      stage = "checkpoint stages are visible in the command row";
      emit(a, { type: "tool_execution_start", toolCallId: "checkpoint-command", toolName: "exec_command", args: { cmd: "node -e empty" } });
      for (const [phase, label] of [["before", "准备文件检查"], ["after", "检查文件改动"]]) {
        emit(a, { type: "tool_execution_update", toolCallId: "checkpoint-command", toolName: "exec_command", partialResult: { content: [{ type: "text", text: label }], details: { checkpointPhase: phase } } });
        await wait(() => evaluate(`document.querySelector('[data-tool-id="checkpoint-command"] .flow-tool-state')?.textContent === ${JSON.stringify(label)}`));
        await wait(() => evaluate(`Array.from(document.querySelectorAll('.flow-status')).some(el => el.textContent === ${JSON.stringify(label)} && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))`));
      }
      await evaluate("new Promise(resolve => setTimeout(resolve, 350))");
      await screenshot("checkpoint-stage.png");
      emit(a, { type: "tool_execution_end", toolCallId: "checkpoint-command", toolName: "exec_command", result: { content: [{ type: "text", text: "done" }], details: { running: false } } });
      await wait(() => evaluate("!document.querySelector('[data-tool-id=checkpoint-command] .flow-tool-state')"));
      assert.deepEqual(rendererErrors.filter((message) => !message.includes("ResizeObserver loop completed") && !message.includes("Electron Security Warning")), []);
      console.log("Checkpoint UI smoke passed: preparation, after-command check, final state.");
      return;
    }
    stage = "open B while A runs";
    await select("B");
    const b = manager.findBySession(sessions[1].path)!;
    if (navigationSmoke) {
      const newThread = async () => {
        await evaluate("Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === '新对话').click()");
        await wait(() => evaluate("!document.querySelector('.session-row[aria-current=page]') && !!document.querySelector('.prompt-input')"));
      };
      const type = async (value: string) => {
        await evaluate("document.querySelector('.prompt-input').focus()");
        await main!.webContents.insertText(value);
      };
      stage = "new conversation keeps A running";
      await select("A");
      await newThread();
      assert.equal(a.isInTurn(), true);
      assert.equal(a.isRunning(), true);
      assert.equal(manager.active, undefined);
      await wait(() => evaluate("!!Array.from(document.querySelectorAll('.session-row')).find(el => el.getAttribute('aria-label') === '会话 A')?.querySelector('.session-running')"));
      stage = "A pending send does not block B";
      emit(a, { type: "agent_settled" });
      await select("A");
      await type("A 请求确认");
      await evaluate("document.querySelector('.prompt button[type=submit]').click()");
      await wait(async () => pendingPrompts.has(a.runtimeId));
      emit(a, { type: "extension_ui_request", id: "navigation-approval", method: "confirm", title: "A 等待确认", message: "保留此请求" });
      await newThread();
      await select("B");
      controls.prompt = "accept";
      const submitted = controls.submitted.length;
      await type("B 独立发送");
      await evaluate("document.querySelector('.prompt button[type=submit]').click()");
      await wait(async () => controls.submitted.length === submitted + 1 && b.isInTurn());
      await type("B 的草稿不受影响");
      stage = "late A snapshot cannot steal B routing";
      const originalSnapshot = a.snapshot.bind(a);
      let release!: () => void;
      let snapshotStarted = false;
      a.snapshot = async () => {
        snapshotStarted = true;
        await new Promise<void>((resolve) => { release = resolve; });
        return originalSnapshot();
      };
      await evaluate("Array.from(document.querySelectorAll('.session-row')).find(el => el.getAttribute('aria-label') === '会话 A').click()");
      await wait(async () => snapshotStarted);
      await newThread();
      await select("B");
      release();
      a.snapshot = originalSnapshot;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(manager.active, b.runtimeId);
      assert.equal((await evaluate<{ sessionFile: string }>("window.harness.agent.command('get_state')")).sessionFile, b.sessionKey);
      assert.match(await evaluate<string>("document.querySelector('.prompt-input').textContent"), /B 的草稿不受影响/);
      stage = "sidebar stop affects only A";
      await evaluate("Array.from(document.querySelectorAll('.session-row')).find(el => el.getAttribute('aria-label') === '会话 A').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 130, clientY: 220 }))");
      await wait(() => evaluate("!!document.querySelector('.session-menu')"));
      await evaluate("Array.from(document.querySelectorAll('.session-menu button')).find(el => el.textContent.trim() === '停止任务').click()");
      await wait(async () => !manager.findRuntime(a.runtimeId));
      assert.equal(b.isRunning(), true);
      assert.equal(b.isInTurn(), true);
      assert.match(await evaluate<string>("document.querySelector('.prompt-input').textContent"), /B 的草稿不受影响/);
      await screenshot("navigation-background.png");
      assert.deepEqual(rendererErrors.filter((message) => !message.includes("ResizeObserver loop completed") && !message.includes("Electron Security Warning")), []);
      console.log("Navigation smoke passed: new conversation preserves A, pending A send does not block B, delayed snapshot cannot rebind, sidebar stop preserves B worker and draft.");
      return;
    }
    if (imeSmoke) {
      await testImeInput({ main, evaluate, wait, stage: (next) => { stage = next; }, controls, renames });
      assert.deepEqual(rendererErrors.filter((message) => !message.includes("ResizeObserver loop completed") && !message.includes("Electron Security Warning")), []);
      console.log("IME smoke passed: native Chromium composition, file completion, slash commands, Escape preservation, Shift+Enter, send and session rename.");
      return;
    }
    if (draftSmoke) {
      await testComposerDrafts({ main, evaluate, select, wait, controls, screenshot, stage: (next) => { stage = next; }, failActive: () => {
        const host = manager.activeHost()!;
        emit(host, { type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "fixture model failed after acceptance" }] });
        emit(host, { type: "agent_settled" });
      } });
      assert.deepEqual(rendererErrors.filter((message) => !message.includes("ResizeObserver loop completed") && !message.includes("Electron Security Warning")), []);
      console.log("Composer drafts smoke passed: two images, A/B isolation, reload, rejected send, concurrent edits, missing configuration, failed start, accepted send followed by model error.");
      return;
    }
    if (process.env.TACODE_ACTIVITY_BASELINE === "1") {
      stage = "baseline navigation";
      for (const name of ["A", "B", "A", "B"]) await select(name);
      await new Promise((resolve) => setTimeout(resolve, 150));
      console.log("Navigation baseline diagnostics:", rendererErrors);
      const output = process.env.TACODE_UX_ARTIFACT_DIR;
      if (output) {
        await mkdir(output, { recursive: true });
        await writeFile(path.join(output, "navigation-baseline.json"), JSON.stringify(rendererErrors, null, 2));
      }
      return;
    }
    await evaluate("document.querySelector('[contenteditable=true]').focus()");
    await main.webContents.insertText("B 的草稿保持不动");
    const blockedPrompt = manager.command(a.runtimeId, "prompt", { message: "/confirm" });
    await wait(async () => pendingPrompts.has(a.runtimeId));
    emit(a, { type: "extension_ui_request", id: "approve-a", method: "confirm", title: "允许会话 A 写文件？", message: "需要你的确认。" });
    emit(a, { type: "extension_ui_request", id: "approve-a-2", method: "confirm", title: "允许会话 A 第二步？", message: "第二次确认。" });
    stage = "background approval without interrupting B";
    await wait(() => badge("A", "waiting"));
    assert.equal(await evaluate("document.querySelector('.approval') === null"), true);
    assert.match(await evaluate<string>("document.querySelector('[contenteditable=true]').textContent"), /B 的草稿保持不动/);
    await screenshot("background-approval.png");
    stage = "restore pending requests after renderer reload";
    main.webContents.reload();
    await wait(() => evaluate("document.querySelectorAll('.home-recent').length === 2"));
    await evaluate("document.querySelector('.home-recent').click()");
    await select("A");
    await wait(() => evaluate("document.querySelector('.approval')?.textContent.includes('允许会话 A 写文件')"));
    await screenshot("restored-approval.png");
    // 只改变 preload 的默认句柄；已显示的 A 审批必须仍按捕获的 runtimeId 答复。
    await evaluate(`window.harness.agent.start(${JSON.stringify({ cwd: project, sessionPath: sessions[1].path })})`);
    stage = "reply remains bound to A after the default runtime changes";
    await evaluate("Array.from(document.querySelectorAll('.approval button')).find(el => el.classList.contains('primary')).click()");
    await wait(() => evaluate("document.querySelector('.approval')?.textContent.includes('允许会话 A 第二步')"));
    assert.equal(replies.filter((reply) => reply.id === "approve-a").length, 1);
    assert.equal(replies[0].runtimeId, a.runtimeId);
    await evaluate("Array.from(document.querySelectorAll('.approval button')).find(el => el.classList.contains('primary')).click()");
    await wait(() => evaluate("document.querySelector('.approval') === null"));
    assert.deepEqual(replies.map((reply) => reply.runtimeId), [a.runtimeId, a.runtimeId]);
    await blockedPrompt;
    assert.equal(starts.get(a.runtimeId), 1);
    stage = "background failure stays visible";
    await select("B");
    emit(a, { type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "fixture gateway unavailable" }] });
    emit(a, { type: "agent_settled" });
    await wait(() => badge("A", "failed"));
    assert.equal(await badge("A", "completed"), false);
    await select("A");
    await wait(() => evaluate("document.querySelector('.session-activity-error')?.textContent.includes('fixture gateway unavailable')"));
    await screenshot("background-failure.png");
    stage = "completion is unread until opened";
    emit(b, { type: "agent_start" });
    emit(b, { type: "agent_settled" });
    await wait(() => badge("B", "completed"));
    stage = "reload preserves completion";
    main.webContents.reload();
    await wait(() => evaluate("document.querySelectorAll('.home-recent').length === 2"));
    await evaluate("document.querySelector('.home-recent').click()");
    await select("B");
    stage = "opening B acknowledges completion";
    main.focus();
    main.webContents.focus();
    await wait(async () => !(await badge("B", "completed")));
    // 原 renderer（dbda9b1）在同样的普通会话切换中也会报告该布局警告。
    // 保留计数用于 UX-13 性能回放，其他 renderer 错误仍使本测试失败。
    const resizeWarnings = rendererErrors.filter((message) => message.endsWith("ResizeObserver loop completed with undelivered notifications."));
    assert.deepEqual(rendererErrors.filter((message) => !resizeWarnings.includes(message) && !message.includes("Electron Security Warning")), []);
    console.log(`Existing navigation ResizeObserver warnings: ${resizeWarnings.length}`);
    console.log("Session activity smoke passed: background approval, draft preserved while waiting, reload recovery, two requests, captured runtime routing, persistent failure, completion unread and acknowledgement.");
  } catch (error) {
    console.error(`Session activity smoke failed at ${stage}:`, error);
    console.error(rendererErrors);
    console.error(await evaluate("({ focused: document.hasFocus(), visibility: document.visibilityState, url: location.href, selected: document.querySelector('.session-row[aria-current=page]')?.getAttribute('aria-label'), loading: !!document.querySelector('.session-loading'), content: document.body.innerText.slice(0, 2000) })").catch(() => undefined));
    await screenshot("failure.png").catch(() => undefined);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    closing = true;
    await startupMaintenance.cancel();
    await manager.stopAll();
    main?.destroy();
    await Promise.allSettled([...sessionReads]);
    await sessionIndex.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    app.exit(process.exitCode ?? 0);
  }
}

void smoke().catch((error) => { console.error(error); app.exit(1); });
