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
import { commandBaseName, splitCommandSegments } from "./command-lint.js";
import { READONLY_EXEC_HINT, checkReadOnlyCommand } from "../../shared/readonly-commands.js";
import type { SandboxOptions } from "./sandbox.js";
import { Workspace } from "./workspace.js";
import type { PermissionMode } from "../options.js";

/**
 * 参数区间。schema 里不再写 min/max：Pi 的校验只回「must be <= 600000」，
 * 不回显传入值。这里自己校验/夹取，才能给出「传入值 + 允许区间 + 常用组合」。
 */
export const YIELD_TIME_LIMIT: { min: number; max: number; fallback: number } = {
  min: 0,
  max: 30_000,
  fallback: 10_000,
};
export const EXEC_TIMEOUT_LIMIT: { min: number; max: number; fallback: number } = {
  min: 1_000,
  max: 600_000,
  fallback: 120_000,
};

const LONG_TASK_HINT =
  "Long tasks: timeout_ms=600000 (the maximum) with yield_time_ms=30000, then poll the returned process_id with write_stdin.";

export function describeExecLimits(): string {
  return [
    `yield_time_ms: ${YIELD_TIME_LIMIT.min}–${YIELD_TIME_LIMIT.max} (default ${YIELD_TIME_LIMIT.fallback})`,
    `timeout_ms: ${EXEC_TIMEOUT_LIMIT.min}–${EXEC_TIMEOUT_LIMIT.max} (default ${EXEC_TIMEOUT_LIMIT.fallback})`,
    LONG_TASK_HINT,
  ].join("\n");
}

export type YieldNormalization =
  | { ok: true; value: number; notes: string[] }
  | { ok: false; message: string };

/** 校验并夹取 yield_time_ms：超上限夹取并显式说明，非法值才报错。 */
export function normalizeYieldTimeMs(value: unknown): YieldNormalization {
  if (value === undefined || value === null) {
    return { ok: true, value: YIELD_TIME_LIMIT.fallback, notes: [] };
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return {
      ok: false,
      message: [
        `Invalid parameter: yield_time_ms=${JSON.stringify(value)} is not an integer number of milliseconds.`,
        describeExecLimits(),
      ].join("\n"),
    };
  }
  if (value < YIELD_TIME_LIMIT.min) {
    return {
      ok: false,
      message: [
        `Invalid parameter: yield_time_ms=${value} is below the minimum ${YIELD_TIME_LIMIT.min} ms.`,
        describeExecLimits(),
      ].join("\n"),
    };
  }
  if (value > YIELD_TIME_LIMIT.max) {
    return {
      ok: true,
      value: YIELD_TIME_LIMIT.max,
      notes: [
        `note: yield_time_ms=${value} exceeds the maximum ${YIELD_TIME_LIMIT.max} ms and was clamped to ${YIELD_TIME_LIMIT.max}.`,
        `note: ${LONG_TASK_HINT}`,
      ],
    };
  }
  return { ok: true, value, notes: [] };
}

export type ExecParamsNormalization =
  | { ok: true; yieldTimeMs: number; timeoutMs: number; notes: string[] }
  | { ok: false; message: string };

/** 把 exec_command 的 yield/timeout 归一化，并把实际生效值与提示一起交给调用方。 */
export function normalizeExecParams(params: {
  yield_time_ms?: unknown;
  timeout_ms?: unknown;
}): ExecParamsNormalization {
  const yieldResult = normalizeYieldTimeMs(params.yield_time_ms);
  if (!yieldResult.ok) return { ok: false, message: yieldResult.message };
  const notes = [...yieldResult.notes];
  const rawTimeout = params.timeout_ms;
  let timeoutMs = EXEC_TIMEOUT_LIMIT.fallback;
  if (rawTimeout !== undefined && rawTimeout !== null) {
    if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout)) {
      return {
        ok: false,
        message: [
          `Invalid parameter: timeout_ms=${JSON.stringify(rawTimeout)} is not an integer number of milliseconds.`,
          describeExecLimits(),
        ].join("\n"),
      };
    }
    if (rawTimeout < EXEC_TIMEOUT_LIMIT.min) {
      return {
        ok: false,
        message: [
          `Invalid parameter: timeout_ms=${rawTimeout} is below the minimum ${EXEC_TIMEOUT_LIMIT.min} ms.`,
          describeExecLimits(),
        ].join("\n"),
      };
    }
    if (rawTimeout > EXEC_TIMEOUT_LIMIT.max) {
      timeoutMs = EXEC_TIMEOUT_LIMIT.max;
      notes.push(
        `note: timeout_ms=${rawTimeout} exceeds the maximum ${EXEC_TIMEOUT_LIMIT.max} ms and was clamped to ${EXEC_TIMEOUT_LIMIT.max}.`,
      );
    } else {
      timeoutMs = rawTimeout;
    }
  }
  return { ok: true, yieldTimeMs: yieldResult.value, timeoutMs, notes };
}

