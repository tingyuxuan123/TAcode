/**
 * 权限与沙箱策略。
 *
 * - `classifyCommand`：把 shell 命令分为 read-only / needs-approval / dangerous，
 *   用于 ask / auto 模式下决定是否需要用户确认。
 * - `commandNeedsNetwork` / `detectSandboxBoundary`：识别命令是否触及网络或沙箱边界，
 *   以便请求一次性的权限升级。
 * - `SessionAccessController`：在会话级叠加用户授予的额外权限。
 */

import type { PermissionMode, SandboxMode } from "../options.js";

export interface EffectiveAccess {
  sandbox: SandboxMode;
  network: boolean;
}

export class SessionAccessController {
  private readonly baseSandbox: SandboxMode;
  private readonly baseNetwork: boolean;
  private sessionNetwork = false;
  private sessionHost = false;

  constructor(baseSandbox: SandboxMode, baseNetwork: boolean) {
    this.baseSandbox = baseSandbox;
    this.baseNetwork = baseNetwork;
  }

  effective(permission: PermissionMode): EffectiveAccess {
    if (permission === "full") return { sandbox: "danger-full-access", network: true };
    return {
      sandbox: permission === "plan" ? "read-only" : this.baseSandbox,
      network:
        this.baseNetwork || this.baseSandbox === "danger-full-access" || this.sessionNetwork,
    };
  }

  forCommand(permission: PermissionMode, _command: string): EffectiveAccess {
    const current = this.effective(permission);
    if (permission !== "plan" && this.sessionHost) {
      return { sandbox: "danger-full-access", network: true };
    }
    return current;
  }

  grantForSession(boundary: "network" | "host"): void {
    if (boundary === "network") this.sessionNetwork = true;
    else this.sessionHost = true;
  }

  grantOnce(permission: PermissionMode, boundary: "network" | "host"): EffectiveAccess {
    const current = this.effective(permission);
    return boundary === "network"
      ? { ...current, network: true }
      : { sandbox: "danger-full-access", network: true };
  }

  describeGrants(): string[] {
    return [
      ...(this.sessionNetwork ? ["network (conversation)"] : []),
      ...(this.sessionHost ? ["host (conversation)"] : []),
    ];
  }
}

export type CommandRisk = "read-only" | "needs-approval" | "dangerous";

export function classifyCommand(command: string): CommandRisk {
  const normalized = command.trim();
  if (!normalized) return "needs-approval";
  if (
    /(^|\s)(rm|rmdir|sudo|doas|mkfs|shutdown|reboot|kill|pkill|killall)\b/i.test(normalized) ||
    /\bgit\s+(reset|clean)\b/i.test(normalized) ||
    /\bgit\s+(checkout|restore)\b[^;&|]*(--|\s)\./i.test(normalized)
  ) {
    return "dangerous";
  }
  // Shell 语法可能把看似无害的命令变成写入或命令替换，只有简单命令才自动放行。
  if (/[;&|><`$()\n\r]/.test(normalized)) return "needs-approval";
  const words = normalized.split(/\s+/);
  const executable = words[0]?.replace(/^.*\//, "") ?? "";
  if (
    words.some(
      (word) =>
        word.startsWith("/") ||
        word.startsWith("~/") ||
        word === ".." ||
        word.startsWith("../") ||
        word.includes("/../"),
    )
  ) {
    return "needs-approval";
  }
  if (["pwd", "ls", "tree", "head", "tail", "wc", "file", "stat", "which", "type"].includes(executable)) {
    return "read-only";
  }
  if (["cat", "rg", "grep"].includes(executable)) {
    return words.some((word) => word === "--files-without-match") ? "needs-approval" : "read-only";
  }
  if (executable === "find") {
    return words.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(word))
      ? "needs-approval"
      : "read-only";
  }
  if (executable === "sed") {
    return words.some((word) => word === "-i" || word.startsWith("-i")) ? "needs-approval" : "read-only";
  }
  if (executable === "git") {
    const subcommand = words[1] ?? "";
    return ["status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "grep"].includes(subcommand)
      ? "read-only"
      : "needs-approval";
  }
  return "needs-approval";
}

export function commandNeedsNetwork(command: string): boolean {
  const normalized = command.replace(/\\\n/g, " ").trim();
  if (!normalized) return false;
  return (
    /(^|[;&|]\s*)(curl|wget|ssh|scp|sftp|ftp|telnet|nc|ncat|gh)\b/i.test(normalized) ||
    /\bgit\s+(push|pull|fetch|clone|ls-remote|submodule\s+(update|sync))\b/i.test(normalized) ||
    /\b(npm|pnpm|yarn|bun)\s+(install|i|add|update|upgrade|publish|login|logout|whoami|view|info|audit)\b/i.test(
      normalized,
    ) ||
    /\b(pip|pip3)\s+install\b/i.test(normalized) ||
    /\b(cargo\s+(fetch|install|publish)|go\s+(get|install)|go\s+mod\s+download)\b/i.test(normalized) ||
    /\b(docker\s+(pull|push|login)|brew\s+(install|update|upgrade)|terraform\s+init)\b/i.test(normalized)
  );
}

export interface BoundaryProbeResult {
  running: boolean;
  exitCode?: number | null;
  output: string;
}

export function detectSandboxBoundary(
  command: string,
  result: BoundaryProbeResult,
  access: EffectiveAccess,
): "network" | "host" | undefined {
  if (result.running || result.exitCode === 0 || access.sandbox === "danger-full-access") {
    return undefined;
  }
  const output = result.output.toLocaleLowerCase("en-US");
  if (
    !access.network &&
    (commandNeedsNetwork(command) ||
      /connect to host|could not resolve host|network is unreachable|socket.*operation not permitted|failed to connect|getaddrinfo|enotfound|eai_again/.test(
        output,
      ))
  ) {
    return "network";
  }
  if (/operation not permitted|permission denied|read-only file system|sandbox violation/.test(output)) {
    return "host";
  }
  return undefined;
}

export function getStringProperty(value: unknown, key: string): string {
  if (typeof value !== "object" || value === null) return "";
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : "";
}
