/**
 * IPC 与网络边界的运行时校验。
 *
 * TypeScript 类型在 IPC 上只是编译期断言，渲染进程（或调试工具）可以发送任意
 * payload。这里集中做“不信任输入”的校验与统一上限，超限直接抛出可理解的中文
 * 错误，避免把超大内容读进主进程内存或转交给 worker。
 */

import type { AgentStartOptions } from "../shared/types";

/** 各 IPC 入口的统一上限（字节数按 UTF-8 计算）。 */
export const IPC_LIMITS = {
  /** 单条 user prompt。 */
  promptBytes: 1_000_000,
  /** 单次 agent 命令 payload（含 data URL 图片等）。 */
  commandPayloadBytes: 32 * 1024 * 1024,
  /** agent:ui-response 单次应答。 */
  uiResponseBytes: 1_000_000,
  /** workspace:restore 单批文件数。 */
  restoreFiles: 500,
  /** workspace:restore 单批内容总字节数。 */
  restoreBytes: 64 * 1024 * 1024,
  /** workspace:read 单次读取上限；超出只返回前缀并标记截断。 */
  workspaceReadBytes: 4 * 1024 * 1024,
  /** 视觉图片：张数、单张、总量。 */
  visionImages: 4,
  visionImageBytes: 10 * 1024 * 1024,
  visionTotalBytes: 24 * 1024 * 1024,
  /** 供应商地址与密钥长度上限。 */
  urlLength: 2_048,
  apiKeyLength: 8_192,
  /** RPC stdout 单行 JSON 上限；超长行丢弃并报错，避免缓冲无界增长。 */
  rpcLineBytes: 8 * 1024 * 1024,
  /** 浏览器标签快照与截图数据的数量/大小上限。 */
  browserTabs: 100,
  browserImageBytes: 20 * 1024 * 1024,
} as const;

function invalid(label: string): Error {
  return new Error(`无效的 ${label}`);
}

/** 非空（或允许空）字符串；带可选长度上限。 */
export function requireString(
  value: unknown,
  label: string,
  options: { maxLength?: number; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") throw invalid(label);
  if (!options.allowEmpty && !value.trim()) throw invalid(label);
  if (options.maxLength !== undefined && value.length > options.maxLength)
    throw new Error(`${label}过长（上限 ${options.maxLength} 个字符）`);
  return value;
}

/** 可选字符串：缺省返回 undefined，出现但不是字符串则报错。 */
export function optionalString(
  value: unknown,
  label: string,
  options: { maxLength?: number; allowEmpty?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, label, options);
}

export function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(label);
  return value;
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalid(label);
  return value;
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(label);
  return value as Record<string, unknown>;
}

/** 字符串数组（过滤空串），带数量与单项长度上限。 */
export function optionalStringArray(
  value: unknown,
  label: string,
  options: { maxItems?: number; maxItemLength?: number } = {},
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw invalid(label);
  if (options.maxItems !== undefined && value.length > options.maxItems)
    throw new Error(`${label}数量过多（上限 ${options.maxItems} 项）`);
  return value.map((item, index) =>
    requireString(item, `${label}[${index}]`, {
      maxLength: options.maxItemLength,
    }),
  );
}

/** 字符串的 UTF-8 字节数。 */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** 校验单个字符串的字节上限。 */
export function assertByteLimit(value: string, maxBytes: number, label: string): string {
  const size = byteLength(value);
  if (size > maxBytes)
    throw new Error(`${label}过大（${formatBytes(size)}，上限 ${formatBytes(maxBytes)}）`);
  return value;
}

/** JSON 序列化后的近似字节数；不可序列化时返回 0。 */
export function payloadByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : byteLength(json);
  } catch {
    return 0;
  }
}

/** 校验整个 IPC payload 的字节上限。 */
export function assertPayloadLimit<T>(value: T, maxBytes: number, label: string): T {
  const size = payloadByteLength(value);
  if (size > maxBytes)
    throw new Error(`${label}过大（${formatBytes(size)}，上限 ${formatBytes(maxBytes)}）`);
  return value;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 把已知凭据从日志/错误文本里抹掉。空串与极短串不参与替换，避免误伤正常文本。
 */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let next = text;
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (!trimmed || trimmed.length < 8) continue;
    next = next.split(trimmed).join("[REDACTED]");
  }
  return next;
}

