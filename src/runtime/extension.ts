/**
 * TACode 自研 Runtime 扩展。
 *
 * 这是自持的实现（取代早期依赖的第三方运行时包）：Pi 只提供
 * Agent 循环、RPC、会话与模型协议；工具、权限、沙箱与计划语义由本扩展承载，
 * 并沿用改名前的旧工具名（read_file / exec_command / apply_patch / update_plan …），
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
  subagentCatalogText,
  type SubagentDefinition,
  type SubagentPermission,
} from "../shared/subagents.js";
import { loadEnabledSubagents } from "./subagents.js";
import { tacodeEnv } from "./env.js";
import { createTurnLimiter, parseTurnLimit } from "./turn-limit.js";
import { registerSessionTitle } from "./session-title.js";
import { registerMcpTools } from "./mcp-extension.js";
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
import {
  applyToolSet,
  captureToolSetCarryOver,
  clearToolSetCarryOver,
  setToolSetPolicy,
} from "../shared/tool-set.js";

const PERMISSION_ENTRY = "tacode-permission";
const CHECKPOINT_ENTRY = "tacode-checkpoint";

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
      /** 本次进入 plan 模式是否已抓过 carryOver（防止每轮 turn_start 重复抓取）。 */
      let planToolSetCaptured = false;
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
        ctx.ui.setStatus("tacode", permission === "plan" ? ctx.ui.theme.fg("warning", status) : status);
        ctx.ui.setTitle(`TACode Runtime — ${ctx.cwd}`);
      };

      /**
       * 工具集的唯一写入口：基础工具（`--tools`）+ 扩展贡献（browser_*、vision…）
       * 统一由 shared/tool-set 计算（见那里的模块注释）。
       *
       * 旧实现在这里直接 `setActiveTools(options.activeTools)`：不在 `--tools` 里的
       * 浏览器工具会被整体摘掉，而浏览器扩展又只在 session_start / before_agent_start
       * 时 union 回来 —— 生成中途切换权限（/permissions、/plan）就会让 browser_* 在本回合
       * 剩余时间里全部变成 `Tool … not found`。
       */
      const applyPermissionTools = (): void => {
        if (permission === "plan") {
          if (!planToolSetCaptured) {
            planToolSetCaptured = true;
            captureToolSetCarryOver(pi.getActiveTools(), options.activeTools);
          }
        } else {
          planToolSetCaptured = false;
        }
        setToolSetPolicy({
          permission,
          baseToolNames: options.activeTools,
          planAllowedToolNames: [...planAllowedTools],
        });
        applyToolSet(pi);
      };

      registerDeepSeekProvider(pi, options);
      registerReadTools(pi);
      // 桥接子 worker 的只读命令策略由主进程经 TACODE_EXEC_POLICY 下发（角色定义 → start options）。
      const workerReadOnly = tacodeEnv("EXEC_POLICY") === "readonly";
      registerCommandTools(pi, {
        ...(workerReadOnly ? { readOnly: true } : {}),
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
      registerMcpTools(pi, options, () => permission);
      pi.registerCommand("reload-capabilities", {
        description: "Reload Skills and MCP configuration",
        handler: async (_args, ctx) => {
          await ctx.waitForIdle();
          await ctx.reload();
        },
      });

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
      if (childDepth < 1 && tacodeEnv("AUTO_TITLE") === "1") registerSessionTitle(pi);
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
        planToolSetCaptured = false;
        clearToolSetCarryOver();
        applyPermissionTools();
        updateStatus(ctx);
      });

      // 每个 LLM 往返都重新断言一次工具集：中途发生的权限模式 / 扩展贡献变化不会
      // 留下整回合的空窗（applyToolSet 幂等，没有变化就不会重建系统提示）。
      pi.on("turn_start", () => {
        applyPermissionTools();
      });

      // 子代理目录注入系统上下文：模型看不到 ~/.tacode/subagents 目录，没有目录就只能猜角色名。
      // 只在能委派的会话里注入（子 worker 不能再委派）。
      if (childDepth < 1) {
        pi.on("before_agent_start", async () => {
          const definitions = await loadEnabledSubagents().catch(() => []);
          const catalog = subagentCatalogText(definitions);
          if (!catalog) return;
          return {
            message: {
              customType: "tacode-subagent-catalog",
              display: false,
              content: catalog,
            },
          };
        });
      }

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

      // 子代理的轮数预算：桥接路径由角色定义经 agent-host 的 TACODE_MAX_TURNS 下发。
      // 到上限主动 abort，让父侧拿到「已产出的那部分」而不是被强杀；父侧协调器还会按
      // 同一上限兜底收口（转 truncated，不算失败）。仅对下发过该变量的 worker 生效。
      const turnLimiter = createTurnLimiter(parseTurnLimit(tacodeEnv("MAX_TURNS")));
      if (turnLimiter) {
        // 每次运行（含 delegate_continue 复用同一 worker）都重新计预算，与父侧
        // 「本次运行新增轮次」的判定口径一致。
        pi.on("before_agent_start", () => {
          turnLimiter.startRun();
        });
        pi.on("turn_end", (_event, ctx) => {
          if (turnLimiter.countTurn()) {
            console.error("[subagent] turn limit reached; aborting the run");
            ctx.abort();
          }
        });
      }

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
          // 历史「最低」档折算为「低」；其余未知值仍然报错。
          const level = value === "minimal" ? "low" : value;
          if (!["off", "low", "medium", "high", "xhigh", "max"].includes(level)) {
            ctx.ui.notify("Expected /effort off|low|medium|high|xhigh|max", "warning");
            return;
          }
          pi.setThinkingLevel(level as Parameters<typeof pi.setThinkingLevel>[0]);
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
      "When apply_patch reports a missing context, read the nearest-match line it names and resend only that hunk; do not re-send the whole file.",
      "For a large mechanical rewrite (many files or hundreds of occurrences), a script with assertions plus a diff spot-check and a build verification is acceptable and preferred over hundreds of patches.",
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
    ...(definition.execPolicy === "readonly" ? { readOnly: true } : {}),
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
 * 可被中止的审批对话框。
 *
 * `ctx.ui.confirm` 不带 signal 时，用户点停止不会结束这条请求；而
 * `session.abort()` 要 `await waitForIdle()` 等工具执行结束才回响应，
 * 于是「停止」会一直看起来没生效。传 signal 后 abort 会以默认值 false 结束对话框，
 * 审批按「拒绝」收尾，turn 立刻结束。
 */
async function confirmApproval(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
  const signal = ctx.signal;
  if (signal?.aborted) return false;
  return ctx.ui.confirm(title, message, { signal });
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
    const approved = await confirmApproval(
      ctx,
      "Run destructive command?",
      `${command}\n\nThis may delete data or alter system/process state.`,
    );
    if (!approved) return { block: true, reason: "Destructive command denied by user" };
  } else if (toolName === "apply_patch" && isRecord(input) && typeof input.input === "string") {
    for (const section of patchApprovalSections(input.input)) {
      const approved = await confirmApproval(ctx, `Apply ${section.file}?`, section.patch);
      if (!approved) return { block: true, reason: `Denied ${section.file} by user` };
    }
  } else {
    const approved = await confirmApproval(ctx, `Allow ${toolName}?`, approvalSummary(toolName, input));
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
