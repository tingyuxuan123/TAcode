/**
 * 命令类工具：`exec_command` 与 `write_stdin`。
 *
 * 命令在受管沙箱内启动，长时间运行的进程会返回 `process_id`，
 * 通过 `write_stdin` 轮询、写入或终止。
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { clipForModel } from "./files.js";
import { captureWorkspaceCheckpoint, type Checkpoint } from "./checkpoint.js";
import { ManagedProcessRegistry, type ManagedResult } from "./managed-process.js";
import {
  commandNeedsNetwork,
  detectSandboxBoundary,
  type EffectiveAccess,
  type SessionAccessController,
} from "./policy.js";
import { READONLY_EXEC_HINT, checkReadOnlyCommand } from "../../shared/readonly-commands.js";
import type { SandboxOptions } from "./sandbox.js";
import { Workspace } from "./workspace.js";
import type { PermissionMode } from "../options.js";

const execCommandParameters = Type.Object({
  cmd: Type.String({ minLength: 1, description: "Shell command to execute" }),
  yield_time_ms: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 30_000,
      description: "Return after this many milliseconds if the process is still running",
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({
      minimum: 1_000,
      maximum: 600_000,
      description: "Terminate the process after this many milliseconds",
    }),
  ),
});

const writeStdinParameters = Type.Object({
  process_id: Type.String({ minLength: 1 }),
  chars: Type.Optional(Type.String({ description: "Characters to write to stdin" })),
  yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })),
  terminate: Type.Optional(Type.Boolean({ description: "Terminate this process" })),
});

export interface CommandToolOptions {
  /** 只读策略：非空时 exec_command 只允许白名单内的只读命令（见 shared/readonly-commands）。 */
  readOnly?: boolean;
  registry: ManagedProcessRegistry;
  getPermission: () => PermissionMode;
  access: SessionAccessController;
  sandboxFor: (mode: SandboxOptions["mode"], network: boolean) => SandboxOptions;
  onAccessChanged: () => void;
  onCheckpoint: (checkpoint: Checkpoint) => void;
}

export function registerCommandTools(pi: ExtensionAPI, options: CommandToolOptions): void {
  for (const tool of createCommandTools(options))
    pi.registerTool(tool as ToolDefinition<any, any, any>);
}

/**
 * 构造命令类工具定义（不注册）。子代理委派会复用这些定义，
 * 让子代理的 exec_command 走与父会话相同的沙箱与权限路径。
 */
export function createCommandTools(options: CommandToolOptions) {
  const { registry, getPermission, access, sandboxFor, onAccessChanged, onCheckpoint, readOnly } = options;

  const execTool: ToolDefinition<typeof execCommandParameters, ManagedResult> = {
    name: "exec_command",
    label: "Execute command",
    description:
      "Run a shell command in a managed OS sandbox. Long-running commands yield a process_id for write_stdin.",
    promptSnippet:
      process.platform === "win32"
        ? "exec_command: run tests, builds, git, and other PowerShell commands in an OS sandbox"
        : "exec_command: run tests, builds, git, and other shell commands in an OS sandbox",
    promptGuidelines: [
      ...shellPromptRules(),
      "Use focused checks first, then broader validation.",
      "When a process is still running, use write_stdin with its process_id.",
    ],
    parameters: execCommandParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate, ctx) {
      if (readOnly) {
        // 只读子代理：白名单外一律拒绝，并把可用命令回给模型（避免反复重试）。
        const verdict = checkReadOnlyCommand(params.cmd);
        if (!verdict.ok) {
          const text = `Read-only subagent: ${verdict.reason}.\n${READONLY_EXEC_HINT}`;
          return {
            content: [{ type: "text", text }],
            // 形状必须与 ManagedResult 一致（工具结果类型），拒绝信息进 output。
            details: { processId: "", running: false, output: text, sandbox: "rejected (read-only)", exitCode: 126 },
            isError: true,
          };
        }
      }
      let commandAccess: EffectiveAccess = access.forCommand(getPermission(), params.cmd);
      if (!commandAccess.network && commandNeedsNetwork(params.cmd)) {
        commandAccess = await requestCommandAccess(
          "network",
          params.cmd,
          ctx,
          signal,
          getPermission(),
          commandAccess,
          access,
          onAccessChanged,
        );
      }
      let liveTimer: NodeJS.Timeout | undefined;
      const publishLive = (result: ManagedResult) => {
        if (!onUpdate || liveTimer) return;
        liveTimer = setTimeout(() => {
          liveTimer = undefined;
          onUpdate({
            content: [{ type: "text", text: formatManagedResult(result, true) }],
            details: result,
          });
        }, 250);
        liveTimer.unref?.();
      };
      const run = (current: EffectiveAccess) =>
        registry.start(params.cmd, {
          cwd: ctx.cwd,
          sandbox: sandboxFor(current.sandbox, current.network),
          yieldTimeMs: params.yield_time_ms ?? 10_000,
          timeoutMs: params.timeout_ms ?? 120_000,
          ...(signal ? { signal } : {}),
          onOutput: (partial) => publishLive(partial),
        });
      try {
        const workspace = new Workspace(ctx.cwd);
        const { checkpoint, result } = await captureWorkspaceCheckpoint(workspace, params.cmd, async () => {
          let currentResult = await run(commandAccess);
          const boundary = detectSandboxBoundary(params.cmd, currentResult, commandAccess);
          if (boundary && !(getPermission() === "plan" && boundary === "host")) {
            commandAccess = await requestCommandAccess(
              boundary,
              params.cmd,
              ctx,
              signal,
              getPermission(),
              commandAccess,
              access,
              onAccessChanged,
            );
            currentResult = await run(commandAccess);
          }
          return currentResult;
        });
        if (checkpoint && !result.running) onCheckpoint(checkpoint);
        return {
          content: [{ type: "text", text: formatManagedResult(result) }],
          details: result,
        };
      } finally {
        if (liveTimer) clearTimeout(liveTimer);
      }
    },
  };

  const writeTool: ToolDefinition<typeof writeStdinParameters, ManagedResult> = {
    name: "write_stdin",
    label: "Write to process",
    description: "Write characters to, poll, or terminate a managed process returned by exec_command.",
    promptSnippet: "write_stdin: interact with or poll a managed background process",
    parameters: writeStdinParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params) {
      const result = await registry.interact(params.process_id, {
        ...(params.chars === undefined ? {} : { chars: params.chars }),
        yieldTimeMs: params.yield_time_ms ?? 5_000,
        terminate: params.terminate ?? false,
      });
      return {
        content: [{ type: "text", text: formatManagedResult(result) }],
        details: result,
      };
    },
  };

  return [execTool, writeTool];
}

