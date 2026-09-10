/**
 * TACode 自研 Runtime 扩展。
 *
 * 这是替代 `tether-agent-core` 的 `createTetherExtension` 的实现：Pi 只提供
 * Agent 循环、RPC、会话与模型协议；工具、权限、沙箱与计划语义由本扩展承载，
 * 并保持 Tether 时代的工具名（read_file / exec_command / apply_patch / update_plan …），
 * 使渲染层无需改动。
 */

import type {
  AgentTool,
} from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_MUTATING_TOOLS,
  type SubagentDefinition,
  type SubagentPermission,
} from "../shared/subagents.js";
import { loadEnabledSubagents } from "./subagents.js";
import type { PermissionMode, TacodeRuntimeOptions } from "./options.js";
import { registerAskUserTool, ASK_USER_TOOL } from "./tools/ask-user.js";
import { capturePatchCheckpoint, type Checkpoint } from "./tools/checkpoint.js";
import { registerCommandTools, createCommandTools, type CommandToolOptions } from "./tools/commands.js";
import { registerDelegateTools, registerRemoteDelegateTools } from "./tools/delegate.js";
import { registerDeepSeekProvider } from "./tools/deepseek-provider.js";
import { createFileTools } from "./tools/files.js";
import { ManagedProcessRegistry } from "./tools/managed-process.js";
import { applyWorkspacePatch } from "./tools/patch.js";
import {
  formatPlanForExecution,
  registerPlanTool,
  restorePlanState,
  PLAN_STATE_ENTRY,
  type PlanState,
} from "./tools/plan.js";
import { classifyCommand, SessionAccessController, type EffectiveAccess } from "./tools/policy.js";
import { sandboxDescription, type SandboxOptions } from "./tools/sandbox.js";
import { createRuntimeDelegationClient } from "./delegation-bridge.js";
import { Workspace } from "./tools/workspace.js";
import { Type } from "@earendil-works/pi-ai";

const PERMISSION_ENTRY = "tether-permission";
const CHECKPOINT_ENTRY = "tether-checkpoint";

const planAllowedTools = new Set<string>([
  "read_file",
  "list_files",
  "search_files",
  "exec_command",
  "write_stdin",
  "update_plan",
  "web_search",
  "fetch_content",
  "get_search_content",
  ASK_USER_TOOL,
]);

/** ask 模式下无需确认的只读工具。 */
const askWithoutPromptTools = new Set<string>([
  "read_file",
  "list_files",
  "search_files",
  "web_search",
  "fetch_content",
  "get_search_content",
  ASK_USER_TOOL,
]);

const permissionRank: Record<PermissionMode, number> = {
  plan: 0,
  ask: 1,
  auto: 2,
  full: 3,
};

/** 子代理不能获得超过父会话的权限；未指定时继承父模式。 */
function effectiveSubagentPermission(
  parent: PermissionMode,
  requested: SubagentPermission | undefined,
): PermissionMode {
  if (!requested || requested === "inherit") return parent;
  return permissionRank[requested] < permissionRank[parent] ? requested : parent;
}

const applyPatchParameters = Type.Object({
  input: Type.String({ minLength: 1, description: "A complete *** Begin Patch / *** End Patch patch" }),
});

