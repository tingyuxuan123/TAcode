import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  shell,
} from "electron";
import {
  createTacodeCredentialStore,
  deleteUserSubagent,
  ensureSessionRuntimeLink,
  getSubagentsDir,
  getTacodeHome,
  getStoredDeepSeekBaseUrl,
  getStoredModelSelection,
  initializeTacodeHome,
  listTacodeThreads,
  loadSubagents,
  readUserSubagent,
  saveUserSubagent,
  setSubagentEnabled,
  subagentDocumentPath,
  TacodeStateStore,
  defaultModelForProvider,
  providerDisplayName,
  providerEnvironmentKey,
  removeStoredProviderCredential,
  saveDeepSeekBaseUrl,
  saveProviderApiKey,
  SUPPORTED_PROVIDER_IDS,
  type ApiKeyProviderId,
  type SupportedProviderId,
} from "../runtime/index";
import { AgentHost } from "./agent-host";
import { DelegationCoordinator } from "./delegation-coordinator";
import { AgentManager, sessionFileOf } from "./agent-manager";
import { closeAllBrowserPopups } from "./browser/popups";
import { closeAllDetachedBrowserWindows } from "./browser/windows";
import { registerBrowserIpc } from "./browser/ipc";
import { BrowserAutomation } from "./browser/automation";
import {
  consumeConfigNotices,
  noteConfigRecovered,
  protectedMessageFileName,
  readJsonFile,
  writeFileAtomic,
  writeJsonAtomic,
} from "./atomic-file";
import { isPathInsideRoot } from "./workspace-path";
import { LocalLogger } from "./local-logger";
import { listLocalSkills, revealSkillPath } from "./skills-fs";
import { apiBaseUrl, listModels } from "../shared/openai-models";
import {
  activeChat,
  activeCustomProfile,
  isDeepSeekUrl,
  mergeChatProfiles,
  migrateChatProfiles,
  officialDeepSeekKey,
  parseChatProfiles,
  type ChatProfiles,
} from "../shared/chat-profiles";
import {
  mergeWebSearchConfig,
  parseDeepSeekBalance,
  parseMcpServers,
  parseWebSearchConfig,
  serializeMcpServers,
  type McpServerRow,
  type WebSearchConfig,
} from "../shared/integrations";
import {
  DEFAULT_VISION_CONFIG,
  DEEPSEEK_VISION_BASE,
  parseVisionStore,
  resolveVisionRuntime,
  resolveVisionSettings,
  serializeVisionStore,
  visionSnapshot,
  visionTitle,
  type VisionConfig,
} from "../shared/vision-api";
import {
  DEFAULT_LOCALE,
  isLocale,
  resolveLocale,
  t,
  type Locale,
} from "../shared/i18n";
import { getLatestUpdate } from "./update-check";
import { MAX_SUBAGENT_DOCUMENT_BYTES } from "../shared/subagents";
import {
  IPC_LIMITS,
  assertPayloadLimit,
  base64PayloadBytes,
  formatBytes,
  optionalBoolean,
  optionalString,
  requireRecord,
  requireString,
  validateAgentStartOptions,
  validateConnectionInput,
  validatePromptMessage,
} from "./ipc-validation";
import {
  PREVIEW_SCHEME,
  UPLOADS_HOST,
  type AgentSnapshot,
  type AgentStartOptions,
  type ProviderStatus,
  type SandboxMode,
  type SessionSummary,
  type WorkspaceItem,
} from "../shared/types";
import { PROJECT_SKILL_ROOTS } from "../shared/skills";
import {
  NO_ACTIVE_SESSION_MESSAGE,
  agentNoSessionResult,
} from "../shared/agent-protocol";

const ALLOWED_AGENT_COMMANDS = new Set([
  "prompt",
  "steer",
  "abort",
  "new_session",
  "get_state",
  "get_messages",
  "set_model",
  "set_thinking_level",
  "get_session_stats",
  "get_available_models",
  "get_available_thinking_levels",
  "get_fork_messages",
  "get_entries",
  "get_commands",
  "fork",
  "compact",
  "set_auto_compaction",
]);

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const legacyUserDataPath = path.join(app.getPath("appData"), "DSHarness");
const userDataPath = path.join(app.getPath("appData"), "Tether");

// Preserve existing sessions and credentials across the product rename.
if (!fs.existsSync(userDataPath) && fs.existsSync(legacyUserDataPath)) {
  try {
    fs.renameSync(legacyUserDataPath, userDataPath);
  } catch {
    // The old directory remains usable only by older builds; start clean if migration is unavailable.
  }
}

// Desktop distribution favors a quiet first run; the owner-only file avoids OS keyring prompts.
process.env.TETHER_CREDENTIALS_STORE = "file";

let mainWindow: BrowserWindow | undefined;
const browserAutomation = new BrowserAutomation(() => mainWindow);

/** 本地诊断日志（只写本机、限大小、可轮转，不上传；写入前脱敏已知凭据）。 */
const diagnostics = new LocalLogger({
  dir: path.join(getTacodeHome(), "logs"),
  secrets: () =>
    SUPPORTED_PROVIDER_IDS.map((id) => {
      const name = providerEnvironmentKey(id);
      return name ? process.env[name] : undefined;
    }),
});

let delegationCoordinator: DelegationCoordinator | undefined;

function createAgentHost(runtimeId: string, delegationId?: string): AgentHost {
  return new AgentHost(
    (event) => {
      if (!delegationId) mainWindow?.webContents.send("agent:event", event);
    },
    (message, sessionKey, errorRuntimeId) => {
      if (!delegationId) {
        mainWindow?.webContents.send("agent:error", {
          message,
          __sessionId: sessionKey,
          __runtimeId: errorRuntimeId,
        });
      }
    },
    (tool, params, signal) => browserAutomation.execute(tool, params, signal, runtimeId),
    () => browserAutomation.resetAgent(runtimeId),
    diagnostics,
    (request, host) => {
      if (!delegationCoordinator) throw new Error("Delegation coordinator is not ready.");
      return delegationCoordinator.handleRequest(request, host);
    },
  );
}

/** Phase 3a：每个会话一个独立 AgentHost（各自 spawn 一个 RPC worker）。
 * 切换会话不再杀其它会话的 host，后台会话继续运行；命令按 runtimeId 路由。 */
const agentManager = new AgentManager({
  createHost: (runtimeId) => createAgentHost(runtimeId),
});
let activeAgentCwd: string | undefined;


/**
 * 应用侧"运行中会话"注册表。
 *
 * 底层 pi-coding-agent 在首条 assistant 消息出现前不写 JSONL，因此一个刚刚
 * 创建、且尚未产出 assistant 的新会话磁盘上不存在文件。`sessions:list` 若只从
 * 磁盘扫描推导，就会因为"缺文件"把这个会话从列表删除（对应 PLAN 根因 2）。
 *
 * 该注册表在 `agent:start` 创建/打开会话时登记，`sessions:list` 时把仍在运行的
 * 会话合并回磁盘索引结果，从而保证：新会话从出生起就出现在侧边栏，切走/刷新
 * 都不会因磁盘暂缺文件而消失。仅注销于显式归档（`sessions:remove`），切走不注销——
 * 这正是"列表不再丢运行中会话"的语义。
 *
 * 说明：这是壳层对 Phase 1 的实现；后续可下沉为持久化的应用自管索引
 * （参考 Proma `agent-sessions.json` 创建即写），此处先以进程内注册表止血。
 */
interface LoadedSessionEntry {
  cwd: string;
  provider?: string;
  model?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  messageCount?: number;
}

/** 超过这个时间且磁盘上仍无会话文件的登记项会被清理。 */
const LOADED_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const loadedSessions = new Map<string, LoadedSessionEntry>();

// 本会话内已删除会话的路径黑名单。双重保险：即使 loadedSessions 因清理失败残留了
// 某条目，mergeLoadedSessions 也不会再把它合成回侧边栏（避免删除后 title 退化为 cwd 名）。
// 仅用作当前会话内防呆，不持久化（删除时已同步清理 loadedSessions 与持久化文件）。
const deletedSessionPaths = new Set<string>();

// 持久化运行中会话注册表，供崩溃/重启后恢复侧边栏条目（配合 Phase 2 受保护消息
// 实现“首轮未落盘、崩溃后仍能找回”）。文件：~/.tether/loaded-sessions.json。
function loadedSessionsPath(): string {
  return path.join(getTacodeHome(), "loaded-sessions.json");
}

