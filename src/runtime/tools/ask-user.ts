/**
 * `ask_user` 工具：让模型在缺少用户偏好或决策时提问，而不是猜测。
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ASK_USER_TOOL = "ask_user";

/**
 * 取消/中止时的统一结果：工具立刻返回，让 turn 收尾。
 *
 * 交互式提问必须可被中止（用户点停止、轮次预算触发的 abort 都会 abort 当前 run
 * 的 signal）。否则 worker 会永远挂在一条不会再被应答的 UI 请求上：
 * `session.abort()` 内部 `await waitForIdle()` 要等这个工具返回，于是 abort 的响应
 * 永远发不出来，界面上的「停止」看起来完全无效。
 */
function cancelledAnswer(question: string, options?: string[]) {
  return {
    content: [{ type: "text" as const, text: "User cancelled the question." }],
    details: {
      question,
      ...(options && options.length ? { options } : {}),
      cancelled: true,
    },
    isError: true,
  };
}

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
    async execute(_id, params, signal, _onUpdate, ctx) {
      const question = params.question.trim();
      const options = (params.options ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 6);
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "No UI to ask the user. State an assumption instead of guessing." }],
          details: { error: "no-ui", question },
          isError: true,
        };
      }
      // 弹窗还没出现就被中止（例如刚点停止）：直接以取消收尾，不留下无应答的请求。
      if (signal?.aborted) return cancelledAnswer(question, options);
      ctx.ui.setWorkingVisible(false);
      try {
        if (options.length >= 2) {
          // 传 signal：abort 时 pi 会以 undefined 结束对话框，工具随之返回（见文件头注释）。
          const choice = await ctx.ui.select(question, options, { signal });
          if (!choice) return cancelledAnswer(question, options);
          return {
            content: [{ type: "text", text: `User chose: ${choice}` }],
            details: { question, choice, options },
          };
        }
        const answer = await ctx.ui.input(question, undefined, { signal });
        if (answer === undefined) return cancelledAnswer(question, options);
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