export function createTacodeExtension(options: TacodeRuntimeOptions) {
  return {
    name: "tacode",
    factory(pi: ExtensionAPI): void {
      const registry = new ManagedProcessRegistry();
      const access = new SessionAccessController(options.sandbox, options.network);
      const checkpoints: Checkpoint[] = [];
      let permission: PermissionMode = options.permission;
      let permissionBeforePlan: PermissionMode = options.permission === "plan" ? "auto" : options.permission;
      let toolsBeforePlan: string[] | undefined;
      let planState: PlanState | undefined;

      const effectiveAccess = (): EffectiveAccess => access.effective(permission);
      const sandboxFor = (mode: SandboxOptions["mode"], network: boolean): SandboxOptions => ({
        mode,
        network,
        ...(options.writableRoots.length ? { writableRoots: options.writableRoots } : {}),
      });

      const appendCheckpoint = (checkpoint: Checkpoint): void => {
        checkpoints.push(checkpoint);
        pi.appendEntry(CHECKPOINT_ENTRY, checkpoint);
      };

      const updateStatus = (ctx: ExtensionContext): void => {
        const current = effectiveAccess();
        const status = `TACode Runtime · ${permission} · ${sandboxDescription(sandboxFor(current.sandbox, current.network))}`;
        ctx.ui.setStatus("tether", permission === "plan" ? ctx.ui.theme.fg("warning", status) : status);
        ctx.ui.setTitle(`TACode Runtime — ${ctx.cwd}`);
      };

      /** plan 模式只暴露只读工具；离开 plan 后恢复原工具集。 */
      const applyPermissionTools = (): void => {
        if (permission === "plan") {
          if (toolsBeforePlan === undefined) toolsBeforePlan = [...options.activeTools];
          else {
            const active = pi
              .getActiveTools()
              .filter(
                (tool) =>
                  options.activeTools.includes(tool) || tool.startsWith("mcp__") || tool === "update_plan",
              );
            toolsBeforePlan = [...new Set([...toolsBeforePlan, ...active])];
          }
          pi.setActiveTools([
            ...new Set([...toolsBeforePlan.filter((tool) => planAllowedTools.has(tool)), "update_plan"]),
          ]);
          return;
        }
        if (toolsBeforePlan !== undefined) {
          pi.setActiveTools(toolsBeforePlan);
          toolsBeforePlan = undefined;
        } else {
          pi.setActiveTools(options.activeTools);
        }
      };

      registerDeepSeekProvider(pi, options);
      registerReadTools(pi);
      registerCommandTools(pi, {
        registry,
        getPermission: () => permission,
        access,
        sandboxFor,
        onAccessChanged: () => undefined,
        onCheckpoint: appendCheckpoint,
      });
      registerPatchTool(pi, appendCheckpoint);
      registerPlanTool(
        pi,
        () => planState,
        (next) => {
          planState = next;
        },
      );
      registerAskUserTool(pi);

      // 本地 fallback 仍保留给没有主进程 bridge 的 runtime 测试/CLI 场景。
      const commandToolOptions: CommandToolOptions = {
        registry,
        getPermission: () => permission,
        access,
        sandboxFor,
        onAccessChanged: () => undefined,
        onCheckpoint: appendCheckpoint,
      };

      const childDepth = Number(process.env.SUBAGENT_DEPTH ?? "0");
      const delegateBridge = process.env.TACODE_DELEGATION_BRIDGE === "1" && childDepth < 1
        ? createRuntimeDelegationClient()
        : undefined;
      const delegateRegistry = childDepth >= 1
        ? undefined
        : delegateBridge ? undefined : registerDelegateTools(pi, {
        getDefinitions: () => loadEnabledSubagents(),
        createTools: (definition, ctx) =>
          createSubagentTools(definition, ctx, commandToolOptions, appendCheckpoint),
        deliverReport: (text) => {
          try {
            pi.sendUserMessage(text, { deliverAs: "followUp" });
          } catch (error) {
            console.error("[subagent] failed to deliver report", error);
          }
        },
        log: (message, details) => console.error("[subagent]", message, details ?? ""),
      });
      if (delegateBridge) {
        registerRemoteDelegateTools(pi, {
          client: delegateBridge,
          startPayload: (definition, task, ctx) => {
            const current = effectiveAccess();
            return {
              role: definition.name,
              task,
              title: definition.name,
              cwd: ctx.cwd,
              provider: definition.model?.providerId ?? options.providerId,
              model: definition.model?.modelId ?? options.modelId,
              thinkingLevel: definition.thinkingLevel ?? ctx.thinkingLevel,
              permission,
              sandbox: current.sandbox,
              network: current.network,
              ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
              ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
              ...(options.serviceId ? { serviceId: options.serviceId } : {}),
              ...(options.writableRoots.length ? { writableRoots: options.writableRoots } : {}),
            };
          },
        });
      }

      pi.on("session_start", (_event, ctx) => {
        checkpoints.length = 0;
        planState = restorePlanState(
          ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown }>,
        );
        pi.setActiveTools(options.activeTools);
        toolsBeforePlan = undefined;
        applyPermissionTools();
        updateStatus(ctx);
      });

      pi.on("before_agent_start", (event) => {
        if (permission !== "plan") return;
        const current = effectiveAccess();
        return {
          systemPrompt: event.systemPrompt,
          message: {
            customType: "tacode-plan-context",
            display: false,
            content: [
              "[PLAN MODE ACTIVE]",
              "Explore and reason only. File mutation tools are unavailable.",
              `Commands run in a read-only OS sandbox with network ${current.network ? "enabled" : "subject to scoped approval"}.`,
              "Use update_plan to publish a concrete implementation plan after exploration.",
              "Include validation and important risks in the plan steps or explanation.",
              "Do not claim to have changed or tested anything you could not actually run.",
            ].join("\n"),
          },
        };
      });

      pi.on("tool_call", (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> =>
        approveToolCallSerialized(event.toolName, event.input, permission, ctx),
      );

      pi.on("session_shutdown", () => {
        delegateRegistry?.dispose();
        delegateBridge?.dispose();
        registry.dispose();
      });

      pi.registerCommand("plan", {
        description: "Toggle plan mode; /plan show|clear|execute|refine",
        handler: async (args, ctx) => {
          const action = args.trim();
          if (action === "execute" || action === "approve") {
            if (!planState) {
              ctx.ui.notify("No structured plan is available.", "warning");
              return;
            }
            if (permission !== "plan") {
              ctx.ui.notify("Switch to plan mode before approving a plan.", "warning");
              return;
            }
            permission = permissionBeforePlan;
            applyPermissionTools();
            updateStatus(ctx);
            pi.appendEntry(PERMISSION_ENTRY, { permission });
            pi.sendUserMessage(
              [
                "Execute the approved plan below. Keep update_plan statuses current as you work.",
                "Maintain at most one in_progress step and only mark completed after verification.",
                "After each verified step, call update_plan once before starting the next step. Do not batch status updates at the end.",
                "",
                formatPlanForExecution(planState),
              ].join("\n"),
              { deliverAs: "followUp" },
            );
            ctx.ui.notify(`Permission mode: ${permission}`, "info");
            return;
          }
          const refineMatch = /^refine(?:\s+([\s\S]*))?$/i.exec(action);
          if (refineMatch) {
            const refinement = refineMatch[1]?.trim() ?? "";
            if (!refinement) {
              ctx.ui.notify("Expected /plan refine <changes>", "warning");
              return;
            }
            pi.sendUserMessage(`Refine the current plan using update_plan. Requested changes:\n${refinement}`, {
              deliverAs: "followUp",
            });
            return;
          }
          if (action === "show") {
            ctx.ui.notify(
              planState ? formatPlanForExecution(planState) : "No structured plan is available.",
              "info",
            );
            return;
          }
          if (action === "clear") {
            planState = undefined;
            pi.appendEntry(PLAN_STATE_ENTRY, { cleared: true, updatedAt: new Date().toISOString() });
            ctx.ui.notify("Structured plan cleared.", "info");
            return;
          }
          if (action) {
            ctx.ui.notify("Expected /plan, /plan show, /plan clear, /plan execute, or /plan refine", "warning");
            return;
          }
          if (permission === "plan") {
            permission = permissionBeforePlan;
          } else {
            permissionBeforePlan = permission;
            permission = "plan";
          }
          applyPermissionTools();
          updateStatus(ctx);
          pi.appendEntry(PERMISSION_ENTRY, { permission });
          ctx.ui.notify(`Permission mode: ${permission}`, "info");
        },
      });

      pi.registerCommand("permissions", {
        description: "Show or set plan|ask|auto|full",
        handler: async (args, ctx) => {
          if (!args.trim()) {
            const current = effectiveAccess();
            ctx.ui.notify(
              [
                `permission: ${permission}`,
                `sandbox: ${current.sandbox}`,
                `network: ${current.network ? "enabled" : "blocked"}`,
                `session grants: ${access.describeGrants().join(", ") || "none"}`,
                "Escalation: allow once / allow for session / deny",
              ].join("\n"),
              "info",
            );
            return;
          }
          const value = args.trim();
          if (!["plan", "ask", "auto", "full"].includes(value)) {
            ctx.ui.notify("Expected /permissions plan|ask|auto|full", "warning");
            return;
          }
          const next = value as PermissionMode;
          // 不再为 full 额外弹一次确认：选择器里的“完全访问”本身就是显式、带风险提示的
          // 用户动作（perm.fullDesc），再问一次只是重复确认；而且该确认在斜杠命令内部
          // 等待 UI 应答时容易把命令队列堵死。
          if (next === "plan" && permission !== "plan") permissionBeforePlan = permission;
          permission = next;
          applyPermissionTools();
          updateStatus(ctx);
          pi.appendEntry(PERMISSION_ENTRY, { permission });
          ctx.ui.notify(`Permission mode: ${permission}`, "info");
        },
      });

      pi.registerCommand("jobs", {
        description: "List managed background command processes",
        handler: async (_args, ctx) => {
          const jobs = registry.list();
          ctx.ui.notify(
            jobs.length
              ? jobs
                  .map((job) => `${job.running ? "●" : "○"} ${job.processId} — ${oneLine(job.command, 80)}`)
                  .join("\n")
              : "No managed background processes.",
            "info",
          );
        },
      });

      pi.registerCommand("stop-job", {
        description: "Stop a managed background process by id",
        handler: async (args, ctx) => {
          const id = args.trim();
          if (!id) {
            ctx.ui.notify("Usage: /stop-job <process_id>", "warning");
            return;
          }
          try {
            await registry.interact(id, { terminate: true, yieldTimeMs: 200 });
            ctx.ui.notify(`Stopped ${id}`, "info");
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
        },
      });

      pi.registerCommand("stop-jobs", {
        description: "Stop all managed background processes",
        handler: async (_args, ctx) => {
          const jobs = registry.list().filter((job) => job.running);
          if (jobs.length === 0) {
            ctx.ui.notify("No managed background processes.", "info");
            return;
          }
          for (const job of jobs) {
            await registry
              .interact(job.processId, { terminate: true, yieldTimeMs: 200 })
              .catch(() => undefined);
          }
          ctx.ui.notify(`Stopped ${jobs.length} process${jobs.length === 1 ? "" : "es"}.`, "info");
        },
      });

      pi.registerCommand("effort", {
        description: "Show or set model thinking effort",
        handler: async (args, ctx) => {
          const value = args.trim();
          if (!value) {
            ctx.ui.notify(`Thinking effort: ${pi.getThinkingLevel()}`, "info");
            return;
          }
          if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) {
            ctx.ui.notify("Expected /effort off|minimal|low|medium|high|xhigh|max", "warning");
            return;
          }
          pi.setThinkingLevel(value as Parameters<typeof pi.setThinkingLevel>[0]);
          ctx.ui.notify(`Thinking effort: ${pi.getThinkingLevel()}`, "info");
        },
      });
    },
  };
}