/** 校验并归一化单条运行中会话登记；路径必须绝对，非法条目直接丢弃。 */
function normalizeLoadedSessionEntry(
  value: unknown,
): LoadedSessionEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.cwd !== "string" || !path.isAbsolute(record.cwd))
    return undefined;
  const entry: LoadedSessionEntry = { cwd: path.normalize(record.cwd) };
  if (typeof record.provider === "string" && record.provider)
    entry.provider = record.provider;
  if (typeof record.model === "string" && record.model)
    entry.model = record.model;
  if (typeof record.title === "string" && record.title.trim())
    entry.title = record.title.trim().slice(0, 200);
  if (typeof record.createdAt === "string") entry.createdAt = record.createdAt;
  if (typeof record.updatedAt === "string") entry.updatedAt = record.updatedAt;
  if (typeof record.messageCount === "number" && Number.isFinite(record.messageCount))
    entry.messageCount = Math.max(0, Math.floor(record.messageCount));
  return entry;
}

function persistLoadedSessions(): void {
  void writeJsonAtomic(
    loadedSessionsPath(),
    Object.fromEntries(loadedSessions),
  ).catch(() => undefined);
}

/** 更新一条运行中会话登记（标题 / 消息数 / 时间），用于重启后恢复占位信息。 */
function touchLoadedSession(
  sessionKey: string | undefined,
  patch: Partial<LoadedSessionEntry>,
): void {
  if (!sessionKey) return;
  const current = loadedSessions.get(sessionKey);
  if (!current) return;
  loadedSessions.set(sessionKey, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  persistLoadedSessions();
}

async function loadLoadedSessions(): Promise<void> {
  const result = await readJsonFile<Record<string, LoadedSessionEntry>>(
    loadedSessionsPath(),
    () => ({}),
    (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const entries: Record<string, LoadedSessionEntry> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!path.isAbsolute(key)) continue;
        const entry = normalizeLoadedSessionEntry(value);
        if (entry) entries[path.normalize(key)] = entry;
      }
      return entries;
    },
  );
  noteConfigRecovered("loaded-sessions.json", result);
  let pruned = false;
  const now = Date.now();
  for (const [key, entry] of Object.entries(result.value)) {
    // 过期且磁盘上仍无会话文件的登记项：清理，避免长期运行无限累积。
    const stale = entry.updatedAt
      ? now - Date.parse(entry.updatedAt) > LOADED_SESSION_MAX_AGE_MS
      : false;
    if (stale && !fs.existsSync(key)) {
      pruned = true;
      continue;
    }
    loadedSessions.set(key, entry);
  }
  if (pruned) persistLoadedSessions();
}
let workspaceWatcher: fs.FSWatcher | undefined;
let watchedWorkspace = "";
let watchTimer: ReturnType<typeof setTimeout> | undefined;
let updateCheckStarted = false;
let appLocale: Locale = DEFAULT_LOCALE;

// A privileged scheme gives previews a real origin: storage APIs work, and the app stays cross-origin.
protocol.registerSchemesAsPrivileged([
  {
    scheme: PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

app.setName("TACode");
fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
app.setPath("userData", userDataPath);

function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(currentDirectory, "../../build/icon.png");
}

function applyDockIcon(): void {
  if (process.platform !== "darwin" || app.isPackaged) return;
  const image = nativeImage.createFromPath(appIconPath());
  if (image.isEmpty()) return;
  void app.dock?.setIcon(image);
}

async function checkForUpdates(manual = false): Promise<void> {
  if (!manual && (!app.isPackaged || updateCheckStarted)) return;
  updateCheckStarted = true;

  try {
    const update = await getLatestUpdate(app.getVersion(), (url, init) =>
      net.fetch(url, init),
    );
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;

    const icon = nativeImage.createFromPath(appIconPath());
    if (!update) {
      if (manual) {
        await dialog.showMessageBox(window, {
          type: "info",
          icon,
          title: t(appLocale, "update.title"),
          message: t(appLocale, "update.latest"),
          detail: t(appLocale, "update.currentVersion", {
            version: app.getVersion(),
          }),
          buttons: [t(appLocale, "update.ok")],
          noLink: true,
        });
      }
      return;
    }

    const result = await dialog.showMessageBox(window, {
      type: "info",
      icon,
      title: t(appLocale, "update.title"),
      message: t(appLocale, "update.available", { version: update.version }),
      detail: t(appLocale, "update.detail", { current: app.getVersion() }),
      buttons: [t(appLocale, "update.download"), t(appLocale, "update.later")],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) await shell.openExternal(update.url);
  } catch (error) {
    // Startup checks stay silent; a manual click deserves an answer.
    if (!manual || !mainWindow || mainWindow.isDestroyed()) return;
    // 超时/中止用统一文案，不把底层 AbortError 原文抛给用户。
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: t(appLocale, "update.title"),
      message: t(appLocale, "update.failed"),
      detail:
        !timedOut && error instanceof Error
          ? error.message
          : t(appLocale, "update.failedDetail"),
      buttons: [t(appLocale, "update.ok")],
      noLink: true,
    });
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: "#fafafb",
    icon: appIconPath(),
    // The Windows controls overlay always paints above page content, so dialogs could never
    // cover it. Going frameless lets the renderer draw its own buttons in normal stacking order.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 14 },
        }
      : {
          frame: false,
          // Transparent frameless windows lose the Windows resize border, and DWM rounding punches
          // the desktop through the corners, so the shell stays square with a CSS hairline instead.
          roundedCorners: false,
          hasShadow: true,
        }),
    webPreferences: {
      preload: path.join(currentDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    void checkForUpdates();
  });
  // Fullscreen hides the macOS traffic lights, so the renderer must stop reserving room for them.
  const reportFullscreen = () =>
    sendAppCommand(
      mainWindow?.isFullScreen() ? "fullscreen-on" : "fullscreen-off",
    );
  mainWindow.on("enter-full-screen", reportFullscreen);
  mainWindow.on("leave-full-screen", reportFullscreen);
  mainWindow.webContents.on("did-finish-load", reportFullscreen);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
    // Close browser popups and detached browser windows so they don't outlive the shell
    // (macOS keeps the app alive after the window closes).
    closeAllBrowserPopups();
    closeAllDetachedBrowserWindows();
    // macOS keeps the app alive after the window closes; still reap the RPC tree
    // so sandbox shells don't keep burning RAM in the background.
    void Promise.all([
      agentManager.stopAll(),
      delegationCoordinator?.stopAll() ?? Promise.resolve(),
    ]);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void mainWindow.loadURL(devServer);
  else
    void mainWindow.loadFile(
      path.join(currentDirectory, "../../dist/index.html"),
    );
}

function sendAppCommand(command: string): void {
  mainWindow?.webContents.send("app:command", command);
}

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      {
        label: t(appLocale, "menu.file"),
        submenu: [
          {
            label: t(appLocale, "menu.newThread"),
            accelerator: "CmdOrCtrl+N",
            click: () => sendAppCommand("new-thread"),
          },
          {
            label: t(appLocale, "menu.openFolder"),
            accelerator: "CmdOrCtrl+O",
            click: () => sendAppCommand("open-folder"),
          },
          { type: "separator" },
          process.platform === "darwin" ? { role: "close" } : { role: "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
    ]),
  );
}

import { registerProviderIpcHandlers, desktopProviderStatus, resolveDesktopProvider } from "./providers";

