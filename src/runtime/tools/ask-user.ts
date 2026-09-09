/**
 * `ask_user` 工具：让模型在缺少用户偏好或决策时提问，而不是猜测。
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ASK_USER_TOOL = "ask_user";

const askUserParameters = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 500 }),
  options: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 2, maxItems: 6 }),
  ),
});

export function registerAskUserTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: ASK_USER_TOOL,
    label: "Ask user",
    description:
      "Ask the user a multiple-choice or short-answer question when a guess would be wrong. Use when a preference or decision is missing. Do not use for file writes or shell commands — those already have approval UI.",
    promptSnippet: "ask_user: ask the user instead of guessing",
    promptGuidelines: [
      "Call ask_user when the next step depends on a user choice you cannot infer.",
      "Prefer 2–6 short options. Use a free-form question only when options would be misleading.",
      "Do not ask about file writes or shell commands; those already have approval UI.",
    ],
    parameters: askUserParameters,
    renderShell: "self",
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const question = params.question.trim();
      const options = (params.options ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 6);
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "No UI to ask the user. State an assumption instead of guessing." }],
          details: { error: "no-ui", question },
          isError: true,
        };
      }
      ctx.ui.setWorkingVisible(false);
      try {
        if (options.length >= 2) {
          const choice = await ctx.ui.select(question, options);
          if (!choice) {
            return {
              content: [{ type: "text", text: "User cancelled the question." }],
              details: { question, options, cancelled: true },
              isError: true,
            };
          }
          return {
            content: [{ type: "text", text: `User chose: ${choice}` }],
            details: { question, choice, options },
          };
        }
        const answer = await ctx.ui.input(question);
        if (answer === undefined) {
          return {
            content: [{ type: "text", text: "User cancelled the question." }],
            details: { question, cancelled: true },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `User answered: ${answer}` }],
          details: { question, answer },
        };
      } finally {
        ctx.ui.setWorkingVisible(true);
      }
    },
  });
}