/** 只读文件工具；工作区在每次执行时按当前 cwd 重新解析。 */
function registerReadTools(pi: ExtensionAPI): void {
  for (const template of createFileTools(new Workspace(process.cwd()))) {
    if (!["read_file", "list_files", "search_files", "write_file", "edit_file"].includes(template.name)) {
      continue;
    }
    pi.registerTool({
      ...template,
      async execute(id, params, signal, onUpdate, ctx) {
        const workspace = new Workspace(ctx.cwd);
        await workspace.initialize();
        const live = createFileTools(workspace).find((tool) => tool.name === template.name);
        if (!live) throw new Error(`Tool disappeared: ${template.name}`);
        return live.execute(id, params, signal, onUpdate, ctx);
      },
    });
  }
}

function registerPatchTool(pi: ExtensionAPI, appendCheckpoint: (checkpoint: Checkpoint) => void): void {
  pi.registerTool(createPatchTool(appendCheckpoint));
}

/** 构造 apply_patch 定义（不注册），供子代理复用。 */
function createPatchTool(
  appendCheckpoint: (checkpoint: Checkpoint) => void,
): ToolDefinition<typeof applyPatchParameters, Record<string, unknown>> {
  return {
    name: "apply_patch",
    label: "Apply patch",
    description:
      "Apply an atomic, workspace-confined patch. Supports Add File, Update File, Delete File, and Move to directives.",
    promptSnippet: "apply_patch: atomically add, update, move, or delete workspace files",
    promptGuidelines: [
      "Use apply_patch for file changes; keep each patch focused and reviewable.",
      "Never report a change as complete before running relevant validation.",
    ],
    parameters: applyPatchParameters,
    constrainedSampling: { type: "grammar", variants: { openai_regex: "[\\s\\S]*" } },
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const workspace = new Workspace(ctx.cwd);
      await workspace.initialize();
      let applied: Awaited<ReturnType<typeof applyWorkspacePatch>> | undefined;
      const checkpoint = await capturePatchCheckpoint(workspace, params.input, async () => {
        applied = await applyWorkspacePatch(workspace, params.input);
      });
      appendCheckpoint(checkpoint);
      const result = applied;
      if (!result) throw new Error("Patch did not run");
      return {
        content: [
          {
            type: "text",
            text: [
              `Applied checkpoint ${checkpoint.id}.`,
              `files: ${result.files.join(", ")}`,
              `diff: +${result.additions} -${result.deletions}`,
              "Use /undo to restore this checkpoint.",
            ].join("\n"),
          },
        ],
        details: { ...result, checkpointId: checkpoint.id, patch: params.input },
      };
    },
  };
}

