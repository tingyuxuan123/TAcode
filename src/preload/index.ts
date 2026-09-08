import { contextBridge, ipcRenderer } from "electron";
import type { Locale } from "../shared/i18n";
import type { AgentEvent, DesktopApi } from "../shared/types";

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: DesktopApi = {
  platform: process.platform,
  app: {
    version: () => ipcRenderer.invoke("app:version"),
    openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
    revealPath: (skillName, hint) => ipcRenderer.invoke("app:reveal-path", skillName, hint),
    listSkills: () => ipcRenderer.invoke("app:list-skills"),
    checkUpdate: () => ipcRenderer.invoke("app:check-update"),
    getLocale: () => ipcRenderer.invoke("app:get-locale"),
    setLocale: (locale: Locale) => ipcRenderer.invoke("app:set-locale", locale),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
  },
  workspace: {
    choose: () => ipcRenderer.invoke("workspace:choose"),
    recent: () => ipcRenderer.invoke("workspace:recent"),
    forget: (workspacePath) => ipcRenderer.invoke("workspace:forget", workspacePath),
    read: (filePath, cwd) => ipcRenderer.invoke("workspace:read", filePath, cwd),
    open: (filePath, cwd) => ipcRenderer.invoke("workspace:open", filePath, cwd),
    reveal: (filePath, cwd) => ipcRenderer.invoke("workspace:reveal", filePath, cwd),
    list: (cwd) => ipcRenderer.invoke("workspace:list", cwd),
    restore: (files, cwd) => ipcRenderer.invoke("workspace:restore", files, cwd),
    onChanged: (listener) => subscribe<string>("workspace:changed", listener),
  },
  vision: {
    config: () => ipcRenderer.invoke("vision:config"),
    saveConfig: (config) => ipcRenderer.invoke("vision:save-config", config),
    stage: (images) => ipcRenderer.invoke("vision:stage", images),
  },
  services: {
    webSearch: () => ipcRenderer.invoke("services:web-search"),
    saveWebSearch: (config) => ipcRenderer.invoke("services:save-web-search", config),
    mcp: () => ipcRenderer.invoke("services:mcp"),
    saveMcp: (rows) => ipcRenderer.invoke("services:save-mcp", rows),
    revealMcp: () => ipcRenderer.invoke("services:reveal-mcp"),
    deepseekBalance: () => ipcRenderer.invoke("services:deepseek-balance"),
  },
  sessions: {
    list: (cwd) => ipcRenderer.invoke("sessions:list", cwd),
    remove: (id) => ipcRenderer.invoke("sessions:remove", id),
    pin: (id, pinned) => ipcRenderer.invoke("sessions:pin", id, pinned),
    rename: (id, title) => ipcRenderer.invoke("sessions:rename", id, title),
  },
  auth: {
    status: () => ipcRenderer.invoke("auth:status"),
    readApiKey: (provider) => ipcRenderer.invoke("auth:read-api-key", provider),
    saveApiKey: (provider, key, baseUrl, model) => ipcRenderer.invoke("auth:save-api-key", provider, key, baseUrl, model),
    listModels: (baseUrl, apiKey, apiStyle) => ipcRenderer.invoke("auth:list-models", baseUrl, apiKey, apiStyle),
    profiles: () => ipcRenderer.invoke("auth:profiles"),
    saveProfiles: (profiles) => ipcRenderer.invoke("auth:save-profiles", profiles),
    logout: (provider) => ipcRenderer.invoke("auth:logout", provider),
  },
  agent: {
    start: (options) => ipcRenderer.invoke("agent:start", options),
    stop: () => ipcRenderer.invoke("agent:stop"),
    command: (type, data) => ipcRenderer.invoke("agent:command", type, data),
    respondToUi: (id, response) => ipcRenderer.invoke("agent:ui-response", id, response),
    onEvent: (listener) => subscribe<AgentEvent>("agent:event", listener),
    onError: (listener) => subscribe<string>("agent:error", listener),
  },
  onAppCommand: (listener) => subscribe<string>("app:command", listener),
  providers: {
    list: () => ipcRenderer.invoke("providers:list"),
    defaults: () => ipcRenderer.invoke("providers:defaults"),
    create: (input) => ipcRenderer.invoke("providers:create", input),
    update: (input) => ipcRenderer.invoke("providers:update", input),
    delete: (id) => ipcRenderer.invoke("providers:delete", id),
    setDefault: (providerId, modelId) => ipcRenderer.invoke("providers:set-default", providerId, modelId),
    test: (id) => ipcRenderer.invoke("providers:test", id),
    discover: (input) => ipcRenderer.invoke("providers:discover", input),
    testConnection: (input) => ipcRenderer.invoke("providers:test-connection", input),
  },
  browser: {
    presentationReady: (requestId) => ipcRenderer.send("browser:presentation-ready", requestId),
    registerTab: (registration) => ipcRenderer.invoke("browser:register-tab", registration),
    onAgentPresentation: (listener) => subscribe("browser:agent-presentation", listener),
    // The guest preload path is resolved by the main process — sandboxed
    // preloads have no __dirname.
    webviewPreloadPath: () => ipcRenderer.invoke("browser:webview-preload-path"),
    onOpenTab: (listener) =>
      subscribe("browser:open-tab", listener),
    listDownloads: () => ipcRenderer.invoke("browser:downloads-list"),
    onDownloadsUpdated: (listener) =>
      subscribe("browser:downloads-updated", listener),
    openDownload: (id) => ipcRenderer.invoke("browser:download-open", id),
    showDownloadInFolder: (id) => ipcRenderer.invoke("browser:download-show-in-folder", id),
    cancelDownload: (id) => ipcRenderer.invoke("browser:download-cancel", id),
    clearCache: () => ipcRenderer.invoke("browser:clear-cache"),
    clearCookies: () => ipcRenderer.invoke("browser:clear-cookies"),
    openDevTools: (webContentsId) => ipcRenderer.invoke("browser:open-devtools", webContentsId),
    writeImage: (dataUrl) => ipcRenderer.invoke("browser:write-image", dataUrl),
    openDetachedWindow: (instanceId, url, tabs) =>
      ipcRenderer.invoke("browser:open-detached-window", instanceId, url, tabs),
    restoreToMain: (payload) => ipcRenderer.send("browser:restore-to-main", payload),
    onRestoreToMain: (listener) =>
      subscribe("browser:restore-to-main-broadcast", listener),
    onDetachedWindowClosed: (listener) =>
      subscribe("browser:detached-window-closed", listener),
  },
};

contextBridge.exposeInMainWorld("harness", api);
