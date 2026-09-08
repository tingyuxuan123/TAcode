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

export type AgentEvent = Record<string, unknown> & { type: string };

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
    openExternal(url: string): Promise<void>;
    revealPath(skillName: string, hint?: string): Promise<void>;
    listSkills(): Promise<Array<{ name: string; path: string }>>;
    checkUpdate(): Promise<void>;
    getLocale(): Promise<Locale>;
    setLocale(locale: Locale): Promise<void>;
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
    restore(files: Array<{ path: string; content: string | null; mode?: number }>, cwd?: string): Promise<{ restored: string[] }>;
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
    remove(id: string): Promise<void>;
    pin(id: string, pinned: boolean): Promise<void>;
    rename(id: string, title: string): Promise<void>;
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
    start(options: AgentStartOptions): Promise<AgentSnapshot>;
    stop(): Promise<void>;
    command<T = unknown>(type: string, data?: Record<string, unknown>): Promise<T>;
    respondToUi(id: string, response: Record<string, unknown>): Promise<void>;
    onEvent(listener: (event: AgentEvent) => void): () => void;
    onError(listener: (message: string) => void): () => void;
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
    onDetachedWindowClosed(listener: () => void): () => void;
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