/** data URL 或裸 base64 的负载字节数（解码前按 4/3 估算，避免真的解码）。 */
export function base64PayloadBytes(value: string): number {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  const payload = comma >= 0 ? value.slice(comma + 1) : value;
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

const PERMISSION_MODES = new Set(["plan", "ask", "auto", "full"]);
const SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

/** `agent:start` 的输入校验：字段类型、枚举与长度上限。 */
export function validateAgentStartOptions(value: unknown): AgentStartOptions {
  const record = requireRecord(value, "启动参数");
  const provider = requireString(record.provider, "provider", { maxLength: 64 });
  const permission = requireString(record.permission, "permission", { maxLength: 32 });
  if (!PERMISSION_MODES.has(permission)) throw invalid("权限模式");
  const sandbox = requireString(record.sandbox, "sandbox", { maxLength: 32 });
  if (!SANDBOX_MODES.has(sandbox)) throw invalid("沙箱模式");
  const maxTokens = optionalNumber(record.maxTokens, "maxTokens");
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > 1_000_000))
    throw invalid("maxTokens");

  return {
    provider: provider as AgentStartOptions["provider"],
    permission: permission as AgentStartOptions["permission"],
    sandbox: sandbox as AgentStartOptions["sandbox"],
    ...(optionalString(record.cwd, "cwd", { maxLength: 4_096 }) ? { cwd: record.cwd as string } : {}),
    ...(optionalBoolean(record.project, "project") !== undefined ? { project: record.project as boolean } : {}),
    ...(optionalString(record.serviceId, "serviceId", { maxLength: 128 }) ? { serviceId: record.serviceId as string } : {}),
    ...(optionalString(record.model, "model", { maxLength: 200 }) ? { model: record.model as string } : {}),
    ...(optionalString(record.baseUrl, "baseUrl", { maxLength: IPC_LIMITS.urlLength }) ? { baseUrl: record.baseUrl as string } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(optionalString(record.effort, "effort", { maxLength: 64 }) ? { effort: record.effort as string } : {}),
    ...(optionalBoolean(record.network, "network") !== undefined ? { network: record.network as boolean } : {}),
    ...(optionalString(record.sessionPath, "sessionPath", { maxLength: 4_096 }) ? { sessionPath: record.sessionPath as string } : {}),
    ...(optionalString(record.storagePath, "storagePath", { maxLength: 4_096 }) ? { storagePath: record.storagePath as string } : {}),
    ...(optionalBoolean(record.resume, "resume") !== undefined ? { resume: record.resume as boolean } : {}),
    ...(optionalStringArray(record.extraModels, "extraModels", { maxItems: 200, maxItemLength: 200 }) ? { extraModels: record.extraModels as string[] } : {}),
    ...(optionalStringArray(record.writableRoots, "writableRoots", { maxItems: 64, maxItemLength: 4_096 }) ? { writableRoots: record.writableRoots as string[] } : {}),
  };
}

/** 单条 user prompt：必须是字符串且不超过字节上限。 */
export function validatePromptMessage(value: unknown): string {
  return assertByteLimit(
    requireString(value, "prompt", { allowEmpty: true }),
    IPC_LIMITS.promptBytes,
    "prompt",
  );
}

/** 供应商地址与密钥的统一校验（模型发现 / 连接测试共用）。 */
export function validateConnectionInput(
  baseUrl: unknown,
  apiKey: unknown,
  apiStyle: unknown,
): { baseUrl: string; apiKey: string; apiStyle?: string } {
  return {
    baseUrl: requireString(baseUrl, "API URL", { maxLength: IPC_LIMITS.urlLength }),
    apiKey: requireString(apiKey, "API Key", {
      maxLength: IPC_LIMITS.apiKeyLength,
      allowEmpty: true,
    }),
    ...(apiStyle === undefined || apiStyle === null
      ? {}
      : { apiStyle: requireString(apiStyle, "接口格式", { maxLength: 64 }) }),
  };
}
