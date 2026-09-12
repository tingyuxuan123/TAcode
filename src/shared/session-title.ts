import { visionTitle } from "./vision-api.js";

export const MAX_SESSION_TITLE_CHARS = 32;
export const MAX_TITLE_INPUT_CHARS = 6_000;

/** 模型生成前、失败后及旧会话的紧凑兜底；按 Unicode 字符截断。 */
export function fallbackSessionTitle(message: string): string {
  const text = visionTitle(message).replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > MAX_SESSION_TITLE_CHARS
    ? `${chars.slice(0, MAX_SESSION_TITLE_CHARS - 1).join("")}…`
    : text;
}

/** 只接受单行标题，移除模型常见的标题前缀、引号和 Markdown 包装。 */
export function normalizeGeneratedTitle(value: string): string {
  const text = value
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .trim()
    .replace(/^```[^\n]*\n/, "")
    .split(/\r?\n/)[0]?.trim()
    .replace(/^(?:#{1,6}\s*|(?:标题|title)\s*[:：]\s*)/i, "")
    .replace(/^[\s"'`*“”「」『』]+|[\s"'`*“”「」『』。.!！]+$/g, "")
    .replace(/\s+/g, " ") ?? "";
  return Array.from(text).slice(0, MAX_SESSION_TITLE_CHARS).join("").trim();
}

/** 命名只需要首条消息的主题；限制输入，避免把整段长需求重复发送。 */
export function sessionTitleInput(message: string): string {
  return Array.from(visionTitle(message).trim()).slice(0, MAX_TITLE_INPUT_CHARS).join("");
}