export function formatManagedResult(result: ManagedResult, live = false): string {
  const output = clipForModel(
    result.output.trimEnd() || (live ? "…" : "(no output)"),
    live ? 4_000 : 6_000,
  );
  return [
    output,
    `process_id: ${result.processId}`,
    `status: ${result.running ? "running" : "completed"}`,
    ...(result.running ? ["Use write_stdin to poll or interact."] : []),
    ...(result.exitCode === undefined ? [] : [`exit_code: ${result.exitCode}`]),
    ...(result.timedOut ? ["timed_out: true"] : []),
    `sandbox: ${result.sandbox}`,
  ].join("\n");
}

async function requestCommandAccess(
  boundary: "network" | "host",
  command: string,
  ctx: {
    hasUI: boolean;
    ui: {
      setWorkingVisible(visible: boolean): void;
      select(
        title: string,
        options: string[],
        opts?: { signal?: AbortSignal },
      ): Promise<string | undefined>;
      notify(message: string, type?: "info" | "warning" | "error"): void;
    };
  },
  signal: AbortSignal | undefined,
  permission: PermissionMode,
  current: EffectiveAccess,
  controller: SessionAccessController,
  onAccessChanged: () => void,
): Promise<EffectiveAccess> {
  if (permission === "full") return controller.effective(permission);
  if (permission === "plan" && boundary === "host") {
    throw new Error("Plan mode cannot grant write access outside the read-only sandbox.");
  }
  const boundaryLabel =
    boundary === "network"
      ? "network access"
      : "unrestricted host filesystem and network access";
  if (!ctx.hasUI) {
    throw new Error(
      `Command requires ${boundaryLabel}. Re-run with ${boundary === "network" ? "--network" : "--permission full"} for an explicitly trusted non-interactive task.`,
    );
  }
  const sandbox = `${current.sandbox}${current.network ? " + network" : ""}`;
  ctx.ui.setWorkingVisible(false);
  let choice: string | undefined;
  try {
    // 传 signal：用户点停止时该对话框会被立即取消，而不是让 worker 一直等应答
    // （abort 要等当前工具返回才能收尾，见 runtime/tools/ask-user.ts 的同款说明）。
    choice = await ctx.ui.select(
      `${boundary === "network" ? "Allow network access?" : "Allow unrestricted host access?"}\n${oneLine(command, 100)}\nCurrent: ${sandbox}`,
      ["Allow once", "Allow for this conversation", "Deny"],
      { signal },
    );
  } finally {
    ctx.ui.setWorkingVisible(true);
  }
  if (choice === "Allow once") return controller.grantOnce(permission, boundary);
  if (choice === "Allow for this conversation" || choice === "Allow this command for this session") {
    controller.grantForSession(boundary);
    onAccessChanged();
    ctx.ui.notify(`${boundaryLabel} allowed for this conversation.`, "warning");
    return controller.forCommand(permission, command);
  }
  if (signal?.aborted) throw new Error("Command cancelled.");
  throw new Error(`User denied ${boundaryLabel} for: ${oneLine(command, 120)}`);
}

function oneLine(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function shellPromptRules(platform = process.platform): string[] {
  if (platform === "win32") {
    return [
      "- exec_command is Windows PowerShell. Write PowerShell (Get-ChildItem, Get-Content, Set-Location, Select-String, `$env:NAME = 'value'`, chain with `;`). Search with search_files.",
    ];
  }
  return ["- exec_command is the host POSIX shell. Prefer rg / rg --files for search."];
}
