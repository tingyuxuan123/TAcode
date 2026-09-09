/**
 * TACode 自研 Runtime 扩展。
 *
 * 这是替代 `tether-agent-core` 的 `createTetherExtension` 的实现：Pi 只提供
 * Agent 循环、RPC、会话与模型协议；工具、权限、沙箱与计划语义由本扩展承载，
 * 并保持 Tether 时代的工具名（read_file / exec_command / apply_patch / update_plan …），
 * 使渲染层无需改动。
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { PermissionMode, TacodeRuntimeOptions } from "./options.js";
import { registerAskUserTool, ASK_USER_TOOL } from "./tools/ask-user.js";
import { capturePatchCheckpoint, type Checkpoint } from "./tools/checkpoint.js";
import { registerCommandTools } from "./tools/commands.js";
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

      pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
        if (
          event.toolName === "bash" ||
          event.toolName === "run_command" ||
          event.toolName === "edit" ||
          event.toolName === "write"
        ) {
          return {
            block: true,
            reason:
              event.toolName === "bash" || event.toolName === "run_command"
                ? "This shell tool bypasses TACode Runtime's managed OS sandbox. Use exec_command instead."
                : "This write tool bypasses TACode checkpoints. Use apply_patch instead.",
          };
        }
        if (permission === "plan" && !planAllowedTools.has(event.toolName)) {
          return {
            block: true,
            reason: `Plan mode does not allow ${event.toolName}. Run /plan to leave plan mode.`,
          };
        }
        const externalMcp = event.toolName.startsWith("mcp__");
        const command =
          event.toolName === "exec_command" &&
          isRecord(event.input) &&
          typeof event.input.cmd === "string"
            ? event.input.cmd
            : undefined;
        const dangerousCommand = command !== undefined && classifyCommand(command) === "dangerous";
        if (permission === "plan" && dangerousCommand) {
          return {
            block: true,
            reason: "Plan mode blocks destructive commands. Leave plan mode before running this command.",
          };
        }
        const needsApproval =
          permission === "ask" || (permission === "auto" && (externalMcp || dangerousCommand));
        if (!needsApproval) return;
        if (!externalMcp && askWithoutPromptTools.has(event.toolName)) return;
        if (
          event.toolName === "write_stdin" &&
          isRecord(event.input) &&
          typeof event.input.chars !== "string" &&
          event.input.terminate !== true
        ) {
          return;
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
        } else if (
          event.toolName === "apply_patch" &&
          isRecord(event.input) &&
          typeof event.input.input === "string"
        ) {
          for (const section of patchApprovalSections(event.input.input)) {
            const approved = await ctx.ui.confirm(`Apply ${section.file}?`, section.patch);
            if (!approved) return { block: true, reason: `Denied ${section.file} by user` };
          }
        } else {
          const approved = await ctx.ui.confirm(
            `Allow ${event.toolName}?`,
            approvalSummary(event.toolName, event.input),
          );
          if (!approved) return { block: true, reason: "Denied by user" };
        }
        return undefined;
      });

      pi.on("session_shutdown", () => {
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
          if (next === "full" && permission !== "full" && ctx.hasUI) {
            const approved = await ctx.ui.confirm(
              "Enable full access?",
              "Commands will run on the host with unrestricted filesystem and network access. Use only in a trusted workspace.",
            );
            if (!approved) return;
          }
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
  pi.registerTool({
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
  });
}

function approvalSummary(toolName: string, input: unknown): string {
  if (!isRecord(input)) return `Tool: ${toolName}`;
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
