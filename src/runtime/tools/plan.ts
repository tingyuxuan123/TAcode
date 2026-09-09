/**
 * `update_plan` 工具与计划状态。
 *
 * 计划以 custom entry 持久化，resume 后可恢复；渲染层通过 `update_plan` 工具调用
 * 自行聚合进度，这里只负责校验与状态。
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PLAN_STATE_ENTRY = "tether-plan-state";

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

export interface PlanState {
  explanation?: string;
  steps: PlanStep[];
  revision: number;
  updatedAt: string;
}

const planStepSchema = Type.Object({
  step: Type.String({ minLength: 1, maxLength: 500 }),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
  ]),
});

const updatePlanParameters = Type.Object({
  explanation: Type.Optional(Type.String({ maxLength: 2_000 })),
  plan: Type.Array(planStepSchema, { minItems: 1, maxItems: 30 }),
});

export function registerPlanTool(
  pi: ExtensionAPI,
  getPlan: () => PlanState | undefined,
  onUpdate: (plan: PlanState) => void,
): void {
  pi.registerTool<typeof updatePlanParameters, PlanState | { error: string }>({
    name: "update_plan",
    label: "Update plan",
    description:
      "Create or update the structured implementation plan shown in the TACode UI. Send the full current plan in one call. After a step is verified, call update_plan (mark it completed, set the next in_progress) before starting that next step's other tools. At most one update_plan per assistant turn — do not emit several calls to replay status history, and do not wait until every step is done.",
    promptSnippet: "update_plan: one call per turn with the full current plan; update before starting the next step",
    promptGuidelines: [
      "Use update_plan after repository exploration when work has multiple meaningful steps.",
      "Keep at most one step in_progress. Mark a step completed only after its outcome is actually achieved.",
      "Call update_plan at most once per assistant turn. After finishing a step, update the plan before any tools for the next step. Never batch all status changes into several update_plan calls at the end.",
    ],
    parameters: updatePlanParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params) {
      const issue = validatePlanSteps(params.plan);
      if (issue) {
        return {
          content: [{ type: "text", text: issue }],
          details: { error: issue },
          isError: true,
        };
      }
      const explanation = params.explanation?.trim();
      const plan: PlanState = {
        ...(explanation ? { explanation } : {}),
        steps: params.plan.map((item) => ({ step: item.step.trim(), status: item.status })),
        revision: (getPlan()?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      pi.appendEntry(PLAN_STATE_ENTRY, plan);
      onUpdate(plan);
      const completed = plan.steps.filter((step) => step.status === "completed").length;
      return {
        content: [
          { type: "text", text: `Plan updated: ${completed}/${plan.steps.length} steps completed.` },
        ],
        details: plan,
      };
    },
  });
}

export function restorePlanState(entries: Array<{ type?: string; customType?: string; data?: unknown }>): PlanState | undefined {
  let restored: PlanState | undefined;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === PLAN_STATE_ENTRY) {
      restored = isPlanState(entry.data) ? entry.data : undefined;
    }
  }
  return restored;
}

export function formatPlanForExecution(state: PlanState): string {
  return state.steps.map((step, index) => `${index + 1}. [${step.status}] ${step.step}`).join("\n");
}

export function validatePlanSteps(steps: PlanStep[]): string | undefined {
  if (steps.some((item) => !item.step.trim())) return "Plan steps cannot be blank.";
  if (steps.filter((item) => item.status === "in_progress").length > 1) {
    return "A plan can have at most one in_progress step.";
  }
  return undefined;
}

function isPlanState(value: unknown): value is PlanState {
  return (
    isRecord(value) &&
    typeof value.revision === "number" &&
    typeof value.updatedAt === "string" &&
    Array.isArray(value.steps) &&
    value.steps.every(
      (step) =>
        isRecord(step) &&
        typeof step.step === "string" &&
        ["pending", "in_progress", "completed"].includes(String(step.status)),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
