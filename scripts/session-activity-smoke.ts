import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { AgentActivityStore } from "../src/main/agent-activity";
import { AgentHost } from "../src/main/agent-host";
import { AgentManager } from "../src/main/agent-manager";
import type { AgentEvent, AgentSnapshot, SessionSummary } from "../src/shared/types";
import { testComposerDrafts, type ComposerSmokeControls } from "./composer-drafts-smoke";

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
  const starts = new Map<string, number>();
  const draftSmoke = process.env.TACODE_COMPOSER_SMOKE === "1";
  const controls: ComposerSmokeControls = { configured: true, failStart: false, prompt: draftSmoke ? "reject" : "approval", submitted: [] };
  const activity = new AgentActivityStore((value) => main?.webContents.send("agent:activity", value));
  const now = new Date().toISOString();
  const sessions: SessionSummary[] = ["A", "B"].map((name) => ({
    id: name, title: `会话 ${name}`, path: path.join(project, `${name}.jsonl`), storagePath: path.join(project, `${name}.jsonl`),
    cwd: project, createdAt: now, updatedAt: now, messageCount: 2, pinned: false, archived: false,
  }));
  const transcript = (file: string) => [
    { role: "user", content: [{ type: "text", text: `${path.basename(file)} 的问题` }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: `${path.basename(file)} 的回复` }], stopReason: "stop", timestamp: 2 },
  ];
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
    ipcMain.handle("app:get-locale", () => "zh");
    ipcMain.handle("app:build-status", () => ({ restartRequired: false }));
    ipcMain.handle("app:config-notices", () => []);
    ipcMain.handle("app:version", () => "test");
    ipcMain.handle("providers:list", () => []);
    ipcMain.handle("providers:defaults", () => ({ defaultProviderId: null, defaultModelId: null }));
    ipcMain.handle("vision:config", () => ({ profiles: [], activeProfileId: "" }));
    ipcMain.handle("app:log-diagnostic", () => {});
    ipcMain.handle("workspace:recent", () => [{ path: project, name: "project", updatedAt: now }]);
    ipcMain.handle("workspace:list", () => []);
    ipcMain.handle("workspace:read", (_event, file) => ({ path: file, content: "", binary: false }));
    ipcMain.handle("sessions:list", () => sessions);
    ipcMain.handle("delegations:list", () => []);
    ipcMain.handle("skills:list", () => ({ skills: [], projectTrusted: true }));
    ipcMain.handle("auth:status", () => [{ id: "openai", serviceId: "fixture", serviceVersion: "1", preferred: true, configured: controls.configured, defaultModel: "fixture", models: ["fixture"] }]);
    ipcMain.handle("agent:runtimes", () => manager.list());
    ipcMain.handle("agent:activities", () => activity.list());
    ipcMain.handle("agent:acknowledge-activity", (_event, id, version) => activity.acknowledge(id, version));
    ipcMain.handle("agent:replay", (_event, id, seq) => manager.replay(id, seq));
    ipcMain.handle("agent:command", (_event, type, data, id) => manager.command(id, type, data));
    ipcMain.handle("agent:stop", (_event, id) => manager.stop(id));
    ipcMain.handle("agent:ui-response", (_event, id, response, runtimeId) => manager.respondToUi(runtimeId, id, response));
    ipcMain.handle("agent:start", async (_event, options) => {
      if (controls.failStart) throw new Error("fixture worker startup failed");
      const sessionPath = options.sessionPath ?? path.join(project, "new.jsonl");
      const snapshot = await manager.start({ ...options, sessionPath, cwd: project });
      return { ...snapshot, cwd: project, activity: activity.bind(snapshot.runtimeId, sessionPath) };
    });
    main = new BrowserWindow({
      width: 1440, height: 960, show: true, backgroundColor: "#f6f4f0",
      webPreferences: { preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    main.webContents.on("console-message", (_event, level, message) => { if (level >= 3) rendererErrors.push(`${stage}: ${message}`); });
    await main.loadFile(process.env.TACODE_ACTIVITY_FIXTURE!);
    main.focus();
    stage = "open A";
    await wait(() => evaluate("document.querySelectorAll('.home-recent').length === 2"));
    await evaluate("document.querySelector('.home-recent').click()");
    await select("A");
    const a = manager.findBySession(sessions[0].path)!;
    if (!draftSmoke) emit(a, { type: "agent_start" });
    stage = "open B while A runs";
    await select("B");
    const b = manager.findBySession(sessions[1].path)!;
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
    main.webContents.reload();
    await wait(() => evaluate("document.querySelectorAll('.home-recent').length === 2"));
    await evaluate("document.querySelector('.home-recent').click()");
    await select("B");
    main.focus();
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
    await screenshot("failure.png").catch(() => undefined);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    await manager.stopAll();
    main?.destroy();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    app.exit(process.exitCode ?? 0);
  }
}

void smoke().catch((error) => { console.error(error); app.exit(1); });