/**
 * 为子代理构造受限工具集：按定义声明的名字取工具，包一层父会话审批，
 * 并在定义要求 plan 时剔除写类工具。
 */
function createSubagentTools(
  definition: SubagentDefinition,
  ctx: ExtensionContext,
  commandOptions: CommandToolOptions,
  appendCheckpoint: (checkpoint: Checkpoint) => void,
): AgentTool[] {
  const childPermission = effectiveSubagentPermission(
    commandOptions.getPermission(),
    definition.permission,
  );
  const mutating = SUBAGENT_MUTATING_TOOLS as readonly string[];
  const names = childPermission === "plan"
    ? definition.tools.filter((name) => !mutating.includes(name))
    : definition.tools;
  const childCommandOptions: CommandToolOptions = {
    ...commandOptions,
    getPermission: () => childPermission,
  };

  const available = new Map<string, ToolDefinition<any, any, any>>();
  for (const template of createFileTools(new Workspace(ctx.cwd))) {
    available.set(template.name, {
      ...template,
      async execute(id, params, signal, onUpdate, innerCtx) {
        const workspace = new Workspace(innerCtx.cwd);
        await workspace.initialize();
        const live = createFileTools(workspace).find((tool) => tool.name === template.name);
        if (!live) throw new Error(`Tool disappeared: ${template.name}`);
        return live.execute(id, params, signal, onUpdate, innerCtx);
      },
    });
  }
  available.set("apply_patch", createPatchTool(appendCheckpoint));
  for (const tool of createCommandTools(childCommandOptions)) available.set(tool.name, tool);

  const tools: AgentTool[] = [];
  for (const name of names) {
    const tool = available.get(name);
    if (!tool) continue;
    tools.push({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
      async execute(toolCallId, params, signal, onUpdate) {
        const blocked = await approveToolCallSerialized(tool.name, params, childPermission, ctx);
        if (blocked) throw new Error(blocked.reason ?? "Denied by user");
        return tool.execute(toolCallId, params, signal, onUpdate as never, ctx);
      },
    });
  }
  return tools;
}