/** 列出本会话已知的受管进程，用于 process_id 缺失时的纠正提示。 */
export function describeKnownProcesses(registry: ManagedProcessRegistry): string {
  const entries = registry.list();
  if (!entries.length) return "No managed processes are known in this session. Run exec_command first.";
  return entries
    .map(
      (entry) =>
        `${entry.processId} — ${entry.running ? "running" : `finished${entry.exitCode === undefined ? "" : ` (exit ${entry.exitCode})`}`} — ${oneLine(entry.command, 90)}`,
    )
    .join("\n");
}

const execCommandParameters = Type.Object({
  cmd: Type.String({ minLength: 1, description: "Shell command to execute" }),
  yield_time_ms: Type.Optional(
    Type.Integer({
      description:
        "Return after this many milliseconds if the process is still running (0-30000; larger values are clamped). Default 10000.",
    }),
  ),
  timeout_ms: Type.Optional(
    Type.Integer({
      description:
        "Terminate the process after this many milliseconds (1000-600000; larger values are clamped). Default 120000.",
    }),
  ),
});

const writeStdinParameters = Type.Object({
  process_id: Type.Optional(
    Type.String({ minLength: 1, description: "process_id returned by exec_command (required)" }),
  ),
  chars: Type.Optional(Type.String({ description: "Characters to write to stdin" })),
  yield_time_ms: Type.Optional(
    Type.Integer({
      description: "Wait this long for new output (0-30000; larger values are clamped). Default 5000.",
    }),
  ),
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
      const normalized = normalizeExecParams(params);
      if (!normalized.ok) return rejectCommandResult(normalized.message, params.cmd, "rejected (invalid parameters)");
      if (readOnly) {
        // 只读子代理：白名单外一律拒绝，并把可用命令回给模型（避免反复重试）。
        const verdict = checkReadOnlyCommand(params.cmd);
        if (!verdict.ok) {
          const text = `Read-only subagent: ${verdict.reason}.\n${READONLY_EXEC_HINT}`;
          return rejectCommandResult(text, params.cmd, "rejected (read-only)", 126);
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
            content: [{ type: "text", text: formatManagedResult(result, true, normalized.notes) }],
            details: result,
          });
        }, 250);
        liveTimer.unref?.();
      };
      const run = (current: EffectiveAccess) =>
        registry.start(params.cmd, {
          cwd: ctx.cwd,
          sandbox: sandboxFor(current.sandbox, current.network),
          yieldTimeMs: normalized.yieldTimeMs,
          timeoutMs: normalized.timeoutMs,
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
          content: [{ type: "text", text: formatManagedResult(result, false, normalized.notes) }],
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
      const processId = typeof params.process_id === "string" ? params.process_id.trim() : "";
      if (!processId) {
        const text = [
          "Invalid parameter: write_stdin requires process_id — the id printed by exec_command.",
          `Known processes:\n${describeKnownProcesses(registry)}`,
        ].join("\n");
        return rejectCommandResult(text, "", "rejected (missing process_id)");
      }
      const yieldResult = normalizeYieldTimeMs(params.yield_time_ms ?? 5_000);
      if (!yieldResult.ok) return rejectCommandResult(yieldResult.message, "", "rejected (invalid parameters)");
      const result = await registry.interact(processId, {
        ...(params.chars === undefined ? {} : { chars: params.chars }),
        yieldTimeMs: yieldResult.value,
        terminate: params.terminate ?? false,
      });
      return {
        content: [{ type: "text", text: formatManagedResult(result, false, yieldResult.notes) }],
        details: result,
      };
    },
  };

  return [execTool, writeTool];
}

/** 与 ManagedResult 形状一致的拒绝结果：拒绝原因进 output，并把实际 argv 一起回显。 */
function rejectCommandResult(
  text: string,
  command: string,
  sandbox: string,
  exitCode = 2,
): { content: { type: "text"; text: string }[]; details: ManagedResult; isError: true } {
  return {
    content: [{ type: "text", text }],
    details: { processId: "", running: false, output: text, command, warnings: [], sandbox, exitCode },
    isError: true,
  };
}

