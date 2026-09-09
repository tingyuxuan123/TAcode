/**
 * 渲染层错误的纯逻辑：把任意抛出物整理成可展示的摘要与细节。
 * 与 React 解耦，便于在 node 环境下单测。
 */

const MAX_SUMMARY = 200;
const MAX_DETAIL = 4_000;

export interface RenderErrorReport {
  /** 一行摘要，放在标题下方。 */
  summary: string;
  /** 折叠展示的技术细节（含堆栈，已截断）。 */
  detail: string;
}

export function describeRenderError(error: unknown): RenderErrorReport {
  const detail = error instanceof Error
    ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
    : safeString(error);
  const firstLine = detail.split("\n", 1)[0] ?? "";
  return {
    summary: firstLine.slice(0, MAX_SUMMARY) || "Unknown render error",
    detail: detail.slice(0, MAX_DETAIL),
  };
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}
