/**
 * TACode Runtime 参数解析。
 *
 * 壳层参数（权限、沙箱、harness、transport、网络）由本模块消费；
 * 其余参数原样转发给 Pi 的 `main()`。转发前补齐 Pi 需要的
 * `--provider` / `--model` / `--thinking`，保证模型选择与 Tether 时代一致。
 */

import { createRequire } from "node:module";
import path from "node:path";
import { tacodeEnv } from "./env.js";
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  getStoredDeepSeekBaseUrl,
  getStoredDeepSeekMaxTokens,
  getTacodeStorageSettings,
  normalizeDeepSeekBaseUrl,
  parseMaxTokens,
  resolveMaxTokens,
} from "./settings.js";
import {
  defaultEffortForProvider,
  defaultModelForProvider,
  getStoredModelSelection,
  parseSupportedProviderId,
  type SupportedProviderId,
} from "./providers.js";

const require = createRequire(import.meta.url);

export const WEB_ACCESS_TOOLS = ["web_search", "fetch_content", "get_search_content"] as const;
export const ASK_USER_TOOL = "ask_user";

export type PermissionMode = "plan" | "ask" | "auto" | "full";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type HarnessMode = "minimal" | "safe";
export type ModelTransport = "responses" | "chat";

const PERMISSIONS: readonly PermissionMode[] = ["plan", "ask", "auto", "full"];
const SANDBOXES: readonly SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
const HARNESSES: readonly HarnessMode[] = ["minimal", "safe"];
const TRANSPORTS: readonly ModelTransport[] = ["responses", "chat"];

export interface TacodeRuntimeOptions {
  cwd: string;
  providerId: SupportedProviderId;
  baseUrl: string;
  maxTokens?: number;
  modelId: string;
  transport: ModelTransport;
  harness: HarnessMode;
  permission: PermissionMode;
  sandbox: SandboxMode;
  network: boolean;
  webSearch: boolean;
  activeTools: string[];
  toolsExplicit: boolean;
  extraModelIds: string[];
  writableRoots: string[];
  personalizationFile?: string;
}

export interface ParsedRuntimeArgs {
  options: TacodeRuntimeOptions;
  /** 转发给 Pi `main()` 的参数（含 `--mode rpc`）。 */
  piArgs: string[];
  help: boolean;
  version: boolean;
}

export function getPiWebAccessExtensionPath(): string | undefined {
  try {
    return path.dirname(require.resolve("pi-web-access/package.json"));
  } catch {
    return undefined;
  }
}

function parseWritableRoots(cwd: string, raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(path.delimiter)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => path.resolve(cwd, item)),
    ),
  ];
}