export function formatManagedResult(result: ManagedResult, live = false, notes: string[] = []): string {
  const output = clipForModel(
    result.output.trimEnd() || (live ? "…" : "(no output)"),
    live ? 4_000 : 6_000,
  );
  return [
    ...notes,
    ...result.warnings,
    output,
    `command: ${oneLine(result.command, 200)}`,
    `process_id: ${result.processId}`,
    result.running
      ? "status: running"
      : result.replayed
        ? "status: completed (already exited before this poll; showing the retained output)"
        : "status: completed",
    ...(result.running ? ["Use write_stdin to poll or interact."] : []),
    ...(result.exitCode === undefined ? [] : [formatExitCodeLine(result.command, result.exitCode)]),
    ...(result.timedOut ? ["timed_out: true"] : []),
    `sandbox: ${result.sandbox}`,
  ].join("\n");
}

/**
 * 退出码行：搜索类命令的 `1` 是「没有匹配」，而不是失败。
 *
 * 只在单段命令上标注：管道/多段命令的退出码来自最后一段，把它解释成搜索结果为
 * 假就错了（例如 `rg foo | head` 的 0 来自 head）。
 */
function formatExitCodeLine(command: string, exitCode: number | null): string {
  const line = `exit_code: ${exitCode}`;
  if (exitCode !== 1 || !isSearchCommand(command)) return line;
  return `${line} (exit 1 means no matches for this search command, not a failure)`;
}

/** 搜索类命令（rg / grep / git grep）的退出码 1 表示「没有匹配」。 */
function isSearchCommand(command: string): boolean {
  const segments = splitCommandSegments(command);
  if (segments.length !== 1) return false;
  const words = segments[0]?.words ?? [];
  const head = commandBaseName(words[0]?.text ?? "");
  if (["rg", "grep", "egrep", "fgrep"].includes(head)) return true;
  return head === "git" && (words[1]?.text ?? "") === "grep";
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
  // 这些规则对应真实踩过的坑（rg -r 改写输出、长任务接 tail 看不到进度、
  // 同一条昂贵检查跑两遍、分支名猜 main/master、zsh 的 = 展开与 PIPESTATUS）。
  const shared = [
    "- Search with `rg -n` (add -i / -F as needed). Never pass -r to rg: it means --replace and silently rewrites match text in the output.",
    "- rg / grep exit code 1 means \"no matches\", not a failure; only exit 2+ (or stderr) is an error. Do not report a broken tool from a 1.",
    "- Long tasks (install / build / test / type-check): do not pipe into `tail` or `head`; run them directly, keep the process_id, and poll with write_stdin. When you only need the errors, redirect to a log (`cmd > /tmp/run.log 2>&1`) and search the log afterwards.",
    "- If output contradicts your expectation (a path or symbol you never saw), reproduce the command minimally before blaming the platform or the app.",
    "- Run each expensive whole-repo check once per change; chain dependent checks with && instead of repeating the same command.",
    "- Branch names come from the repo, not from convention: check `git branch -a` before assuming main or master.",
    "- Before using `git stash` or a diff to establish a baseline, run `git status --porcelain`: a clean tree means the change is already committed (check `git log -1 --stat`), and `git stash push` on a clean tree stores nothing so the later `git stash pop` fails with \"No stash entries found\".",
    "- Large mechanical rewrites (many files or hundreds of occurrences) may use a script with assertions plus a diff spot-check and a build verification instead of hundreds of patches.",
  ];
  if (platform === "win32") {
    return [
      "- exec_command is Windows PowerShell. Write PowerShell (Get-ChildItem, Get-Content, Set-Location, Select-String, `$env:NAME = 'value'`, chain with `;`). Search with search_files.",
      ...shared,
    ];
  }
  return [
    "- exec_command is the host POSIX shell. Prefer rg / rg --files for search.",
    "- Quote separator words: `echo \"=== ... ===\"`, never a bare `echo ===`. In zsh a word starting with `=` is expanded as a command path, so the command fails (exit 1) and any `&&` chain behind it never runs.",
    "- Pipeline status: use bash's `${PIPESTATUS[0]}` only under bash. In zsh use `${pipestatus[1]}` (lowercase, 1-based); `$PIPESTATUS` expands to an empty string and silently loses the exit code.",
    ...shared,
  ];
}
