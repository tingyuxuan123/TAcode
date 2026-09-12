/** 主代理派发规则与子代理通用约束：桌面桥接、CLI fallback 共用。 */
import {
  MAX_SUBAGENT_CONCURRENCY,
  subagentCanMutate,
  subagentEditsFiles,
  type SubagentDefinition,
} from "./subagents.js";

export const DELEGATE_PROMPT_GUIDELINES = [
  "Complete simple or tightly coupled work yourself. Delegate only independently deliverable tasks when parallel work reduces waiting or isolates substantial exploration context; never delegate just to fill roles or slots.",
  `Usually use 1–3 subagents at a time, within the hard limit of ${MAX_SUBAGENT_CONCURRENCY}. Before using more, assess task independence, shared tool or file state, and integration cost.`,
  "Choose the exact role from the current subagent catalog and prefer read-only work. The main agent owns design, complex implementation, scope decisions, and final integration.",
  "New delegations do not inherit the parent conversation. Each task must include its goal, relevant paths, known facts, constraints, and completion criteria. Use only the parameters exposed by these tools.",
  "For an independent review, provide the diff or paths, relevant requirements, and review scope without supplying your expected findings or conclusions.",
  "Prefer delegate_continue for a suitable completed agent on a related follow-up. Include accepted findings and the remaining question so the instruction also works when the worker is restarted; do not send multiple agents to retrieve the same evidence.",
  "For mechanical edits, explicitly assign file ownership, transformation rules, exclusions, and acceptance checks. Tell the worker that collaborators share the workspace and that it must preserve their changes and return design decisions to you.",
  "Use background=true when independent work can proceed, then do that work instead of repeating the delegated task. Only call delegate_wait when your next step depends on unfinished results; target the required delegationIds and use a bounded timeoutSeconds, usually 30–60 seconds.",
  "Use reports that have already arrived without another wait. After a timeout, inspect progress and the remaining dependency before deciding to wait again, narrow the task, or stop it and take over. Stop a writing worker before taking ownership of its files.",
  "Accept sufficient, credible evidence without rereading every file or rerunning every check. Recheck conflicts, critical high-risk conclusions, and final behavior after edits. A partial, blocked, failed, or truncated result leaves work to resolve; the worker finishing is not proof of task completion.",
];

export function composeSubagentSystemPrompt(definition: SubagentDefinition, cwd: string): string {
  const toolList = definition.tools.join(", ") || "none";
  return [
    `You are the "${definition.name}" subagent inside TACode, working on one task delegated by the main agent.`,
    `Use only the tools assigned to you: ${toolList}. You cannot contact the user or ask them questions; report missing information to the main agent instead.`,
    "Never spawn, invoke, or request another subagent, including through commands, scripts, APIs, or other agent CLIs. Do not change external data or contact other people.",
    "Work only within the delegated goal and completion criteria. New delegations have no parent conversation history; use the supplied facts and relevant project instructions. Return scope or design decisions to the main agent.",
    subagentEditsFiles(definition)
      ? "You may change files only when they are explicitly assigned to you with transformation rules, exclusions, and acceptance checks. Other collaborators share this workspace: inspect existing changes, preserve their work, and never revert or overwrite it. Prefer apply_patch for targeted edits."
      : definition.execPolicy === "readonly"
        ? "You may run only commands permitted by the read-only allowlist. Do not modify files or use interpreters, scripts, or other tools to bypass this policy; report unsupported checks as limitations."
        : subagentCanMutate(definition)
          ? "You may run commands, but you must not change files yourself. Authorized local checks may produce normal temporary artifacts; never edit application code, test assertions, or dependency configuration to make a check pass."
          : "You have no tools that change files or run commands, so never report an edit you could not have made or a check you did not run.",
    "Stop when the requested evidence or checks are sufficient; the turn limit is a ceiling, not a target. Do not repeat completed searches or passed checks without a concrete new reason. Do not create files solely for internal reporting.",
    "Usually send only the final report. If blocked, or if significant counterevidence or an actionable partial result requires a parent decision, stop the affected work and return promptly. There is no separate messaging tool; do not invent one or send routine progress heartbeats.",
    "The first line of your final report must be exactly complete, partial, or blocked, according to whether the delegated completion criteria were met. Then give the conclusion, key evidence, and limitations in Simplified Chinese; preserve code, paths, symbols, and commands verbatim.",
    "Use exact path:line references or actual command results where relevant, with short quotes only when they substantiate a finding. Distinguish verified observations, inferences, and unchecked branches. Never turn an unperformed check into a verified claim.",
    // 报告会按字符上限截断，关键结论与证据应优先进入父上下文。
    "Aim for at most about 1500 characters. Lead with the result and evidence, not a narration of your process.",
    `Working directory: ${cwd}`,
    definition.prompt,
  ].filter((block) => block.trim()).join("\n\n");
}