function registerIpc(): void {
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:check-update", () => checkForUpdates(true));
  ipcMain.handle("app:get-locale", () => appLocale);
  ipcMain.handle("app:config-notices", () => {
    const notices = consumeConfigNotices();
    for (const notice of notices) diagnostics.warn("config", notice);
    return notices;
  });
  ipcMain.handle(
    "app:log-diagnostic",
    (event, scope: unknown, message: unknown, details?: unknown) => {
      if (event.sender.getType() !== "window")
        throw new Error("Host renderer only");
      diagnostics.error(
        requireString(scope, "日志 scope", { maxLength: 64 }),
        requireString(message, "日志内容", { allowEmpty: true, maxLength: 500 }),
        typeof details === "string" ? details.slice(0, 4_000) : undefined,
      );
    },
  );
  ipcMain.handle("app:set-locale", async (_event, locale: unknown) => {
    if (!isLocale(locale)) throw new Error("Unsupported locale");
    await saveLocale(locale);
  });
  ipcMain.handle("app:open-external", async (_event, url: string) => {
    if (!isSafeExternalUrl(url))
      throw new Error("Only http(s) links can be opened");
    await shell.openExternal(url);
  });
  ipcMain.handle(
    "app:reveal-path",
    async (_event, skillName: string, hint?: string) => {
      if (typeof skillName !== "string" || !skillName.trim())
        throw new Error("Invalid skill name");
      await revealSkillPath(
        skillName.trim(),
        typeof hint === "string" ? hint : undefined,
      );
    },
  );
  ipcMain.handle("app:list-skills", async () =>
    listLocalSkills(activeAgentCwd),
  );

  ipcMain.handle("subagents:list", async () => loadSubagents());
  ipcMain.handle("subagents:read", async (_event, rawName: unknown) =>
    (await readUserSubagent(requireString(rawName, "子代理名称", { maxLength: 128 }))) ?? null,
  );
  ipcMain.handle("subagents:save", async (_event, rawText: unknown) =>
    saveUserSubagent(
      requireString(rawText, "子代理文档", {
        maxLength: MAX_SUBAGENT_DOCUMENT_BYTES + 4_096,
      }),
    ),
  );
  ipcMain.handle("subagents:remove", async (_event, rawName: unknown) =>
    deleteUserSubagent(requireString(rawName, "子代理名称", { maxLength: 128 })),
  );
  ipcMain.handle(
    "subagents:set-enabled",
    async (_event, rawName: unknown, rawEnabled: unknown) => {
      const name = requireString(rawName, "子代理名称", { maxLength: 128 });
      const enabled = optionalBoolean(rawEnabled, "enabled");
      if (enabled === undefined) throw new Error("无效的 enabled");
      return setSubagentEnabled(name, enabled);
    },
  );
  ipcMain.handle("subagents:reveal", async (_event, rawName?: unknown) => {
    const name = optionalString(rawName, "子代理名称", { maxLength: 128 });
    if (name) {
      const file = subagentDocumentPath(name);
      try {
        await fsp.access(file);
        shell.showItemInFolder(file);
        return;
      } catch {
        // 用户文档不存在时退回到目录。
      }
    }
    const dir = getSubagentsDir();
    await fsp.mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:toggle-maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle("window:close", () => mainWindow?.close());

  ipcMain.handle("workspace:choose", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: t(appLocale, "dialog.openWorkspace"),
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: t(appLocale, "dialog.open"),
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return recentWorkspaces.touch(result.filePaths[0]);
  });
  ipcMain.handle("workspace:recent", () => recentWorkspaces.list());
  ipcMain.handle("workspace:forget", async (_event, rawPath: unknown) => {
    const workspacePath = requireString(rawPath, "工作区路径", { maxLength: 4_096 });
    const store = new TacodeStateStore();
    try {
      await store.refresh();
      for (const thread of store.list({ cwd: workspacePath })) {
        await store.archive(thread.id);
      }
    } finally {
      store.close();
    }
    return recentWorkspaces.forget(workspacePath);
  });
  ipcMain.handle(
    "workspace:read",
    async (_event, rawPath: unknown, workspacePath?: unknown) => {
      const relativePath = requireString(rawPath, "文件路径", { maxLength: 4_096 });
      try {
        const resolved = await resolveInWorkspace(
          relativePath,
          workspacePath === undefined
            ? undefined
            : requireString(workspacePath, "工作区路径", { maxLength: 4_096 }),
        );
        // 先 stat 再按需读：超大文件只取前缀，避免整块读进主进程内存。
        const stat = await fsp.stat(resolved);
        if (stat.isDirectory()) throw new Error("这是一个目录，无法预览");
        const truncated = stat.size > IPC_LIMITS.workspaceReadBytes;
        const buffer = truncated
          ? await readFilePrefix(resolved, IPC_LIMITS.workspaceReadBytes)
          : await fsp.readFile(resolved);
        if (buffer.includes(0))
          return { path: relativePath, binary: true, content: "" };
        const text = buffer.toString("utf8");
        return {
          path: relativePath,
          binary: false,
          content: truncated
            ? `${text}\n…（文件超过 ${formatBytes(IPC_LIMITS.workspaceReadBytes)}，仅显示开头）`
            : text,
        };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return { path: relativePath, binary: false, content: "" };
        }
        throw error;
      }
    },
  );
  ipcMain.handle(
    "workspace:open",
    async (_event, rawPath: unknown, workspacePath?: unknown) => {
      const relativePath = requireString(rawPath, "文件路径", { maxLength: 4_096 });
      const error = await shell.openPath(
        await resolveInWorkspace(
          relativePath,
          workspacePath === undefined
            ? undefined
            : requireString(workspacePath, "工作区路径", { maxLength: 4_096 }),
        ),
      );
      if (error) throw new Error(error);
    },
  );
  ipcMain.handle(
    "workspace:reveal",
    async (_event, relativePath: unknown, workspacePath?: unknown) => {
      const target = requireString(relativePath, "文件路径", {
        allowEmpty: true,
        maxLength: 4_096,
      });
      shell.showItemInFolder(
        await resolveInWorkspace(
          target.trim() ? target : ".",
          workspacePath === undefined
            ? undefined
            : requireString(workspacePath, "工作区路径", { maxLength: 4_096 }),
        ),
      );
    },
  );
  ipcMain.handle(
    "workspace:restore",
    async (_event, files: unknown, workspacePath?: string) => {
      if (!Array.isArray(files)) throw new Error("Invalid restore payload");
      if (files.length > IPC_LIMITS.restoreFiles)
        throw new Error(`恢复文件过多（上限 ${IPC_LIMITS.restoreFiles} 个）`);
      // 预检全部路径：任何一条越界/不可写，都不开始写，避免“UI 已回退、磁盘只恢复一半”。
      const planned: Array<{ path: string; resolved: string; content: string | null; mode?: number }> = [];
      let plannedBytes = 0;
      for (const file of files) {
        if (!file || typeof file !== "object") continue;
        const item = file as { path?: unknown; content?: unknown; mode?: unknown };
        if (typeof item.path !== "string" || !item.path.trim()) continue;
        if (item.content !== null && typeof item.content !== "string") continue;
        if (typeof item.content === "string") {
          plannedBytes += Buffer.byteLength(item.content, "utf8");
          if (plannedBytes > IPC_LIMITS.restoreBytes)
            throw new Error(
              `恢复内容过大（上限 ${formatBytes(IPC_LIMITS.restoreBytes)}）`,
            );
        }
        const resolved = await resolveInWorkspace(item.path, workspacePath);
        planned.push({
          path: item.path,
          resolved,
          content: item.content,
          ...(typeof item.mode === "number" ? { mode: item.mode } : {}),
        });
      }
      const restored: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];
      for (const item of planned) {
        try {
          if (item.content === null) {
            await fsp.rm(item.resolved, { force: true });
          } else {
            await fsp.mkdir(path.dirname(item.resolved), { recursive: true });
            await fsp.writeFile(item.resolved, item.content, {
              encoding: "utf8",
              ...(item.mode !== undefined ? { mode: item.mode } : {}),
            });
          }
          restored.push(item.path);
        } catch (error) {
          failed.push({
            path: item.path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { restored, failed };
    },
  );
  ipcMain.handle("workspace:list", async (_event, workspacePath?: string) => {
    const root = path.resolve(
      typeof workspacePath === "string" && workspacePath
        ? workspacePath
        : (activeAgentCwd ?? ""),
    );
    if (!root) return [];
    const allowed =
      path.resolve(activeAgentCwd ?? "") === root ||
      (await recentWorkspaces.list()).some(
        (item) => path.resolve(item.path) === root,
      );
    if (!allowed) return [];
    watchWorkspace(root);
    return listWorkspaceFiles(root);
  });
  ipcMain.handle("vision:config", async () => {
    const result = await readJsonFile<Record<string, unknown>>(
      visionConfigPath(),
      () => ({
        ...DEFAULT_VISION_CONFIG,
        apiKey: process.env.ZHIPU_API_KEY?.trim() ?? "",
      }),
      (raw) =>
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : undefined,
    );
    noteConfigRecovered("vision-config.json", result);
    const store = parseVisionStore(result.value);
    const profiles = await loadChatProfiles().catch(() => undefined);
    const chatKey = profiles ? officialDeepSeekKey(profiles) : "";
    const next = store.profiles.map((item) => {
      const base = item.url.trim().replace(/\/+$/, "").replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
      if (chatKey && isDeepSeekUrl(base) && !item.apiKey.trim()) return { ...item, apiKey: chatKey };
      return item;
    });
    const snapshot = visionSnapshot(next, store.activeProfileId);
    return {
      ...snapshot,
      profiles: next,
      activeProfileId: store.activeProfileId,
      hasApiKey: Boolean(snapshot.apiKey.trim()),
    };
  });
  ipcMain.handle(
    "vision:save-config",
    async (
      _event,
      raw: unknown,
    ) => {
      const next = requireRecord(raw, "视觉配置");
      const rawProfiles = Array.isArray(next.profiles) ? next.profiles : [];
      if (rawProfiles.length > 50)
        throw new Error("自定义模型配置过多（上限 50 个）");
      const store = parseVisionStore({
        profiles: rawProfiles,
        activeProfileId: next.activeProfileId,
      });
      await writeJsonAtomic(
        visionConfigPath(),
        serializeVisionStore(store.profiles, store.activeProfileId),
      );
    },
  );
  ipcMain.handle("vision:stage", async (_event, images: string[]) => {
    const refs = Array.isArray(images)
      ? images.filter((item) => typeof item === "string" && item).slice(0, IPC_LIMITS.visionImages)
      : [];
    if (refs.length === 0) throw new Error("先上传至少一张图片");
    // 解码前按 base64 长度估算大小，避免一次性把超大图片解码进内存。
    let totalBytes = 0;
    for (const ref of refs) {
      const size = base64PayloadBytes(ref);
      if (size > IPC_LIMITS.visionImageBytes)
        throw new Error(`图片过大（上限 ${formatBytes(IPC_LIMITS.visionImageBytes)}）`);
      totalBytes += size;
    }
    if (totalBytes > IPC_LIMITS.visionTotalBytes)
      throw new Error(`图片总大小超限（上限 ${formatBytes(IPC_LIMITS.visionTotalBytes)}）`);
    const dir = visionUploadsDir();
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = Date.now();
    return Promise.all(
      refs.map(async (item, index) => {
        const match = item.match(/^data:([^;]+);base64,(.+)$/);
        const mime = match?.[1] ?? "image/png";
        const data = match?.[2] ?? item.replace(/^data:[^;]+;base64,/, "");
        const ext =
          mime.includes("jpeg") || mime.includes("jpg")
            ? "jpg"
            : mime.includes("webp")
              ? "webp"
              : mime.includes("gif")
                ? "gif"
                : "png";
        const file = path.join(dir, `${stamp}-${index + 1}.${ext}`);
        await fsp.writeFile(file, Buffer.from(data, "base64"), { mode: 0o600 });
        return file;
      }),
    );
  });

  ipcMain.handle("services:web-search", async () => parseWebSearchConfig(await readHomeJson("web-search.json")));
  ipcMain.handle(
    "services:save-web-search",
    async (_event, next: WebSearchConfig) => {
      const previous = await readHomeJson("web-search.json");
      await writeHomeJson("web-search.json", mergeWebSearchConfig(previous, parseWebSearchConfig(next)));
    },
  );
  ipcMain.handle("services:mcp", async () => parseMcpServers(await readHomeJson("mcp.json")));
  ipcMain.handle("services:save-mcp", async (_event, rows: McpServerRow[]) => {
    await writeHomeJson("mcp.json", serializeMcpServers(Array.isArray(rows) ? rows : []));
  });
  ipcMain.handle("services:reveal-mcp", async () => {
    const file = path.join(getTacodeHome(), "mcp.json");
    try {
      await fsp.access(file);
    } catch {
      await writeHomeJson("mcp.json", { mcpServers: {} });
    }
    await shell.showItemInFolder(file);
  });
  ipcMain.handle("services:deepseek-balance", async () => {
    const profiles = await loadChatProfiles();
    const chat = activeChat(profiles);
    const key = chat.apiKey;
    if (!key || !isDeepSeekUrl(chat.url)) return null;
    const response = await fetch("https://api.deepseek.com/user/balance", {
      headers: { authorization: `Bearer ${key}` },
      // 网络挂起时不要让设置页一直转圈；超时按查询失败处理。
      signal: AbortSignal.timeout(15_000),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`DeepSeek 余额查询失败（${response.status}）`);
    return parseDeepSeekBalance(payload) ?? null;
  });

  ipcMain.handle("sessions:list", async (_event, rawCwd?: unknown) => {
    const cwd =
      rawCwd === undefined
        ? undefined
        : requireString(rawCwd, "cwd", { maxLength: 4_096 });
    const threads = await listTacodeThreads(cwd ? { cwd } : {});
    const mapped = threads.map(
      (thread): SessionSummary => ({
        path: thread.sessionPath,
        storagePath: thread.storagePath,
        id: thread.id,
        cwd: thread.cwd,
        title: visionTitle(thread.title),
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        ...(thread.provider ? { provider: thread.provider } : {}),
        ...(thread.model ? { model: thread.model } : {}),
        messageCount: thread.messageCount,
        ...(thread.preview ? { preview: thread.preview } : {}),
        pinned: thread.pinned,
        archived: thread.archived,
        ...(thread.parentSessionPath ? { parentSessionPath: thread.parentSessionPath } : {}),
        ...(thread.sourceDelegationId ? { sourceDelegationId: thread.sourceDelegationId } : {}),
        ...(thread.delegationRole ? { delegationRole: thread.delegationRole } : {}),
        ...(thread.delegationStatus ? { delegationStatus: thread.delegationStatus } : {}),
        ...(thread.delegationDepth !== undefined ? { delegationDepth: thread.delegationDepth } : {}),
        ...(thread.delegationReport ? { delegationReport: thread.delegationReport } : {}),
        ...(thread.delegationError ? { delegationError: thread.delegationError } : {}),
      }),
    );
    return mergeLoadedSessions(mapped, cwd);
  });
  ipcMain.handle("sessions:remove", async (_event, rawId: unknown) => {
    const id = requireString(rawId, "会话 id", { maxLength: 256 });
    const store = new TacodeStateStore();
    try {
      await store.refresh();
      // 用 DB id 找到该会话的真实文件路径（sessionPath / storagePath），据此可靠清理
      // 运行中注册表与 host。磁盘会话的 id 是 DB 主键（非路径 basename），此前仅用
      // sessionIdFromPath 匹配会漏删，导致删除后残留合成占位（title 退化为 cwd 名，
      // 需再删一次）。这里按真实路径 + basename + cwd 多重匹配，确保一次删净。
      const thread = store.get(id);
      if (thread?.sourceDelegationId && thread.parentSessionPath) {
        await delegationCoordinator?.stop(thread.parentSessionPath, {
          delegationIds: [thread.sourceDelegationId],
        });
      }
      const targets = new Set<string>();
      if (thread) {
        if (thread.sessionPath) targets.add(thread.sessionPath);
        if (thread.storagePath) targets.add(thread.storagePath);
      }
      for (const [path, info] of loadedSessions) {
        if (
          targets.has(path) ||
          targets.has(info.cwd) ||
          sessionIdFromPath(path) === id ||
          info.cwd === id
        ) {
          loadedSessions.delete(path);
          deletedSessionPaths.add(path);
        }
      }
      // 同步清理该会话对应的 host（停止并移出注册表），避免删除后残留后台进程。
      for (const path of targets) {
        const host = agentManager.findBySession(path);
        if (host) void agentManager.stop(host.runtimeId);
      }
      persistLoadedSessions();
      await store.archive(id);
    } finally {
      store.close();
    }
  });
  ipcMain.handle(
    "sessions:pin",
    async (_event, rawId: unknown, pinned: unknown) => {
      const id = requireString(rawId, "会话 id", { maxLength: 256 });
      if (typeof pinned !== "boolean") throw new Error("无效的 pinned");
      const store = new TacodeStateStore();
      try {
        await store.refresh();
        if (!store.setPinned(id, pinned))
          throw new Error("Conversation not found");
      } finally {
        store.close();
      }
    },
  );
  ipcMain.handle(
    "sessions:rename",
    async (_event, rawId: unknown, title: unknown) => {
      const id = requireString(rawId, "会话 id", { maxLength: 256 });
      const name = requireString(title, "会话标题", { allowEmpty: true, maxLength: 512 })
        .trim()
        .slice(0, 96);
      if (!name) throw new Error("Conversation name cannot be empty");
      const store = new TacodeStateStore();
      try {
        await store.refresh();
        const thread = store.get(id);
        if (!thread) throw new Error("Conversation not found");
        await fsp.appendFile(
          thread.storagePath,
          `${JSON.stringify({
            type: "session_info",
            name,
            timestamp: new Date().toISOString(),
          })}\n`,
        );
        await store.indexSession(thread.storagePath);
        for (const [key] of loadedSessions) {
          if (
            key === thread.sessionPath ||
            key === thread.storagePath ||
            sessionIdFromPath(key) === id
          ) {
            touchLoadedSession(key, { title: name });
          }
        }
      } finally {
        store.close();
      }
    },
  );

  ipcMain.handle("auth:status", async (): Promise<ProviderStatus[]> => {
    const credentialStore = await createTacodeCredentialStore();
    const storedProviders = new Set(
      (await credentialStore.list()).map((entry) => entry.providerId),
    );
    const stored = getStoredModelSelection();
    const deepseekUrl = getStoredDeepSeekBaseUrl();
    const desktop = await desktopProviderStatus();
    const builtIn = SUPPORTED_PROVIDER_IDS.filter((id) => id !== "openai-codex").map(
      (id) => {
        const hasStore = storedProviders.has(id);
        const environmentKey = providerEnvironmentKey(id);
        const environment = Boolean(
          environmentKey && process.env[environmentKey]?.trim(),
        );
        return {
          id,
          name: providerDisplayName(id),
          configured: hasStore || environment,
          ...(hasStore
            ? { source: "stored" as const }
            : environment
              ? { source: "environment" as const }
              : {}),
          defaultModel:
            stored?.providerId === id && stored.modelId
              ? stored.modelId
              : defaultModelForProvider(id),
          ...(id === "deepseek" && deepseekUrl ? { baseUrl: deepseekUrl } : {}),
          ...(stored?.providerId === id ? { preferred: true } : {}),
        };
      },
    );
    return desktop.length ? [...desktop, ...builtIn.filter((p) => !desktop.some((service) => service.id === p.id))] : builtIn;
  });
  ipcMain.handle(
    "auth:read-api-key",
    async (_event, provider: ApiKeyProviderId) => {
      const stored = await (await createTacodeCredentialStore()).read(provider);
      if (stored && stored.type === "api_key" && typeof stored.key === "string")
        return stored.key;
      const envName = providerEnvironmentKey(provider);
      return envName ? (process.env[envName]?.trim() ?? "") : "";
    },
  );
  ipcMain.handle(
    "auth:save-api-key",
    async (
      _event,
      provider: ApiKeyProviderId,
      key: string,
      baseUrl?: string,
      model?: string,
    ) => {
      if (typeof key === "string" && key.trim())
        await saveProviderApiKey(provider, key.trim());
      if (baseUrl?.trim()) await saveDeepSeekBaseUrl(baseUrl.trim());
      if (model?.trim()) await saveDefaultModel(provider, model.trim());
    },
  );
  ipcMain.handle("auth:profiles", () => loadChatProfiles());
  ipcMain.handle("auth:save-profiles", async (_event, next: ChatProfiles) => {
    await saveChatProfiles(next);
  });
  ipcMain.handle(
    "auth:list-models",
    async (_event, baseUrl: unknown, apiKey: unknown, apiStyle?: unknown) => {
      const input = validateConnectionInput(baseUrl, apiKey, apiStyle);
      return listModels(input.baseUrl, input.apiKey, input.apiStyle);
    },
  );
  ipcMain.handle(
    "auth:logout",
    async (_event, provider: SupportedProviderId) => {
      await removeStoredProviderCredential(provider);
    },
  );

  registerProviderIpcHandlers();

  ipcMain.handle("agent:start", async (_event, rawOptions: unknown) => {
    const options = validateAgentStartOptions(rawOptions);
    const tasksDir = path.resolve(path.join(userDataPath, "tasks"));
    const cwd = options.cwd ? path.resolve(options.cwd) : tasksDir;
    await fsp.mkdir(cwd, { recursive: true });
    const {
      resume: _resume,
      sandbox: requestedSandbox,
      storagePath,
      ...startOptions
    } = options;
    let sessionPath = startOptions.sessionPath;
    let delegatedSession = false;
    if (sessionPath) {
      sessionPath = await ensureSessionRuntimeLink(
        sessionPath,
        storagePath || sessionPath,
      );
      const store = new TacodeStateStore();
      try {
        await store.refresh();
        const thread = store.findBySessionPath(sessionPath);
        delegatedSession = Boolean(thread?.sourceDelegationId);
      } finally {
        store.close();
      }
    }

    // 命中已在运行的同一会话（切回后台会话，含 openSession 的 resume=false）：
    // 直接复用，不杀不重开。不依赖 resume 标志——只要该会话已有存活 host 就复用。
    const existing = agentManager.findBySession(sessionPath);
    if (existing?.isRunning()) {
      activeAgentCwd = cwd;
      if (options.project || cwd !== tasksDir) await recentWorkspaces.touch(cwd);
      return { ...(await agentManager.resume(existing.runtimeId)), cwd: activeAgentCwd ?? cwd };
    }

    activeAgentCwd = cwd;
    if (options.project || cwd !== tasksDir) await recentWorkspaces.touch(cwd);
    const sandbox =
      cwd === tasksDir
        ? "read-only"
        : requestedSandbox === "read-only"
          ? "workspace-write"
          : requestedSandbox;
    const storedUrl =
      startOptions.provider === "deepseek"
        ? getStoredDeepSeekBaseUrl()
        : undefined;
    const rawUrl = startOptions.baseUrl ?? storedUrl;
    // Keep DeepSeek vision credentials in sync with the chat DeepSeek key/base URL.
    await syncDeepSeekVisionConfig().catch(() => undefined);
    const profiles = await loadChatProfiles();
    const maxTokens = activeCustomProfile(profiles)?.maxTokens;
    const baseUrl = rawUrl ? apiBaseUrl(rawUrl) : undefined;
    const desktopProvider = startOptions.serviceId
      ? await resolveDesktopProvider(startOptions.serviceId, startOptions.model) : undefined;
    // 每个会话独立 host：已有实例（同会话重启）则复用，否则新建，绝不停止其它会话。
    const started = await agentManager.start({
      ...startOptions,
      ...(delegatedSession ? { delegationDepth: 1 } : {}),
      ...(sessionPath ? { sessionPath } : {}),
      cwd,
      sandbox,
      visionExtension: visionExtensionPath(),
      browserExtension: path.join(currentDirectory, "../extensions/browser.js"),
      visionConfig: visionConfigPath(),
      visionUploads: visionUploadsDir(),
      ...(baseUrl ? { baseUrl } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(desktopProvider ? {
        provider: "openai" as const,
        model: desktopProvider.model,
        baseUrl: desktopProvider.config.baseUrl,
        maxTokens: undefined,
        providerExtension: path.join(currentDirectory, "../extensions/provider.js"),
        desktopProvider,
      } : {}),
    });
    const snapshot: AgentSnapshot = started;
    const host = agentManager.findRuntime(started.runtimeId);
    const file = host?.sessionKey ?? sessionPath;
    const sessionKey = file ?? sessionPath;
    // 该会话重新建立/打开：从已删除黑名单移除（曾删除后重开同名路径的会话要能再次出现）。
    if (sessionKey) deletedSessionPaths.delete(sessionKey);
    // Phase 2：兜底首轮未落盘的 user 消息。
    // - 底层 session 文件已在磁盘生成（有 assistant、已 flush）：视为接管，从运行中
    //   注册表移除（磁盘索引接管），并清空受保护消息。
    // - 尚未落盘：登记到运行中注册表（保证列表可见、崩溃后可恢复），并把缺失的 user
    //   消息合并进返回的 messages，供切回/重启后显示。
    if (sessionKey) {
      const persisted = file ? fs.existsSync(file) : false;
      if (persisted) {
        if (loadedSessions.delete(sessionKey)) persistLoadedSessions();
      } else {
        loadedSessions.set(sessionKey, {
          cwd,
          provider: startOptions.provider,
          ...(startOptions.model ? { model: startOptions.model } : {}),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        persistLoadedSessions();
      }
      const protectedMsgs = await readProtectedUserMessages(sessionKey);
      if (protectedMsgs.length) {
        if (persisted) {
          await clearProtectedUserMessages(sessionKey);
        } else {
          const existingTexts = collectUserTexts(snapshot.messages);
          const missing = protectedMsgs.filter(
            (msg) => !existingTexts.has(msg.message),
          );
          if (missing.length) {
            snapshot.messages = [
              ...missing.map((msg) => ({
                role: "user",
                content: msg.message,
                timestamp: new Date(msg.ts).toISOString(),
              })),
              ...(snapshot.messages ?? []),
            ];
          }
        }
      }
    }
    return { ...started, ...snapshot, cwd };
  });
  ipcMain.handle("agent:stop", (_event, runtimeId?: string) =>
    agentManager.stop(runtimeId),
  );
  ipcMain.handle("agent:runtimes", () => agentManager.list());
  ipcMain.handle("agent:replay", (_event, runtimeId: string, afterSeq: number) =>
    agentManager.replay(runtimeId, Number.isFinite(afterSeq) ? afterSeq : 0),
  );
  ipcMain.handle(
    "agent:command",
    async (
      _event,
      type: unknown,
      data?: unknown,
      runtimeId?: unknown,
    ) => {
      const command = requireString(type, "命令类型", { maxLength: 64 });
      if (!ALLOWED_AGENT_COMMANDS.has(command))
        throw new Error(`Unsupported agent command: ${command}`);
      const payload = data === undefined ? {} : requireRecord(data, "命令内容");
      assertPayloadLimit(payload, IPC_LIMITS.commandPayloadBytes, "命令内容");
      if (payload.message !== undefined) validatePromptMessage(payload.message);
      const handle = runtimeId === undefined ? undefined : requireString(runtimeId, "runtimeId", { maxLength: 128 });
      const host = agentManager.activeHost(handle);
      // 无活动会话是预期内竞态（会话刚停/刚切走），不是异常：返回哨兵而不是抛错，
      // 避免 Electron 把每次拒绝打印到终端；preload 会把它还原成同样的 rejection。
      if (!host) {
        diagnostics.warn("agent", "command without active session", {
          command,
          handle: handle ?? null,
        });
        return agentNoSessionResult();
      }
      // Phase 2：用户消息发出即同步落盘到受保护文件，兜底底层延迟写盘。
      // 必须先写完再发给 worker，否则最脆弱的窗口仍可能丢消息。
      if (command === "prompt" && typeof payload.message === "string") {
        try {
          await appendProtectedUserMessage(host.sessionKey, payload.message);
          recordPromptInLoadedSession(host.sessionKey, payload.message);
        } catch (error) {
          mainWindow?.webContents.send("agent:error", {
            message: `首条消息保护写入失败，重启后可能无法恢复：${
              error instanceof Error ? error.message : String(error)
            }`,
            __sessionId: host.sessionKey,
            __runtimeId: host.runtimeId,
          });
        }
      }
      try {
        return await agentManager.command(handle, command, payload);
      } catch (error) {
        // 句柄在派发前一刻失效（同一 runtime 正在 stop）也会命中同一语义。
        if (error instanceof Error && error.message === NO_ACTIVE_SESSION_MESSAGE) {
          diagnostics.warn("agent", "command lost its session before dispatch", { command });
          return agentNoSessionResult();
        }
        throw error;
      }
    },
  );
  ipcMain.handle(
    "agent:ui-response",
    (_event, id: unknown, response: unknown, runtimeId?: unknown) =>
      agentManager.respondToUi(
        runtimeId === undefined ? undefined : requireString(runtimeId, "runtimeId", { maxLength: 128 }),
        requireString(id, "请求 id", { maxLength: 256 }),
        assertPayloadLimit(requireRecord(response, "应答内容"), IPC_LIMITS.uiResponseBytes, "应答内容"),
      ),
  );
}

async function readHomeJson(name: string): Promise<unknown> {
  const result = await readJsonFile<unknown>(
    path.join(getTacodeHome(), name),
    () => ({}),
    (raw) => (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined),
  );
  noteConfigRecovered(name, result);
  return result.value;
}

async function writeHomeJson(name: string, value: unknown): Promise<void> {
  await writeJsonAtomic(path.join(getTacodeHome(), name), value);
}

async function saveDefaultModel(
  providerId: string,
  modelId: string,
): Promise<void> {
  const settings = await readSettingsFile();
  settings.defaultProvider = providerId;
  settings.defaultModel = modelId;
  await writeJsonAtomic(path.join(getTacodeHome(), "settings.json"), settings);
}

async function readSettingsFile(): Promise<Record<string, unknown>> {
  const result = await readJsonFile<Record<string, unknown>>(
    path.join(getTacodeHome(), "settings.json"),
    () => ({}),
    (raw) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined),
  );
  noteConfigRecovered("settings.json", result);
  return result.value;
}

async function loadLocale(): Promise<Locale> {
  const settings = await readSettingsFile();
  const stored = typeof settings.locale === "string" ? settings.locale : null;
  const system =
    typeof app.getPreferredSystemLanguages === "function"
      ? app.getPreferredSystemLanguages()
      : [];
  appLocale = resolveLocale(stored, system);
  return appLocale;
}

async function saveLocale(locale: Locale): Promise<void> {
  const settings = await readSettingsFile();
  settings.locale = locale;
  await writeJsonAtomic(path.join(getTacodeHome(), "settings.json"), settings);
  appLocale = locale;
  installMenu();
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

const recentFile = path.join(userDataPath, "recent-workspaces.json");

/** 最近项目是 read-modify-write，串行化避免并发 touch/forget 互相覆盖。 */
let recentWorkspacesQueue: Promise<unknown> = Promise.resolve();
function withRecentWorkspacesLock<T>(action: () => Promise<T>): Promise<T> {
  const next = recentWorkspacesQueue.then(action, action);
  recentWorkspacesQueue = next.catch(() => undefined);
  return next;
}

const recentWorkspaces = {
  async list(): Promise<WorkspaceItem[]> {
    const result = await readJsonFile<WorkspaceItem[]>(
      recentFile,
      () => [],
      (raw) =>
        Array.isArray(raw) ? raw.filter(isWorkspaceItem).slice(0, 12) : undefined,
    );
    noteConfigRecovered("recent-workspaces.json", result);
    return result.value;
  },
  touch(workspacePath: string): Promise<string> {
    return withRecentWorkspacesLock(async () => {
      const resolved = path.resolve(workspacePath);
      const stat = await fsp.stat(resolved);
      if (!stat.isDirectory())
        throw new Error("Selected workspace is not a folder");
      const current = await this.list();
      const next = [
        {
          path: resolved,
          name: path.basename(resolved) || resolved,
          lastOpenedAt: new Date().toISOString(),
        },
        ...current.filter((item) => item.path !== resolved),
      ].slice(0, 12);
      await writeJsonAtomic(recentFile, next);
      return resolved;
    });
  },
  forget(workspacePath: string): Promise<WorkspaceItem[]> {
    return withRecentWorkspacesLock(async () => {
      const next = (await this.list()).filter(
        (item) => item.path !== workspacePath,
      );
      await writeJsonAtomic(recentFile, next);
      return next;
    });
  },
};

async function servePreview(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const name = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  let target: string;
  if (url.host === UPLOADS_HOST) {
    // basename only: this host serves staged uploads, never an arbitrary path on disk.
    target = path.join(visionUploadsDir(), path.basename(name));
  } else {
    try {
      target = await resolveInWorkspace(name);
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : "Forbidden",
        { status: 403 },
      );
    }
  }
  try {
    return await net.fetch(pathToFileURL(target).toString());
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function visionConfigPath(): string {
  return path.join(userDataPath, "vision-config.json");
}

function chatProfilesPath(): string {
  return path.join(userDataPath, "chat-profiles.json");
}

async function loadChatProfiles(): Promise<ChatProfiles> {
  const result = await readJsonFile<ChatProfiles>(
    chatProfilesPath(),
    () => migrateChatProfiles({ url: "", model: "", apiKey: "" }),
    (raw) => parseChatProfiles(raw),
  );
  noteConfigRecovered("chat-profiles.json", result);
  if (result.status === "ok") return result.value;
  // 首次运行或迁移自旧的单槽位凭据。
  const stored = await (await createTacodeCredentialStore()).read("deepseek");
  const apiKey =
    stored && stored.type === "api_key" && typeof stored.key === "string"
      ? stored.key
      : "";
  const selected = getStoredModelSelection();
  return migrateChatProfiles({
    url: getStoredDeepSeekBaseUrl() ?? "",
    model: selected?.providerId === "deepseek" ? (selected.modelId ?? "") : "",
    apiKey,
  });
}

async function saveChatProfiles(next: ChatProfiles): Promise<void> {
  const merged = mergeChatProfiles(await loadChatProfiles(), next);
  await writeJsonAtomic(chatProfilesPath(), merged);
  const chat = activeChat(merged);
  if (chat.apiKey) await saveProviderApiKey("deepseek", chat.apiKey);
  if (chat.url) await saveDeepSeekBaseUrl(chat.url.replace(/\/+$/, ""));
  if (chat.model) await saveDefaultModel("deepseek", chat.model);
}

function visionUploadsDir(): string {
  return path.join(userDataPath, "uploads");
}

function visionExtensionPath(): string {
  return path.join(currentDirectory, "../extensions/vision.js");
}

async function loadVisionConfig(): Promise<VisionConfig> {
  const result = await readJsonFile<Record<string, unknown>>(
    visionConfigPath(),
    () => ({}),
    (raw) =>
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : undefined,
  );
  if (result.status !== "ok") {
    return {
      ...DEFAULT_VISION_CONFIG,
      apiKey: process.env.ZHIPU_API_KEY?.trim() ?? "",
    };
  }
  const settings = resolveVisionSettings(result.value);
  const base: VisionConfig = {
    ...settings,
    apiKey:
      typeof result.value.apiKey === "string" ? result.value.apiKey.trim() : "",
  };
  if (base.provider === "deepseek")
    return materializeDeepSeekVision(base.apiKey);
  return base;
}

async function materializeDeepSeekVision(
  fallbackKey = "",
): Promise<VisionConfig> {
  const store = await createTacodeCredentialStore();
  try {
    const profiles = await loadChatProfiles().catch(() => undefined);
    const stored = await store.read("deepseek");
    const storedKey =
      stored && stored.type === "api_key" && typeof stored.key === "string"
        ? stored.key.trim()
        : "";
    // Prefer an explicit vision key; only reuse an official DeepSeek chat key
    // (the credential slot is overwritten by whichever profile is enabled).
    const chatKey = profiles ? officialDeepSeekKey(profiles) : storedKey;
    const key =
      fallbackKey.trim() ||
      chatKey ||
      process.env.DEEPSEEK_API_KEY?.trim() ||
      "";
    return resolveVisionRuntime(
      { provider: "deepseek", endpoint: "", model: "", apiKey: "" },
      { baseUrl: DEEPSEEK_VISION_BASE, apiKey: key },
    );
  } finally {
    // Credential store may hold file handles on some backends; ignore close failures.
  }
}

async function syncDeepSeekVisionConfig(): Promise<void> {
  const current = await loadVisionConfig();
  if (current.provider !== "deepseek") return;
  const next = await materializeDeepSeekVision(current.apiKey);
  await writeJsonAtomic(visionConfigPath(), next);
}

async function resolveInWorkspace(
  relativePath: string,
  workspacePath?: string,
): Promise<string> {
  const candidate =
    typeof workspacePath === "string" && workspacePath.trim()
      ? workspacePath
      : activeAgentCwd;
  if (!candidate) throw new Error("No workspace session is active");
  const root = path.resolve(candidate);
  const allowed =
    path.resolve(activeAgentCwd ?? "") === root ||
    (await recentWorkspaces.list()).some(
      (item) => path.resolve(item.path) === root,
    );
  if (!allowed) throw new Error("Folder is not an opened project");
  const resolved = path.resolve(root, relativePath);
  if (!isPathInsideRoot(root, resolved))
    throw new Error("Path outside workspace");
  // Lexical check alone loses to symlinks (e.g. workspace/link → ~/.ssh). Re-check after realpath.
  let realRoot: string;
  try {
    realRoot = await fsp.realpath(root);
  } catch {
    throw new Error("Workspace path is not accessible");
  }
  const realPath = await realpathExistingOrJoin(resolved);
  if (!isPathInsideRoot(realRoot, realPath))
    throw new Error("Path outside workspace");
  return resolved;
}

/** realpath(target), or realpath(nearest existing ancestor) + remaining segments for create paths. */
async function realpathExistingOrJoin(target: string): Promise<string> {
  try {
    return await fsp.realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Path outside workspace");
  }
  const parts: string[] = [];
  let cursor = target;
  while (true) {
    parts.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("Path outside workspace");
    try {
      return path.join(await fsp.realpath(parent), ...parts);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Path outside workspace");
      cursor = parent;
    }
  }
}

/** 读取文件前缀（至多 maxBytes）：用于超大文件预览，避免整块读入内存。 */
async function readFilePrefix(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return Buffer.from(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

// ---------- Phase 2：应用侧受保护 user 消息（兜底底层延迟写盘） ----------
// 底层 pi-coding-agent 在首条 assistant 出现前不写 JSONL；若应用在该窗口内崩溃/
// 退出或用户显式停止该会话，已发送的 user 消息会丢失。这里由主进程在
// `agent:command("prompt")` 时把 user 消息即刻落盘到应用自有文件（受保护消息），
// 并在打开会话时把“底层尚未落盘”的受保护消息合并进返回的 messages，实现恢复。
// 一旦底层 session 文件已在磁盘上生成（即有 assistant、已 flush），即视为接管并清空。
function protectedDir(): string {
  return path.join(getTacodeHome(), "protected");
}
function protectedPath(sessionId: string): string {
  return path.join(protectedDir(), protectedMessageFileName(sessionId));
}
/** 旧版按 basename 命名的受保护文件；读取时兼容，避免升级后旧消息失联。 */
function legacyProtectedPath(sessionId: string): string {
  const safe = sessionId.split(/[\\/]/).pop() || sessionId;
  return path.join(protectedDir(), `${safe}.jsonl`);
}
async function appendProtectedUserMessage(
  sessionId: string | undefined,
  message: string | undefined,
): Promise<void> {
  if (!sessionId || !message || !message.trim()) return;
  await fsp.mkdir(protectedDir(), { recursive: true, mode: 0o700 });
  const handle = await fsp.open(protectedPath(sessionId), "a", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ message, ts: Date.now() })}\n`,
      "utf8",
    );
    // 首条消息的崩溃保护价值取决于真的落到磁盘，而不是停在页缓存。
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
async function readProtectedUserMessages(
  sessionId: string | undefined,
): Promise<Array<{ message: string; ts: number }>> {
  if (!sessionId) return [];
  let raw: string;
  try {
    raw = await fsp.readFile(protectedPath(sessionId), "utf8");
  } catch {
    try {
      raw = await fsp.readFile(legacyProtectedPath(sessionId), "utf8");
    } catch {
      return [];
    }
  }
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return typeof parsed?.message === "string"
          ? { message: parsed.message, ts: parsed.ts ?? Date.now() }
          : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is { message: string; ts: number } => x !== null);
}
async function clearProtectedUserMessages(
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId) return;
  await Promise.all([
    fsp.rm(protectedPath(sessionId), { force: true }).catch(() => undefined),
    fsp.rm(legacyProtectedPath(sessionId), { force: true }).catch(() => undefined),
  ]);
}

/** 首条 prompt 发送前同步登记：标题与消息计数在重启后仍可恢复。 */
function recordPromptInLoadedSession(
  sessionKey: string | undefined,
  message: string,
): void {
  if (!sessionKey) return;
  const current = loadedSessions.get(sessionKey);
  if (!current) return;
  const patch: Partial<LoadedSessionEntry> = {
    messageCount: (current.messageCount ?? 0) + 1,
  };
  if (!current.title) {
    const title = message.trim().split("\n")[0]?.trim().slice(0, 96);
    if (title) patch.title = title;
  }
  touchLoadedSession(sessionKey, patch);
}

/** 从底层消息里抽取 user 消息文本，用于和受保护消息去重（避免重复插入）。 */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part) =>
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => (part as { text: string }).text)
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
function collectUserTexts(messages: unknown[]): Set<string> {
  const texts = new Set<string>();
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const record = value as Record<string, unknown>;
    if (record.role !== "user") continue;
    const text = messageText(record.content);
    if (text) texts.add(text);
  }
  return texts;
}

/** 会话文件路径 → 展示用的 id（与 `upsertSessionSummary` 的推导一致）。 */
function sessionIdFromPath(file: string): string {
  return file.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") || file;
}

/** cwd → 兜底标题（首条消息标题未落盘前的占位显示）。 */
function fallbackSessionTitle(cwd: string): string {
  const leaf = cwd.split(/[\\/]/).filter(Boolean).pop();
  return leaf || "新会话";
}

/**
 * 把"仍在运行、磁盘暂缺文件"的会话合并进磁盘索引结果。
 *
 * 未落盘的新会话磁盘上没有 JSONL，`listTacodeThreads` 不会返回它；此处从
 * `loadedSessions` 注册表合成一条 `SessionSummary` 前置到列表，保证列表不丢失
 * 运行中会话（PLAN Phase 1）。已存在相同 path/storagePath 的条目不重复插入；
 * 渲染进程后续会用首次消息标题覆写 title。
 */
function mergeLoadedSessions(
  list: SessionSummary[],
  cwd?: string,
): SessionSummary[] {
  if (loadedSessions.size === 0) return list;
  const resolvedCwd = cwd ? path.resolve(cwd) : undefined;
  const present = new Set<string>();
  const presentIds = new Set<string>();
  for (const row of list) {
    present.add(row.path);
    present.add(row.storagePath);
    presentIds.add(sessionIdFromPath(row.path));
    presentIds.add(sessionIdFromPath(row.storagePath));
  }
  const extras: SessionSummary[] = [];
  for (const [file, info] of loadedSessions) {
    // 已删除会话不合成（双重保险，防 loadedSessions 清理残留）。
    if (deletedSessionPaths.has(file)) continue;
    // 已存在（按 path / storagePath / id 任一命中）则不再重复插入。
    if (present.has(file) || presentIds.has(sessionIdFromPath(file))) continue;
    // 与 `listTacodeThreads(cwd)` 语义一致：只在目标工作区下返回。
    if (resolvedCwd && info.cwd && path.resolve(info.cwd) !== resolvedCwd)
      continue;
    extras.push({
      path: file,
      storagePath: file,
      id: sessionIdFromPath(file),
      cwd: info.cwd,
      title: info.title || fallbackSessionTitle(info.cwd),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(info.provider ? { provider: info.provider } : {}),
      ...(info.model ? { model: info.model } : {}),
      messageCount: 1,
      pinned: false,
      archived: false,
    });
  }
  return extras.length > 0 ? [...extras, ...list] : list;
}

function isWorkspaceItem(value: unknown): value is WorkspaceItem {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as WorkspaceItem).path === "string" &&
    typeof (value as WorkspaceItem).name === "string" &&
    typeof (value as WorkspaceItem).lastOpenedAt === "string",
  );
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-dev",
  "dist-production",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".vite",
  ".cache",
  ".tether",
  ".build",
  "DerivedData",
  "Pods",
  "__pycache__",
  ".pnpm-store",
]);

// ponytail: one recursive fs.watch, 200ms debounce. Ceiling: skip SKIP_DIRS/dotdirs; upgrade to chokidar if events drop on Linux/network FS.
const WATCH_MAX_RETRIES = 3;
let watchRetries = 0;

function watchWorkspace(root: string): void {
  if (watchedWorkspace === root && workspaceWatcher) return;
  workspaceWatcher?.close();
  workspaceWatcher = undefined;
  watchedWorkspace = root;
  watchRetries = 0;
  startWorkspaceWatcher(root);
}

function startWorkspaceWatcher(root: string): void {
  try {
    workspaceWatcher = fs.watch(
      root,
      { persistent: false, recursive: true },
      (_event, filename) => {
        if (skipWatch(filename)) return;
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          mainWindow?.webContents.send("workspace:changed", root);
        }, 200);
      },
    );
    workspaceWatcher.on("error", () => {
      workspaceWatcher?.close();
      workspaceWatcher = undefined;
      retryWorkspaceWatcher(root);
    });
  } catch {
    workspaceWatcher = undefined;
    retryWorkspaceWatcher(root);
  }
}

/** 监听器异常后有限退避重试；仍失败则明确提示用户重新打开项目。 */
function retryWorkspaceWatcher(root: string): void {
  if (watchRetries >= WATCH_MAX_RETRIES) {
    watchedWorkspace = "";
    sendAppCommand("workspace-watch-failed");
    return;
  }
  watchRetries += 1;
  setTimeout(() => {
    if (watchedWorkspace === root && !workspaceWatcher) startWorkspaceWatcher(root);
  }, 500 * 2 ** watchRetries);
}

function skipWatch(filename: string | null): boolean {
  if (!filename) return false;
  return filename
    .replaceAll("\\", "/")
    .split("/")
    .some(
      (part) =>
        SKIP_DIRS.has(part) || (part.startsWith(".") && part !== ".agents"),
    );
}

// ponytail: dirs always complete; files capped globally + per folder so DFS doesn't starve later siblings.
async function listWorkspaceFiles(
  root: string,
  fileLimit = 8000,
  perDirLimit = 200,
): Promise<string[]> {
  const dirs: string[] = [];
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort(
      (left, right) =>
        Number(right.isDirectory()) - Number(left.isDirectory()) ||
        left.name.localeCompare(right.name),
    );
    let localFiles = 0;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        dirs.push(
          `${path.relative(root, path.join(dir, entry.name)).replaceAll("\\", "/")}/`,
        );
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (files.length >= fileLimit || localFiles >= perDirLimit) continue;
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      files.push(
        path.relative(root, path.join(dir, entry.name)).replaceAll("\\", "/"),
      );
      localFiles += 1;
    }
  }
  await walk(root);
  await addSkillManifests(root, files);
  return dirs.concat(files);
}

const SKILL_ROOTS = PROJECT_SKILL_ROOTS;

async function addSkillManifests(root: string, files: string[]): Promise<void> {
  const seen = new Set(files);
  for (const rel of SKILL_ROOTS) {
    let entries;
    try {
      entries = await fsp.readdir(path.join(root, rel), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skill = `${rel}/${entry.name}/SKILL.md`;
      try {
        await fsp.stat(path.join(root, skill));
      } catch {
        continue;
      }
      if (!seen.has(skill)) {
        files.push(skill);
        seen.add(skill);
      }
    }
  }
  for (const extra of [".agents/features.json", ".agents/progress.md"]) {
    try {
      await fsp.stat(path.join(root, extra));
    } catch {
      continue;
    }
    if (!seen.has(extra)) {
      files.push(extra);
      seen.add(extra);
    }
  }
}

app.whenReady().then(async () => {
  await initializeTacodeHome();
  delegationCoordinator = new DelegationCoordinator({
    createHost: (runtimeId, delegationId) => createAgentHost(runtimeId, delegationId),
    findParentHost: (sessionPath) => agentManager.findBySession(sessionPath),
    buildStartOptions: async (payload, definition, sessionPath) => {
      const provider = payload.provider as SupportedProviderId;
      if (!SUPPORTED_PROVIDER_IDS.includes(provider)) throw new Error(`Unsupported delegation provider: ${payload.provider}`);
      const tasksDir = path.resolve(path.join(userDataPath, "tasks"));
      const cwd = path.resolve(payload.cwd);
      await fsp.mkdir(cwd, { recursive: true });
      const sandbox = cwd === tasksDir ? "read-only" : payload.sandbox;
      const storedUrl = provider === "deepseek" ? getStoredDeepSeekBaseUrl() : undefined;
      const rawUrl = payload.baseUrl ?? storedUrl;
      await syncDeepSeekVisionConfig().catch(() => undefined);
      const profiles = await loadChatProfiles();
      const maxTokens = payload.maxTokens ?? activeCustomProfile(profiles)?.maxTokens;
      const baseUrl = rawUrl ? apiBaseUrl(rawUrl) : undefined;
      const desktopProvider = payload.serviceId
        ? await resolveDesktopProvider(payload.serviceId, definition.model?.modelId ?? payload.model)
        : undefined;
      return {
        provider,
        permission: payload.permission ?? "auto",
        sandbox: sandbox as SandboxMode,
        network: payload.network,
        cwd,
        sessionPath,
        ...(definition.model?.modelId || payload.model
          ? { model: definition.model?.modelId ?? payload.model }
          : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(maxTokens ? { maxTokens } : {}),
        ...(payload.writableRoots?.length ? { writableRoots: payload.writableRoots } : {}),
        activeTools: [...definition.tools],
        delegationDepth: 1,
        visionExtension: visionExtensionPath(),
        browserExtension: path.join(currentDirectory, "../extensions/browser.js"),
        visionConfig: visionConfigPath(),
        visionUploads: visionUploadsDir(),
        ...(desktopProvider
          ? {
              provider: "openai" as const,
              model: desktopProvider.model,
              baseUrl: desktopProvider.config.baseUrl,
              maxTokens: undefined,
              providerExtension: path.join(currentDirectory, "../extensions/provider.js"),
              desktopProvider,
            }
          : {}),
      };
    },
    emitEvent: (parentSessionPath, event) => {
      agentManager.findBySession(parentSessionPath)?.sendDelegationEvent(event);
    },
  });
  await loadLoadedSessions();
  await loadLocale();
  protocol.handle(PREVIEW_SCHEME, servePreview);
  // 统一观察主窗口、webview guest 与独立浏览器窗口的渲染进程崩溃。
  app.on("web-contents-created", (_event, contents) => {
    contents.on("render-process-gone", (_goneEvent, details) => {
      diagnostics.error(
        "renderer",
        `render process gone (${contents.getType()})`,
        { reason: details.reason, exitCode: details.exitCode },
      );
    });
  });
  registerIpc();
  registerBrowserIpc(() => mainWindow, browserAutomation);
  installMenu();
  if (process.platform === "darwin") applyDockIcon();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(async (error: unknown) => {
  // 初始化失败不再静默退出：写本地诊断并在退出前给出可操作的错误对话框。
  diagnostics.error(
    "startup",
    "TACode failed to start",
    error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error),
  );
  await diagnostics.flush();
  dialog.showErrorBox(
    "TACode 启动失败",
    `应用未能完成初始化。\n\n${error instanceof Error ? error.message : String(error)}\n\n诊断日志：${diagnostics.filePath}`,
  );
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  // Always wait for stop on quit (Cmd+Q / Dock → Quit). macOS Seatbelt shells
  // are detached; skipping this leaves orphan `sh -lc` / find / rg processes.
  event.preventDefault();
  quitting = true;
  workspaceWatcher?.close();
  closeAllBrowserPopups();
  closeAllDetachedBrowserWindows();
  Promise.all([
    agentManager.stopAll(),
    delegationCoordinator?.close() ?? Promise.resolve(),
  ])
    .catch(() => undefined)
    .finally(() => app.exit(0));
});