/**
 * 串行化 UI 审批：多个子代理可能同时请求确认，而渲染层只有一个待确认槽位。
 */
let approvalChain: Promise<unknown> = Promise.resolve();
function approveToolCallSerialized(
  toolName: string,
  input: unknown,
  permission: PermissionMode,
  ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
  const next = approvalChain.then(
    () => approveToolCall(toolName, input, permission, ctx),
    () => approveToolCall(toolName, input, permission, ctx),
  );
  approvalChain = next.catch(() => undefined);
  return next;
}

/**
 * 统一的工具审批：父会话的 `tool_call` 钩子与子代理工具包装共用，
 * 保证子代理不会绕过父会话的权限模式与危险命令确认。
 */
async function approveToolCall(
  toolName: string,
  input: unknown,
  permission: PermissionMode,
  ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
  if (toolName === "bash" || toolName === "run_command" || toolName === "edit" || toolName === "write") {
    return {
      block: true,
      reason:
        toolName === "bash" || toolName === "run_command"
          ? "This shell tool bypasses TACode Runtime's managed OS sandbox. Use exec_command instead."
          : "This write tool bypasses TACode checkpoints. Use apply_patch instead.",
    };
  }
  if (permission === "plan" && !planAllowedTools.has(toolName)) {
    return { block: true, reason: `Plan mode does not allow ${toolName}. Run /plan to leave plan mode.` };
  }
  const externalMcp = toolName.startsWith("mcp__");
  const command =
    toolName === "exec_command" && isRecord(input) && typeof input.cmd === "string" ? input.cmd : undefined;
  const dangerousCommand = command !== undefined && classifyCommand(command) === "dangerous";
  if (permission === "plan" && dangerousCommand) {
    return {
      block: true,
      reason: "Plan mode blocks destructive commands. Leave plan mode before running this command.",
    };
  }
  const needsApproval = permission === "ask" || (permission === "auto" && (externalMcp || dangerousCommand));
  if (!needsApproval) return undefined;
  if (!externalMcp && askWithoutPromptTools.has(toolName)) return undefined;
  if (
    toolName === "write_stdin" &&
    isRecord(input) &&
    typeof input.chars !== "string" &&
    input.terminate !== true
  ) {
    return undefined;
  }
  if (!ctx.hasUI) {
    return {
      block: true,
      reason:
        "This action requires an interactive approval UI. Use --permission full for an explicitly trusted non-interactive run.",
    };
  }
  if (dangerousCommand) {
    const approved = await ctx.ui.confirm(
      "Run destructive command?",
      `${command}\n\nThis may delete data or alter system/process state.`,
    );
    if (!approved) return { block: true, reason: "Destructive command denied by user" };
  } else if (toolName === "apply_patch" && isRecord(input) && typeof input.input === "string") {
    for (const section of patchApprovalSections(input.input)) {
      const approved = await ctx.ui.confirm(`Apply ${section.file}?`, section.patch);
      if (!approved) return { block: true, reason: `Denied ${section.file} by user` };
    }
  } else {
    const approved = await ctx.ui.confirm(`Allow ${toolName}?`, approvalSummary(toolName, input));
    if (!approved) return { block: true, reason: "Denied by user" };
  }
  return undefined;
}