export function parseRuntimeArgs(argv: string[]): ParsedRuntimeArgs {
  const forwarded: string[] = [];
  const storedSelection = getStoredModelSelection();
  let cwd = process.cwd();
  let baseUrl =
    process.env.DEEPSEEK_BASE_URL ??
    getStoredDeepSeekBaseUrl() ??
    DEFAULT_DEEPSEEK_BASE_URL;
  let maxTokens = getStoredDeepSeekMaxTokens();
  let providerId = parseSupportedProviderId(
    tacodeEnv("PROVIDER") ?? storedSelection?.providerId ?? "deepseek",
  );
  let modelExplicit = tacodeEnv("MODEL") !== undefined;
  let modelId =
    tacodeEnv("MODEL") ??
    (storedSelection?.providerId === providerId ? storedSelection.modelId : undefined);
  let effortExplicit = tacodeEnv("EFFORT") !== undefined;
  let effort = tacodeEnv("EFFORT");
  let transport = parseTransport(tacodeEnv("TRANSPORT") ?? "responses");
  let harness = parseHarness(tacodeEnv("HARNESS") ?? "minimal");
  let permission = parsePermission(tacodeEnv("PERMISSION") ?? "auto");
  let sandbox = parseSandbox(tacodeEnv("SANDBOX") ?? "workspace-write");
  let network = false;
  let webSearch = false;
  let activeTools: string[] | undefined;
  let toolsExplicit = false;
  let writableRoots = parseWritableRoots(cwd, tacodeEnv("WRITABLE_ROOTS"));
  const personalizationFile = tacodeEnv("PERSONALIZATION_FILE")?.trim();
  let help = false;
  let version = false;
  let yolo = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = splitFlag(argument);
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const value = argv[index + 1];
      if (!value) throw new Error(`${flag} requires a value`);
      index += 1;
      return value;
    };

    if (flag === "-C" || flag === "--cwd") {
      cwd = path.resolve(takeValue());
    } else if (flag === "--provider") {
      providerId = parseSupportedProviderId(takeValue());
      if (!modelExplicit) modelId = undefined;
      if (!effortExplicit) effort = undefined;
    } else if (flag === "--base-url") {
      baseUrl = takeValue();
    } else if (flag === "--max-tokens") {
      maxTokens = parseMaxTokens(takeValue());
    } else if (flag === "--transport") {
      transport = parseTransport(takeValue());
    } else if (flag === "--harness") {
      harness = parseHarness(takeValue());
    } else if (flag === "--permission") {
      permission = parsePermission(takeValue());
    } else if (flag === "--sandbox") {
      sandbox = parseSandbox(takeValue());
    } else if (flag === "--network") {
      network = true;
    } else if (flag === "--writable-root") {
      writableRoots.push(path.resolve(cwd, takeValue()));
      writableRoots = [...new Set(writableRoots)];
    } else if (flag === "--web") {
      webSearch = true;
    } else if (flag === "--yes" || flag === "-y") {
      permission = "full";
      yolo = true;
    } else if (flag === "--effort") {
      effort = takeValue();
      effortExplicit = true;
    } else if (flag === "--model") {
      modelId = takeValue();
      modelExplicit = true;
    } else if (flag === "--tools") {
      activeTools = takeValue()
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
      toolsExplicit = true;
    } else if (flag === "--no-tools") {
      activeTools = [];
      toolsExplicit = true;
    } else if (flag === "--no-resume") {
      // Pi 默认开启持久会话，除非显式传入 --continue / --resume。
    } else if (flag === "--help" || flag === "-h") {
      help = true;
    } else if (
      flag === "--version" ||
      flag === "-V" ||
      (flag === "version" && argv.length === 1)
    ) {
      version = true;
    } else {
      forwarded.push(argument);
    }
  }

  if (yolo && !["--approve", "-a", "--no-approve", "-na"].some((flag) => hasFlag(forwarded, flag))) {
    forwarded.unshift("--approve");
  }
  if (
    getTacodeStorageSettings().historyPersistence === "none" &&
    !["--no-session", "--session", "--resume", "--continue", "--fork"].some((flag) =>
      hasFlag(forwarded, flag),
    )
  ) {
    forwarded.unshift("--no-session");
  }

  modelId ??= defaultModelForProvider(providerId);
  effort ??= defaultEffortForProvider(providerId);
  const extraModelIds = (tacodeEnv("EXTRA_MODELS") ?? tacodeEnv("HARNESS_EXTRA_MODELS") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  forwarded.unshift("--provider", providerId);
  if (!hasFlag(forwarded, "--model")) forwarded.unshift("--model", modelId);
  if (!hasFlag(forwarded, "--thinking")) forwarded.unshift("--thinking", effort);

  const webAccess = getPiWebAccessExtensionPath();
  if (webAccess && !forwarded.includes(webAccess)) forwarded.push("--extension", webAccess);

  activeTools ??= defaultActiveTools(harness);
  if (!forwarded.includes("--mode")) forwarded.unshift("--mode", "rpc");

  return {
    options: {
      cwd,
      providerId,
      baseUrl: normalizeDeepSeekBaseUrl(baseUrl),
      maxTokens: resolveMaxTokens(baseUrl, maxTokens),
      modelId,
      transport,
      harness,
      permission,
      sandbox,
      network,
      webSearch,
      activeTools,
      toolsExplicit,
      extraModelIds,
      writableRoots,
      ...(personalizationFile ? { personalizationFile: path.resolve(personalizationFile) } : {}),
    },
    piArgs: forwarded,
    help,
    version,
  };
}

export function defaultActiveTools(harness: HarnessMode): string[] {
  const delegation = Number(tacodeEnv("SUBAGENT_DEPTH") ?? "0") < 1 ? ["delegate"] : [];
  return harness === "minimal"
    ? [
        "update_plan",
        "exec_command",
        "write_stdin",
        "apply_patch",
        ...WEB_ACCESS_TOOLS,
        ASK_USER_TOOL,
        ...delegation,
      ]
    : [
        "update_plan",
        "read_file",
        "list_files",
        "search_files",
        "language_diagnostics",
        "exec_command",
        "write_stdin",
        "apply_patch",
        ...WEB_ACCESS_TOOLS,
        ASK_USER_TOOL,
        ...delegation,
      ];
}

function parseTransport(value: string): ModelTransport {
  if ((TRANSPORTS as readonly string[]).includes(value)) return value as ModelTransport;
  throw new Error(`Unsupported transport "${value}". Choose ${TRANSPORTS.join(", ")}.`);
}

function parseHarness(value: string): HarnessMode {
  if ((HARNESSES as readonly string[]).includes(value)) return value as HarnessMode;
  throw new Error(`Unsupported harness "${value}". Choose ${HARNESSES.join(", ")}.`);
}

function parsePermission(value: string): PermissionMode {
  if ((PERMISSIONS as readonly string[]).includes(value)) return value as PermissionMode;
  throw new Error(`Unsupported permission mode "${value}". Choose ${PERMISSIONS.join(", ")}.`);
}

function parseSandbox(value: string): SandboxMode {
  if ((SANDBOXES as readonly string[]).includes(value)) return value as SandboxMode;
  throw new Error(`Unsupported sandbox mode "${value}". Choose ${SANDBOXES.join(", ")}.`);
}

function splitFlag(argument: string): [string, string | undefined] {
  if (!argument.startsWith("--") || !argument.includes("=")) return [argument, undefined];
  const index = argument.indexOf("=");
  return [argument.slice(0, index), argument.slice(index + 1)];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some((argument) => argument === flag || argument.startsWith(`${flag}=`));
}
