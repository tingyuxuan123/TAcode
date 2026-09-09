/**
 * 命令沙箱后端。
 *
 * macOS 用 Seatbelt（sandbox-exec），其他平台可配置 Docker 镜像；
 * 没有可用后端时显式报错，而不是静默降级为宿主权限。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tacodeEnv } from "../env.js";
import { stripModelCredentialEnvironment } from "../providers.js";
import { killProcessTree, trackDetachedChild } from "./process-tree.js";
import type { SandboxMode } from "../options.js";

export interface SandboxOptions {
  mode: SandboxMode;
  network: boolean;
  writableRoots?: string[];
}

export interface CommandInvocation {
  command: string;
  args: string[];
  description: string;
}

export function hostShellCommand(shellCommand: string): CommandInvocation {
  if (process.platform === "win32") {
    const shell = resolveWindowsPowerShell();
    return {
      command: shell,
      args: ["-NoProfile", "-NonInteractive", "-Command", shellCommand],
      description: `Windows host (${path.basename(shell)})`,
    };
  }
  const shell = process.env.SHELL ?? "/bin/sh";
  return { command: shell, args: ["-lc", shellCommand], description: "host" };
}

export function sandboxCommand(
  shellCommand: string,
  cwd: string,
  options: SandboxOptions,
): CommandInvocation {
  if (options.mode === "danger-full-access") return hostShellCommand(shellCommand);

  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    const shell = process.env.SHELL ?? "/bin/sh";
    const workspace = fs.realpathSync(cwd);
    const temporary = fs.realpathSync(os.tmpdir());
    const extra = (options.writableRoots ?? [])
      .map((root) => {
        try {
          return fs.realpathSync(root);
        } catch {
          return undefined;
        }
      })
      .filter((root): root is string => Boolean(root));
    const writable =
      options.mode === "workspace-write"
        ? [...new Set([workspace, temporary, "/dev/null", "/dev/tty", ...extra])]
        : ["/dev/null", "/dev/tty"];
    const rules = [
      "(version 1)",
      "(allow default)",
      writable.length === 0
        ? "(deny file-write*)"
        : `(deny file-write* (require-not (require-any ${writable
            .map((directory) => `(subpath "${escapeSeatbelt(directory)}")`)
            .join(" ")})))`,
      options.network ? "" : '(deny network*) (allow network* (local ip "localhost:*"))',
      // 防止 kill/pkill 波及 Electron 主进程或开发服务器。
      "(deny signal)",
      "(allow signal (target self))",
    ]
      .filter(Boolean)
      .join(" ");
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", rules, shell, "-lc", shellCommand],
      description: `macOS Seatbelt (${options.mode}${options.network ? ", network" : ", no network"})`,
    };
  }

  const image = tacodeEnv("SANDBOX_IMAGE");
  if (image && commandExists("docker")) {
    const networkArgs = options.network ? [] : ["--network", "none"];
    const userArgs =
      typeof process.getuid === "function" && typeof process.getgid === "function"
        ? ["--user", `${process.getuid()}:${process.getgid()}`]
        : [];
    const mount = options.mode === "read-only" ? `${cwd}:/workspace:ro` : `${cwd}:/workspace`;
    const readOnlyArgs =
      options.mode === "read-only"
        ? ["--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m"]
        : [];
    return {
      command: "docker",
      args: [
        "run",
        "--rm",
        "-i",
        ...userArgs,
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "512",
        ...networkArgs,
        ...readOnlyArgs,
        "-v",
        mount,
        "-w",
        "/workspace",
        image,
        "/bin/sh",
        "-lc",
        shellCommand,
      ],
      description: `Docker ${image} (${options.mode}${options.network ? ", network" : ", no network"})`,
    };
  }

  throw new Error(
    `No OS sandbox backend is available for ${options.mode}. ` +
      "Install macOS sandbox-exec, or set TACODE_SANDBOX_IMAGE to a trusted Docker image. " +
      "Use --sandbox danger-full-access only for a trusted workspace.",
  );
}

export function sandboxDescription(options: SandboxOptions): string {
  if (options.mode === "danger-full-access") return "host access";
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) {
    return `Seatbelt ${options.mode}${options.network ? " + network" : ""}`;
  }
  if (tacodeEnv("SANDBOX_IMAGE") && commandExists("docker")) {
    return `Docker ${options.mode}${options.network ? " + network" : ""}`;
  }
  return `unavailable (${options.mode})`;
}

export interface ExecuteSandboxedOptions {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  signal?: AbortSignal;
  onData: (chunk: Buffer) => void;
}

export function executeSandboxedCommand(
  shellCommand: string,
  cwd: string,
  sandbox: SandboxOptions,
  options: ExecuteSandboxedOptions,
): Promise<{ exitCode: number | null }> {
  const invocation = sandboxCommand(shellCommand, cwd, sandbox);
  return new Promise((resolve, reject) => {
    const environment = stripModelCredentialEnvironment({ ...(options.env ?? process.env) });
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackDetachedChild(child);
    let settled = false;
    const stop = () => {
      if (child.killed || child.pid === undefined) return;
      killProcessTree(child.pid, "SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
          killProcessTree(child.pid, "SIGKILL");
        }
      }, 1_500).unref();
    };
    const timer =
      options.timeout === undefined
        ? undefined
        : setTimeout(stop, Math.max(1, options.timeout));
    timer?.unref();
    const abort = () => stop();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout?.on("data", options.onData);
    child.stderr?.on("data", options.onData);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({ exitCode });
    });
  });
}

function escapeSeatbelt(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function commandExists(command: string): boolean {
  const pathValue = process.env.PATH ?? "";
  return pathValue
    .split(path.delimiter)
    .some((directory) => fs.existsSync(path.join(directory, command)));
}

function resolveWindowsPowerShell(): string {
  const configured = tacodeEnv("SHELL")?.trim();
  if (configured) return configured;
  for (const executable of ["pwsh.exe", "powershell.exe"]) {
    const resolved = findExecutableOnPath(executable);
    if (resolved) return resolved;
  }
  return "powershell.exe";
}

function findExecutableOnPath(executable: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
