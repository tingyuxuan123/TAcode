import type { Locale } from "./i18n";
import type { AgentSkillCommand } from "./skills";
import type { ModelReasoningCapabilities } from "./thinking";

/** Previews load through their own origin so page storage works without reaching the app. */
export const PREVIEW_SCHEME = "harness-preview";
export const PREVIEW_HOST = "workspace";
/** Staged image uploads live outside the workspace, so they get their own preview host. */
export const UPLOADS_HOST = "uploads";

export const PROVIDER_IDS = [
  "deepseek",
  "openai-codex",
  "openai",
  "anthropic",
  "openrouter",
  "zai",
  "kimi-coding",
  "minimax",
  "xai",
  "opencode-go",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
export type PermissionMode = "plan" | "ask" | "auto" | "full";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface WorkspaceItem {
  path: string;
  name: string;
  lastOpenedAt: string;
}

export interface SessionSummary {
  path: string;
  storagePath: string;
  id: string;
  cwd: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  model?: string;
  messageCount: number;
  preview?: string;
  pinned: boolean;
  archived: boolean;
  parentSessionPath?: string;
  sourceDelegationId?: string;
  delegationRole?: string;
  delegationStatus?: import("./delegation").DelegationStatus;
  delegationDepth?: number;
  delegationReport?: string;
  delegationError?: string;
}

/**
 * 运行中的主进程是不是「旧构建」（本地 `pnpm build`/`pnpm dev` 重建后需要完全退出重启）。
 * 由主进程比较「进程启动时间」与「bundle 磁盘 mtime」得出。
 */
export interface AppBuildStatus {
  startedAt: number;
  bundleMtimeMs?: number;
  restartRequired: boolean;
}

/** 只读会话转录（`sessions:read`）：子代理子会话在 `~/.tether/sessions/`，不在项目工作区内。 */
export interface SessionTranscript {
  sessionPath: string;
  /** 会话 JSONL 的 message 条目（与 `agent:start` 的 snapshot.messages 同一形状）。 */
  messages: unknown[];
  /** 截断前的消息总数。 */
  totalMessages: number;
  truncated: boolean;
}

export interface ProviderStatus {
  id: ProviderId;
  name: string;
  configured: boolean;
  source?: "stored" | "environment";
  defaultModel: string;
  baseUrl?: string;
  preferred?: boolean;
  /** Desktop-managed service; runtime credentials are resolved in the main process. */
  serviceId?: string;
  serviceVersion?: string;
  models?: string[];
  modelCapabilities?: ModelReasoningCapabilities[];
}

export interface AgentStartOptions {
  cwd?: string;
  project?: boolean;
  provider: ProviderId;
  serviceId?: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  effort?: string;
  permission: PermissionMode;
  sandbox: SandboxMode;
  network?: boolean;
  sessionPath?: string;
  /** Canonical partitioned transcript; used to repair a missing flat hard-link. */
  storagePath?: string;
  resume?: boolean;
  extraModels?: string[];
  /** Extra host paths merged into workspace-write sandbox (absolute). */
  writableRoots?: string[];
  /** Restrict a worker to this exact tool set; omitted keeps the runtime defaults. */
  activeTools?: string[];
  /** 子代理的轮数预算：到上限即主动收口（桥接路径由角色定义下发）。 */
  maxTurns?: number;
  /** 只读命令策略（`readonly` = exec_command 只允许白名单内的只读命令）。 */
  execPolicy?: import("./subagents").SubagentExecPolicy;
  /** Child workers use depth 1 to disable recursive delegation. */
  delegationDepth?: number;
}

export interface AgentSessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export interface AgentSnapshot {
  state: Record<string, unknown>;
  messages: unknown[];
  models: Array<ModelReasoningCapabilities & { provider: string; contextWindow?: number; input?: string[] }>;
  thinkingLevels: string[];
  stats?: AgentSessionStats;
  cwd?: string;
  skills?: AgentSkillCommand[];
}

export type AgentEvent = Record<string, unknown> & { type: string } & {
  /** Phase 3a：事件所属会话 id，渲染层据此按活动会话路由，避免后台会话污染当前视图。 */
  __sessionId?: string;
  /** 壳层分配的运行句柄；同一会话的所有事件共享它。 */
  __runtimeId?: string;
  /** 该运行句柄内单调递增的序号，用于 snapshot 回放与去重。 */
  __seq?: number;
};

export interface AgentErrorPayload {
  message: string;
  __sessionId?: string;
  __runtimeId?: string;
}

/** `agent:start` 的结果：快照 + 运行句柄 + 需要补齐的事件。 */
export interface AgentStartResult extends AgentSnapshot {
  /** 稳定运行句柄；后续 command / stop / ui-response 按它路由。 */
  runtimeId: string;
  /** 快照生成时刻的事件序号；replay 中的事件序号都大于它。 */
  lastSeq: number;
  /** snapshot 与实时事件流之间缺口的事件，渲染层先套快照再按序补齐。 */
  replay?: AgentEvent[];
}

/** 运行中会话查询结果，供渲染层重载后重新发现后台会话。
 * `running` 表示该会话是否正执行一轮生成（agent_start ~ agent_settled）；
 * worker 存活但空闲时不算「正在运行」。 */
export interface AgentRuntimeInfo {
  runtimeId: string;
  sessionKey?: string;
  requestedSessionPath?: string;
  running: boolean;
}

export type ExtensionUiRequest = {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  [key: string]: unknown;
};

export interface DesktopApi {
  platform: NodeJS.Platform;
  app: {
    version(): Promise<string>;
    /** 运行中的主进程是不是旧构建（本地重建后需要完全重启）。 */
    buildStatus(): Promise<AppBuildStatus>;
    openExternal(url: string): Promise<void>;
    revealPath(skillName: string, hint?: string): Promise<void>;
    listSkills(): Promise<Array<{ name: string; path: string }>>;
    checkUpdate(): Promise<void>;
    getLocale(): Promise<Locale>;
    setLocale(locale: Locale): Promise<void>;
    /** 启动时取走“配置已损坏、已备份并回退默认值”的提示（消费一次）。 */
    configNotices(): Promise<string[]>;
    /** 渲染层错误上报到本地诊断日志（只写本机，不上传）。 */
    logDiagnostic(scope: string, message: string, details?: string): Promise<void>;
  };
  /** Frameless windows off macOS need the renderer to drive the caption buttons. */
  window: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
  };
  workspace: {
    choose(): Promise<string | null>;
    recent(): Promise<WorkspaceItem[]>;
    forget(path: string): Promise<WorkspaceItem[]>;
    read(path: string, cwd?: string): Promise<{ path: string; content: string; binary: boolean }>;
    open(path: string, cwd?: string): Promise<void>;
    reveal(path: string, cwd?: string): Promise<void>;
    list(cwd?: string): Promise<string[]>;
    restore(files: Array<{ path: string; content: string | null; mode?: number }>, cwd?: string): Promise<{ restored: string[]; failed: Array<{ path: string; error: string }> }>;
    onChanged(listener: (root: string) => void): () => void;
  };
  vision: {
    config(): Promise<{
      provider?: "deepseek" | "custom";
      endpoint: string;
      model: string;
      apiKey: string;
      hasApiKey?: boolean;
      profiles: import("./chat-profiles").CustomApiProfile[];
      activeProfileId: string;
    }>;
    saveConfig(config: {
      profiles: import("./chat-profiles").CustomApiProfile[];
      activeProfileId: string;
    }): Promise<void>;
    stage(images: string[]): Promise<string[]>;
  };
  services: {
    webSearch(): Promise<import("./integrations").WebSearchConfig>;
    saveWebSearch(config: import("./integrations").WebSearchConfig): Promise<void>;
    mcp(): Promise<import("./integrations").McpServerRow[]>;
    saveMcp(rows: import("./integrations").McpServerRow[]): Promise<void>;
    revealMcp(): Promise<void>;
    deepseekBalance(): Promise<import("./integrations").DeepSeekBalance | null>;
  };
  sessions: {
    list(cwd?: string): Promise<SessionSummary[]>;
    /** 只读读取某个会话转录（子代理子会话在 `~/.tether/sessions/`）。 */
    read(sessionPath: string): Promise<SessionTranscript>;
    remove(id: string): Promise<void>;
    pin(id: string, pinned: boolean): Promise<void>;
    rename(id: string, title: string): Promise<void>;
  };
  /** 子代理定义管理（`~/.tether/subagents/*.md` + 启用状态）。 */
  subagents: {
    list(): Promise<{
      subagents: import("./subagents").SubagentInfo[];
      warnings: string[];
    }>;
    read(name: string): Promise<string | null>;
    save(text: string): Promise<import("./subagents").SubagentDefinition>;
    remove(name: string): Promise<boolean>;
    setEnabled(name: string, enabled: boolean): Promise<boolean>;
    reveal(name?: string): Promise<void>;
  };
  auth: {
    status(): Promise<ProviderStatus[]>;
    readApiKey(provider: Exclude<ProviderId, "openai-codex">): Promise<string>;
    saveApiKey(provider: Exclude<ProviderId, "openai-codex">, key: string, baseUrl?: string, model?: string): Promise<void>;
    listModels(baseUrl: string, apiKey: string, apiStyle?: import("./provider-presets").CatalogApiStyle): Promise<string[]>;
    profiles(): Promise<import("./chat-profiles").ChatProfiles>;
    saveProfiles(profiles: import("./chat-profiles").ChatProfiles): Promise<void>;
    logout(provider: ProviderId): Promise<void>;
  };
  agent: {
    start(options: AgentStartOptions): Promise<AgentStartResult>;
    stop(runtimeId?: string): Promise<void>;
    command<T = unknown>(type: string, data?: Record<string, unknown>, runtimeId?: string): Promise<T>;
    respondToUi(id: string, response: Record<string, unknown>, runtimeId?: string): Promise<void>;
    /** 重载后重新发现仍在运行的会话（按运行句柄）。 */
    runtimes(): Promise<AgentRuntimeInfo[]>;
    /** 取回序号大于 afterSeq 的事件，用于补齐 snapshot 与实时流之间的缺口。 */
    replay(runtimeId: string | undefined, afterSeq: number): Promise<AgentEvent[]>;
    onEvent(listener: (event: AgentEvent) => void): () => void;
    onError(listener: (payload: AgentErrorPayload) => void): () => void;
  };
  onAppCommand(listener: (command: string) => void): () => void;
  providers: {
    list(): Promise<ProviderRecord[]>;
    defaults(): Promise<{ defaultProviderId: string | null; defaultModelId: string | null }>;
    create(input: {
      name: string;
      vendorKey: string;
      baseUrl: string;
      apiStyle: import("./provider-presets").CatalogApiStyle;
      models: ProviderModelBinding[];
      defaultModelId?: string;
      apiKey?: string;
    }): Promise<ProviderRecord>;
    update(input: {
      id: string;
      name?: string;
      vendorKey?: string;
      baseUrl?: string;
      apiStyle?: import("./provider-presets").CatalogApiStyle;
      models?: ProviderModelBinding[];
      defaultModelId?: string;
      isEnabled?: boolean;
      apiKey?: string;
    }): Promise<ProviderRecord | null>;
    delete(id: string): Promise<boolean>;
    setDefault(providerId: string, modelId?: string): Promise<boolean>;
    test(id: string): Promise<{ ok: boolean; message: string }>;
    discover(input: ProviderConnection): Promise<string[]>;
    testConnection(input: ProviderConnection & { modelId: string }): Promise<{ ok: boolean; message: string }>;
  };
  /** Built-in browser (webview) panel: navigation events, downloads, data and window management. */
  browser: {
    presentationReady(requestId: string): void;
    registerTab(registration: import("./browser-tools").BrowserRegistration): Promise<void>;
    onAgentPresentation(listener: (event: import("./browser-tools").BrowserPresentation) => void): () => void;
    /** Absolute path of the guest preload used by <webview preload> (main knows the bundled path; sandboxed preloads lack __dirname). */
    webviewPreloadPath(): Promise<string>;
    /** A link/open request from a guest page should become a new in-panel tab. */
    onOpenTab(listener: (event: BrowserOpenTabEvent) => void): () => void;
    listDownloads(): Promise<BrowserDownloadItem[]>;
    onDownloadsUpdated(listener: (items: BrowserDownloadItem[]) => void): () => void;
    openDownload(id: number): Promise<boolean>;
    showDownloadInFolder(id: number): Promise<void>;
    cancelDownload(id: number): Promise<boolean>;
    clearCache(): Promise<void>;
    clearCookies(): Promise<void>;
    openDevTools(webContentsId: number): Promise<void>;
    /** Write a data:image/* URL (page screenshot) to the system clipboard. */
    writeImage(dataUrl: string): Promise<void>;
    /** Pop the browser instance out into a standalone window (tabs: active first). */
    openDetachedWindow(instanceId: string, url: string, tabs?: BrowserTabSnapshot[]): Promise<void>;
    /** Detached-window mode: restore this instance back into the main window panel. */
    restoreToMain(payload: BrowserRestorePayload): void;
    /** Main window: a detached instance is being restored back into the panel. */
    onRestoreToMain(listener: (payload: BrowserRestorePayload) => void): () => void;
    /** Main window: a detached browser window was closed without restoring. */
    onDetachedWindowClosed(listener: (payload: { instanceId: string }) => void): () => void;
  };
}

export interface BrowserTabSnapshot {
  url: string;
  title: string;
}

export interface BrowserOpenTabEvent {
  guestWebContentsId: number;
  url: string;
  /** Electron WindowOpenDisposition, e.g. foreground-tab / background-tab. */
  disposition: string;
}

export interface BrowserDownloadItem {
  id: number;
  url: string;
  filename: string;
  path: string;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  endedAt: number | null;
}

export interface BrowserRestorePayload {
  instanceId: string;
  tabs: BrowserTabSnapshot[];
}

export interface ProviderConnection {
  id?: string;
  baseUrl: string;
  apiStyle: import("./provider-presets").CatalogApiStyle;
  /** Omitted/blank when editing means reuse the existing service's credential. */
  apiKey?: string;
}

export interface ProviderModelBinding {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevels?: string[];
  supportsImages?: boolean;
}

export interface ProviderRecord {
  id: string;
  name: string;
  vendorKey: string;
  baseUrl: string;
  apiStyle: import("../shared/provider-presets").CatalogApiStyle;
  apiKeyHint?: string;
  defaultModelId?: string;
  models: ProviderModelBinding[];
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}