function approvalSummary(toolName: string, input: unknown): string {  if (!isRecord(input)) return `Tool: ${toolName}`;
  const cmd = input.cmd;
  if (typeof cmd === "string") return cmd;
  const path = input.path;
  if (typeof path === "string") return path;
  const processId = input.process_id;
  if (typeof processId === "string") return `process ${processId}`;
  return `Tool: ${toolName}`;
}

/** 把补丁按 `*** <动作> File:` 分段，便于逐文件确认。 */
function patchApprovalSections(input: string): Array<{ file: string; patch: string }> {
  const lines = input.replaceAll("\r\n", "\n").split("\n");
  const sections: Array<{ file: string; patch: string }> = [];
  let current: { file: string; lines: string[] } | undefined;
  for (const line of lines) {
    const match = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/.exec(line);
    if (match) {
      if (current) sections.push({ file: current.file, patch: current.lines.join("\n") });
      current = { file: match[1].trim(), lines: [line] };
      continue;
    }
    if (current && line !== "*** End Patch" && !line.startsWith("*** Begin Patch")) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ file: current.file, patch: current.lines.join("\n") });
  return sections.length > 0 ? sections : [{ file: "workspace", patch: input }];
}

function oneLine(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 让类型检查器确认命令上下文未被误用。 */
export type TacodeCommandContext = ExtensionCommandContext;
