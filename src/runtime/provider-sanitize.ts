/**
 * Provider 出站请求的 thinking 净化层。
 *
 * 背景（2026-09-12 用户实测）：GLM 的 Anthropic 兼容接口对回放历史里的 thinking 块
 * 校验苛刻——过短的块直接 400「长度不足」（模型自己会产出 7~60 字符的短思考并落盘，
 * 下一轮发回去就被它自己的 API 拒掉）。先试过「只剔除低于 200 字符的块」，用户在
 * 报错会话上依旧复现失败（且只在该会话出现，新会话正常）——说明它的校验规则不止
 * 长度一条，猜不动。
 *
 * 处理（对齐 ZCode 等客户端的通行做法）：**出站历史里一律剔除 thinking 块**。
 * Anthropic 协议语义本就允许省略历史轮的 thinking；唯一例外是「对话停在工具结果上、
 * 即将续跑同一条 assistant 轮」时，保留最后一条 assistant 消息的 thinking（协议要求
 * 续跑时 tool_use 前面要有 thinking；这种块若过短仍剔除，宁可靠重试也不要 400）。
 *
 * 会话文件保持原样，只影响传输；净化环节任何异常都按原请求发送，绝不因此中断对话。
 */

/** 即将续跑的 assistant 轮里，过短的 thinking 依然会被接口拒收，同样剔除。 */
export const MIN_REPLAY_THINKING_CHARS = 200;

type MessageRecord = { role?: unknown; content?: unknown };
type ContentPart = { type?: unknown; thinking?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const contentParts = (message: unknown): unknown[] | undefined => {
  if (!isRecord(message)) return undefined;
  const content = (message as MessageRecord).content;
  return Array.isArray(content) ? content : undefined;
};

/** Anthropic 协议里工具结果以 user 角色携带 tool_result 块。 */
const isToolResultMessage = (message: unknown): boolean => {
  const parts = contentParts(message);
  if (!parts) return false;
  if (!isRecord(message) || (message as MessageRecord).role !== "user") return false;
  return parts.some((part) => isRecord(part) && (part as { type?: unknown }).type === "tool_result");
};

/**
 * 返回净化后的请求体；无需改动（不是 LLM 消息体 / 没有 thinking 块）时返回 undefined，
 * 调用方直接按原请求发送。解析失败同样返回 undefined，绝不抛错。
 */
export function sanitizeProviderBody(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return undefined;
  const last = messages.at(-1);
  const inFlightToolLoop = isToolResultMessage(last);
  let lastAssistantIndex = -1;
  if (inFlightToolLoop) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const parts = contentParts(messages[index]);
      if (parts !== undefined && isRecord(messages[index]) && (messages[index] as MessageRecord).role === "assistant") {
        lastAssistantIndex = index;
        break;
      }
    }
  }
  let changed = false;
  const next = messages.map((message, index) => {
    const parts = contentParts(message);
    if (parts === undefined || !isRecord(message) || (message as MessageRecord).role !== "assistant") return message;
    // 历史轮：全剔；即将续跑的最后一轮：只剔过短的（协议要求续跑带 thinking，但短块必被拒）
    const minKeep = index === lastAssistantIndex ? MIN_REPLAY_THINKING_CHARS : Number.POSITIVE_INFINITY;
    const filtered = parts.filter((part) => {
      if (!isRecord(part)) return true;
      const block = part as ContentPart;
      if (block.type !== "thinking") return true;
      return index === lastAssistantIndex
        && typeof block.thinking === "string"
        && block.thinking.length >= minKeep;
    });
    if (filtered.length === parts.length) return message;
    changed = true;
    return { ...message, content: filtered };
  });
  if (!changed) return undefined;
  // 剔完变空的「纯思考消息」整条移除：GLM 还要求 assistant 内容非空
  // （400「content 低于允许下限」）。纯思考消息剔掉 thinking 后对模型零信息量。
  const cleaned = next.filter((message) => {
    const parts = contentParts(message);
    if (parts === undefined || !isRecord(message) || (message as MessageRecord).role !== "assistant") return true;
    if (parts.length > 0) return true;
    return false;
  });
  return cleaned.length === messages.length ? JSON.stringify({ ...parsed, messages: next }) : JSON.stringify({ ...parsed, messages: cleaned });
}

/**
 * 包装 worker 进程的全局 fetch：只重写「带 JSON body 且包含 thinking 块」的请求。
 * 30 秒内最多向 stderr 写一条诊断（agent-host 会采集 worker stderr），避免刷屏。
 */
export function installProviderFetchSanitizer(): void {
  const rawFetch = globalThis.fetch;
  let lastLogged = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const body = init?.body;
      if (typeof body === "string" && body.includes(`"thinking"`)) {
        const next = sanitizeProviderBody(body);
        if (next !== undefined) {
          const headers = new Headers(init?.headers);
          // The original SDK request may carry a length for the unmodified body.
          // Keeping it after rewriting makes undici fail before the request reaches
          // the provider; let fetch calculate the length for the new body.
          headers.delete("content-length");
          const now = Date.now();
          if (now - lastLogged > 30_000) {
            lastLogged = now;
            process.stderr.write("provider-sanitize: stripped thinking block(s) from provider request\n");
          }
          return rawFetch(input, { ...init, body: next, headers });
        }
      }
    } catch {
      // 净化环节的任何异常都按原请求发送，不影响对话
    }
    return rawFetch(input as RequestInfo | URL, init);
  }) as typeof fetch;
}
