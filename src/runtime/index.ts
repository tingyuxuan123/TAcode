/**
 * TACode Agent Runtime 公共入口（主进程使用）。
 *
 * 这里导出的是桌面壳需要的存储/凭据/目录能力；真正的 Agent 循环由
 * `rpc-entry.ts` 以子进程方式运行 Pi。
 */

export { tacodeEnv } from "./env.js";
export {
  getTacodeHome,
  getTacodeSessionsDir,
  getTacodeArchivedSessionsDir,
  initializeTacodeHome,
  partitionSessionFile,
  partitionExistingSessions,
  ensureSessionRuntimeLink,
  type PartitionedSessionPath,
} from "./home.js";
export {
  SUPPORTED_PROVIDER_IDS,
  MODEL_CREDENTIAL_ENV_KEYS,
  defaultEffortForProvider,
  defaultModelForProvider,
  getStoredModelSelection,
  isSupportedProviderId,
  parseSupportedProviderId,
  providerDisplayName,
  providerEnvironmentKey,
  stripModelCredentialEnvironment,
  type StoredModelSelection,
  type SupportedProviderId,
} from "./providers.js";
export {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEEPSEEK_CONTEXT_WINDOW,
  DEEPSEEK_MAX_TOKENS,
  getStoredDeepSeekBaseUrl,
  getStoredDeepSeekMaxTokens,
  getTacodeSettingsPath,
  getTacodeStorageSettings,
  normalizeDeepSeekBaseUrl,
  parseCredentialStoreMode,
  parseHistoryPersistence,
  parseMaxTokens,
  resolveMaxTokens,
  saveDeepSeekBaseUrl,
  saveDeepSeekMaxTokens,
  type CredentialStoreMode,
  type HistoryPersistence,
  type TacodeStorageSettings,
} from "./settings.js";
export {
  FileCredentialStore,
  KeyringCredentialStore,
  createTacodeCredentialStore,
  installTacodeCredentialStore,
  type CreateCredentialStoreOptions,
  type TacodeKeyringFactory,
} from "./credential-store.js";
export {
  getTacodeAgentDir,
  getTacodeAuthPath,
  ensureProviderConfigured,
  hasDeepSeekEnvironmentKey,
  hasStoredDeepSeekKey,
  hasStoredProviderCredential,
  removeStoredDeepSeekKey,
  removeStoredProviderCredential,
  saveDeepSeekKey,
  saveProviderApiKey,
  type ApiKeyProviderId,
} from "./auth.js";
export {
  TacodeStateStore,
  getTacodeStatePath,
  indexTacodeSession,
  listTacodeThreads,
  type ListThreadOptions,
  type TacodeThread,
} from "./state.js";
export { getTacodeRpcEntryPath } from "./rpc-client.js";
export {
  ASK_USER_TOOL,
  WEB_ACCESS_TOOLS,
  defaultActiveTools,
  getPiWebAccessExtensionPath,
  parseRuntimeArgs,
  type HarnessMode,
  type ModelTransport,
  type ParsedRuntimeArgs,
  type PermissionMode,
  type SandboxMode,
  type TacodeRuntimeOptions,
} from "./options.js";
