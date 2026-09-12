import type { AgentEvent, PermissionMode, SessionSummary } from "../shared/types";
import { sameUserSkillTurn } from "../shared/skills";
import { BROWSER_TOOLS } from "../shared/browser-tools";
import { parseWebSearchCard } from "../shared/integrations";
import { DEFAULT_LOCALE, t, type Locale, type MessageKey } from "../shared/i18n";
import { isVisionHandoff, mimeFromImagePath, visibleUserText, visionHandoffPaths, visionToolTitle, visionUploadUrl } from "../shared/vision-api";

let activeLocale: Locale = DEFAULT_LOCALE;

/** Keep conversation chrome in sync with the UI language. */
export function setConversationLocale(locale: Locale): void {
  activeLocale = locale;
}

function ct(key: MessageKey, vars?: Record<string, string | number>): string {
  return t(activeLocale, key, vars);
}

export function isTransientStreamError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  return /stream ended without finish_reason|missing finish_reason/i.test(raw);
}

export function friendlyAgentError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const detail = raw
    .replace(/^Error invoking remote method 'agent:(?:command|start)':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (isTransientStreamError(detail)) return "";
  if (/context (?:length|window)|maximum context|too many tokens|token limit/i.test(detail)) return ct("toast.errorContext");
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api.?key|authentication|credential/i.test(detail)) return ct("toast.errorAuth");
  if (/\b402\b|\b429\b|rate.?limit|too many requests|quota|insufficient (?:balance|credit|funds)/i.test(detail)) return ct("toast.errorQuota");
  if (/\b504\b|gateway time-?out|timeout|timed out|ETIMEDOUT|AbortError/i.test(detail)) return ct("toast.errorTimeout");
  if (/model .*(?:not found|unavailable|unknown)|unknown model|invalid model|model.*does not exist/i.test(detail)) return ct("toast.errorModel");
  if (/\b404\b|\/chat\/completions.*not found|endpoint.*not found/i.test(detail)) return ct("toast.errorEndpoint");
  if (/\b502\b|\b503\b|bad gateway|service unavailable|fetch failed|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(detail)) {
    return ct("toast.errorNetwork");
  }
  if (/JSON error injected into SSE stream|injected into SSE|SSE stream/i.test(detail)) {
    return ct("toast.errorStreamInterrupted");
  }
  if (/connection error|connection failed|connection reset|ECONNRESET|socket hang up/i.test(detail)) {
    return ct("toast.errorNetwork");
  }
  return detail || ct("error.modelFailed");
}

/** Intermittent network/provider hiccups that may recover next turn. */
export function isRecoverableRequestError(error: string | undefined): boolean {
  if (!error) return false;
  return /网络|连接模型服务失败|超时|model timed out|network|timed out|gateway|service unavailable|status code\s*5\d\d|SSE|stream interrupted|流中断|中断后重试|connection error|connection failed/i.test(error);
}

export interface ToolActivity {
  id: string;
  name: string;
  title: string;
  status: "running" | "complete" | "error";
  startedAt?: number;
  endedAt?: number;
  args?: unknown;
  output?: string;
  details?: unknown;
  resultRecorded?: boolean;
  interrupted?: boolean;
}

export interface ChatImage {
  data: string;
  mimeType: string;
  /** Set instead of `data` for images restored from disk rather than the live paste. */
  src?: string;
}

export type WorkItem =
  | { type: "thinking"; id: string; text: string }
  | { type: "text"; id: string; text: string }
  | { type: "tool"; id: string; toolId: string };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking?: string;
  timestamp?: number;
  streaming?: boolean;
  queued?: boolean;
  images: ChatImage[];
  tools: ToolActivity[];
  work: WorkItem[];
  /** Start of the current model message inside a live merged turn. */
  workOffset?: number;
  stopReason?: string;
  endedAt?: number;
  interrupted?: boolean;
  error?: string;
}

export type ConversationGroup =
  | { type: "user"; id: string; message: ChatMessage }
  | { type: "assistant"; id: string; messages: ChatMessage[] };

export function cacheHitRate(tokens?: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number | undefined {
  if (!tokens) return undefined;
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return prompt > 0 ? (tokens.cacheRead / prompt) * 100 : undefined;
}

type JsonRecord = Record<string, unknown>;

export function normalizeMessages(messages: unknown[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const value of messages) {
    if (!isRecord(value)) continue;
    if (value.role === "toolResult") {
      attachStoredToolResult(result, value);
      continue;
    }
    if (value.role !== "user" && value.role !== "assistant") continue;
    const parsed = messageFromRecord(value, `history-${result.length}`);
    if (!parsed) continue;
    result.push(isVisionHandoff(parsed.text)
      ? { ...parsed, text: visibleUserText(parsed.text), images: stagedImages(parsed.text) }
      : parsed);
  }
  return result;
}

/**
 * Work ids are numbered inside their own message (`thinking-0`, `text-0`…), so a turn rebuilt
 * from several stored messages must scope them, or every message keeps only the last thought.
 */
export function turnWork(messages: ChatMessage[]): WorkItem[] {
  const slots = new Map<string, WorkItem>();
  for (const message of messages) {
    message.work.forEach((item, index) => {
      const id = item.type === "tool" ? `tool-${item.toolId}` : `${message.id}:${item.id}:${index}`;
      slots.set(item.type === "tool" ? item.toolId : id, { ...item, id });
    });
  }
  return [...slots.values()];
}

/** Project ordered content into process history and the contiguous trailing answer. */
export function buildTurnPresentation(messages: ChatMessage[]) {
  const tools = [...new Map(messages.flatMap((message) => message.tools).map((tool) => [tool.id, tool])).values()];
  const items = turnWork(messages);
  if (!items.length) {
    const thinking = collapseThinking(...messages.map((message) => message.thinking));
    if (thinking) items.push({ type: "thinking", id: "fallback-thinking", text: thinking });
    for (const tool of tools) items.push({ type: "tool", id: `tool-${tool.id}`, toolId: tool.id });
    const text = [...messages].reverse().find((message) => message.text.trim())?.text ?? "";
    if (text) items.push({ type: "text", id: "fallback-text", text });
  }
  const recorded = new Set(items.flatMap((item) => item.type === "tool" ? [item.toolId] : []));
  for (const tool of tools) {
    if (!recorded.has(tool.id)) items.push({ type: "tool", id: `tool-${tool.id}`, toolId: tool.id });
  }
  let boundary = items.length;
  while (boundary > 0 && items[boundary - 1]!.type === "text") boundary -= 1;
  const reply = items.slice(boundary).filter((item): item is Extract<WorkItem, { type: "text" }> => item.type === "text");
  return {
    items,
    process: items.slice(0, boundary),
    reply,
    replyText: reply.map((item) => item.text).join("\n\n"),
    tools,
  };
}

export function assistantReplyText(messages: ChatMessage[]): string {
  return buildTurnPresentation(messages).replyText;
}

export function assistantGroupSucceeded(messages: ChatMessage[]): boolean {
  const last = messages.at(-1);
  return Boolean(assistantReplyText(messages)) && !last?.interrupted && !last?.error;
}

export function assistantGroupHasRecoverableError(messages: ChatMessage[]): boolean {
  return messages.some((item) => isRecoverableRequestError(item.error));
}

/** Same turn or a later assistant turn already delivered a reply. */
export function assistantErrorRecovered(
  messages: ChatMessage[],
  groups: ConversationGroup[],
  groupIndex: number,
): boolean {
  if (!assistantGroupHasRecoverableError(messages)) return false;
  if (assistantGroupSucceeded(messages)) return true;
  return groups.slice(groupIndex + 1).some(
    (next) => next.type === "assistant" && assistantGroupSucceeded(next.messages),
  );
}

/** Consecutive recoverable failures since the last user message (2+ → strong error). */
export function recoverableFailStreaks(groups: ConversationGroup[]): number[] {
  const streaks: number[] = [];
  let streak = 0;
  for (const group of groups) {
    if (group.type === "user") {
      streak = 0;
      streaks.push(0);
      continue;
    }
    const rawError = group.messages.map((item) => item.error).find(Boolean);
    const failed = isRecoverableRequestError(rawError) && !assistantGroupSucceeded(group.messages);
    streak = failed ? streak + 1 : 0;
    streaks.push(streak);
  }
  return streaks;
}

export function dropLastTurn(messages: ChatMessage[]): ChatMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1]!.role === "assistant") end -= 1;
  if (end > 0 && messages[end - 1]!.role === "user") end -= 1;
  return messages.slice(0, end);
}

export function hasNewCheckpointUndo(
  before: Array<{ id?: string }>,
  after: Array<{ id?: string; type?: string; customType?: string }>,
): boolean {
  const seen = new Set(before.map((item) => item.id).filter((id): id is string => Boolean(id)));
  return after.some((entry) => {
    const id = entry.id;
    return entry.type === "custom" && isCheckpointUndo(entry.customType) && typeof id === "string" && !seen.has(id);
  });
}

export interface RestoreFile {
  path: string;
  content: string | null;
  mode?: number;
}

export type SessionEntryLike = {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: { role?: string; content?: unknown };
};

/** Earliest `before` per path after the last real user turn. `/undo` only restores the newest checkpoint. */
export function lastTurnRestoreFiles(entries: SessionEntryLike[]): RestoreFile[] {
  const undone = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || !isCheckpointUndo(entry.customType) || !isRecord(entry.data)) continue;
    if (typeof entry.data.checkpointId === "string") undone.add(entry.data.checkpointId);
  }
  let start = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    if (entryUserText(entry.message.content).trim() === "/undo") continue;
    start = index + 1;
  }
  const byPath = new Map<string, RestoreFile>();
  for (let index = start; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.type !== "custom" || !isCheckpoint(entry.customType) || !isRecord(entry.data)) continue;
    if (typeof entry.data.id !== "string" || undone.has(entry.data.id) || !Array.isArray(entry.data.before)) continue;
    for (const file of entry.data.before) {
      if (!isRecord(file) || typeof file.path !== "string" || byPath.has(file.path)) continue;
      if (file.content !== null && typeof file.content !== "string") continue;
      byPath.set(file.path, {
        path: file.path,
        content: file.content,
        ...(typeof file.mode === "number" ? { mode: file.mode } : {}),
      });
    }
  }
  return [...byPath.values()];
}

function isCheckpoint(type: string | undefined): boolean {
  return type === "tacode-checkpoint";
}

function isCheckpointUndo(type: string | undefined): boolean {
  return type === "tacode-checkpoint-undone";
}

function entryUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
}

export function undoDialogTitle(heading: string | undefined, lastTurn?: string): string | undefined {
  if (!heading || !/^Undo\s/i.test(heading)) return heading;
  const label = lastTurn?.replace(/\s+/g, " ").trim();
  if (!label) return ct("undo.confirm");
  return ct("undo.confirmNamed", {
    label: label.length > 36 ? `${label.slice(0, 36)}…` : label,
  });
}

export function approvalTitle(heading: string | undefined, lastTurn?: string): string {
  const line = heading?.split("\n")[0]?.trim() ?? "";
  if (!line) return ct("approval.needConfirm");
  if (/^run destructive command\??$/i.test(line)) return ct("approval.destructiveTitle");
  if (/^allow network access\??$/i.test(line)) return ct("approval.networkTitle");
  if (/^allow unrestricted host access\??$/i.test(line)) return ct("approval.hostTitle");
  const apply = /^Apply (.+)\?$/.exec(line);
  if (apply?.[1]) return ct("approval.applyFile", { file: apply[1] });
  const tool = /^Allow ([a-z][a-z0-9_]+)\?$/i.exec(line);
  if (tool?.[1]) return ct("approval.allowTool", { tool: tool[1] });
  if (/^Undo\s/i.test(line)) return undoDialogTitle(line, lastTurn) ?? ct("undo.confirm");
  return line;
}

export function groupConversation(messages: ChatMessage[], previousGroups: ConversationGroup[] = []): ConversationGroup[] {
  const groups: ConversationGroup[] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (message.role === "assistant" && previous?.type === "assistant") {
      previous.messages.push(message);
      continue;
    }
    groups.push(message.role === "user"
      ? { type: "user", id: message.id, message }
      : { type: "assistant", id: message.id, messages: [message] });
  }
  return groups.map((group, index) => {
    const previous = previousGroups[index];
    if (previous?.type === "user" && group.type === "user" && previous.message === group.message) return previous;
    if (previous?.type === "assistant" && group.type === "assistant"
      && previous.messages.length === group.messages.length
      && previous.messages.every((message, i) => message === group.messages[i])) return previous;
    return group;
  });
}

export function turnAnchorId(id: string): string {
  return `turn-${id}`;
}

/** Jump targets for the conversation navigator: one entry per real user question. */
export function turnAnchors(groups: ConversationGroup[]): Array<{ id: string; label: string }> {
  const anchors: Array<{ id: string; label: string }> = [];
  for (const group of groups) {
    if (group.type !== "user") continue;
    const label = visibleUserText(group.message.text).replace(/\s+/g, " ").trim();
    if (!label || label.startsWith("/")) continue;
    anchors.push({
      id: turnAnchorId(group.id),
      label: label.length > 42 ? `${label.slice(0, 42)}…` : label,
    });
  }
  return anchors;
}

export function applyAgentEvent(messages: ChatMessage[], event: AgentEvent): ChatMessage[] {
  if (event.type === "agent_settled") {
    return finalizeInterruptedTurn(messages).map((message, index) => index === messages.length - 1 && message.role === "assistant"
      ? { ...message, endedAt: message.endedAt ?? Date.now() }
      : message);
  }

  if (event.type === "agent_end" && event.willRetry !== true) {
    const last = Array.isArray(event.messages) ? event.messages.at(-1) : undefined;
    if (isRecord(last) && last.role === "assistant") {
      const incoming = messageFromRecord(last, `event-${Date.now()}-${messages.length}`);
      if (incoming?.error) {
        const current = messages.at(-1);
        if (current?.role === "assistant") {
          return messages.map((message, index) =>
            index === messages.length - 1 ? { ...message, streaming: false, error: incoming.error } : message,
          );
        }
        return [...messages, { ...incoming, streaming: false }];
      }
    }
  }

  if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
    const raw = isRecord(event.message) ? event.message : undefined;
    if (!raw || (raw.role !== "user" && raw.role !== "assistant")) return messages;
    const incoming = messageFromRecord(raw, `event-${Date.now()}-${messages.length}`);
    if (!incoming) return messages;

    if (incoming.role === "user") {
      if (isVisionHandoff(incoming.text)) {
        if (messages.length > 0) return messages;
        return [{ ...incoming, text: visibleUserText(incoming.text), images: stagedImages(incoming.text) }];
      }
      const last = messages.at(-1);
      if (last?.role === "user" && (last.text === incoming.text || sameUserSkillTurn(last.text, incoming.text))) {
        return messages.map((message, index) =>
          index === messages.length - 1 ? {
            ...message,
            text: incoming.text,
            queued: false,
            timestamp: incoming.timestamp ?? message.timestamp,
            images: incoming.images.length > 0 ? incoming.images : message.images,
          } : message,
        );
      }
      const prev = messages.at(-2);
      if (
        last?.role === "assistant"
        && !last.text.trim()
        && prev?.role === "user"
        && (prev.text === incoming.text || sameUserSkillTurn(prev.text, incoming.text))
      ) {
        return messages;
      }
      if (event.type === "message_start") return [...messages, incoming];
      return messages;
    }

    const last = messages.at(-1);
    if (last?.role === "assistant") {
      const streaming = event.type !== "message_end" || !incoming.text.trim();
      return messages.map((message, index) =>
        index === messages.length - 1 ? mergeAssistant(message, incoming, streaming, event.type === "message_start") : message,
      );
    }

    return [...messages, { ...incoming, streaming: event.type !== "message_end" }];
  }

  if (event.type === "tool_execution_start") {
    return upsertLastAssistantTool(messages, toolFromEvent(event, "running"));
  }
  if (event.type === "tool_execution_update") {
    const activity = toolFromEvent(event, "running");
    activity.output = stringifyToolResult(event.partialResult);
    activity.details = toolDetails(event.partialResult) ?? toolDetails(event);
    if (activity.name === "vision") activity.title = visionToolTitle(activity.details);
    if (activity.name === "delegate") activity.title = delegateToolTitle(activity);
    return upsertLastAssistantTool(messages, activity);
  }
  if (event.type === "tool_execution_end") {
    const activity = toolFromEvent(event, event.isError === true ? "error" : "complete");
    activity.output = stringifyToolResult(event.result)
      ?? stringifyToolResult(event.error)
      ?? stringifyToolResult(event.message);
    activity.resultRecorded = true;
    activity.details = toolDetails(event.result) ?? toolDetails(event);
    if (activity.name === "vision") activity.title = visionToolTitle(activity.details);
    if (activity.name === "delegate") activity.title = delegateToolTitle(activity);
    return upsertLastAssistantTool(messages, activity);
  }
  return messages;
}

export function optimisticUserMessage(text: string, queued = false, images: ChatImage[] = []): ChatMessage {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    role: "user",
    text,
    timestamp: Date.now(),
    queued,
    images,
    tools: [],
    work: [],
  };
}

export function currentTool(messages: ChatMessage[]): ToolActivity | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const running = messages[index]!.tools.find((tool) => tool.status === "running");
    if (running) return running;
  }
}

function getMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
}

function messageFromRecord(value: JsonRecord, id: string): ChatMessage | undefined {
  if (value.role !== "user" && value.role !== "assistant") return undefined;
  const content = value.content;
  const raw = getMessageText(content);
  const split = value.role === "assistant" ? splitThinkTags(raw) : { text: raw, thinking: "" };
  const thinking = collapseThinking(getThinking(content), split.thinking);
  const images = getImages(content);
  const timestamp = normalizeTimestamp(value.timestamp);
  const tools = getTools(content, timestamp);
  const work = value.role === "assistant" ? getWork(content) : [];
  const error = value.role === "assistant" && value.stopReason === "error"
    ? friendlyAgentError(value.errorMessage ?? ct("error.modelFailed"))
    : undefined;
  return {
    id,
    role: value.role,
    text: split.text,
    images,
    ...(thinking ? { thinking } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(error ? { error } : {}),
    ...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}),
    ...(value.stopReason === "aborted" ? { interrupted: true } : {}),
    tools,
    work,
  };
}

/** Pasted bytes never reach the session file, only the staged paths, so rebuild from those. */
function stagedImages(handoff: string): ChatImage[] {
  return visionHandoffPaths(handoff).map((file) => ({
    data: "",
    mimeType: mimeFromImagePath(file),
    src: visionUploadUrl(file),
  }));
}

function getImages(content: unknown): ChatImage[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord).flatMap((part) => {
    if (part.type !== "image" || typeof part.data !== "string" || typeof part.mimeType !== "string") return [];
    if (!part.mimeType.startsWith("image/") || !part.data) return [];
    return [{ data: part.data, mimeType: part.mimeType }];
  });
}

function getThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return collapseThinking(
    ...content
      .filter(isRecord)
      .filter((part) => part.type === "thinking" && typeof part.thinking === "string")
      .map((part) => String(part.thinking)),
  );
}

function getTools(content: unknown, startedAt?: number): ToolActivity[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord).flatMap((part, index) => {
    if (part.type !== "toolCall" || typeof part.name !== "string") return [];
    const id = typeof part.id === "string" ? part.id : `content-tool-${index}`;
    return [{
      id,
      name: part.name,
      title: toolTitle(part.name, part.arguments),
      status: "complete" as const,
      resultRecorded: false,
      ...(startedAt !== undefined ? { startedAt } : {}),
      args: part.arguments,
    }];
  });
}

function getWork(content: unknown): WorkItem[] {
  if (!Array.isArray(content)) return [];
  const items: WorkItem[] = [];
  content.filter(isRecord).forEach((part, index) => {
    if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
      const last = items.at(-1);
      if (last?.type === "thinking") last.text = collapseThinking(last.text, part.thinking);
      else items.push({ type: "thinking", id: `thinking-${index}`, text: part.thinking.trim() });
    } else if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      const split = splitThinkTags(part.text);
      if (split.thinking) {
        const last = items.at(-1);
        if (last?.type === "thinking") last.text = collapseThinking(last.text, split.thinking);
        else items.push({ type: "thinking", id: `thinking-text-${index}`, text: split.thinking });
      }
      if (split.text) items.push({ type: "text", id: `text-${index}`, text: split.text });
    } else if (part.type === "toolCall" && typeof part.name === "string") {
      const toolId = typeof part.id === "string" ? part.id : `content-tool-${index}`;
      items.push({ type: "tool", id: `tool-${toolId}`, toolId });
    }
  });
  return items;
}

function attachStoredToolResult(messages: ChatMessage[], result: JsonRecord): void {
  if (typeof result.toolCallId !== "string") return;
  const endedAt = normalizeTimestamp(result.timestamp);
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]!;
    const toolIndex = message.tools.findIndex((tool) => tool.id === result.toolCallId);
    if (toolIndex < 0) continue;
    const tools = [...message.tools];
    const output = stringifyToolResult(result);
    tools[toolIndex] = {
      ...tools[toolIndex]!,
      status: result.isError === true ? "error" : "complete",
      resultRecorded: true,
      ...(endedAt !== undefined ? { endedAt } : {}),
      ...(output ? { output } : {}),
    };
    messages[messageIndex] = { ...message, tools };
    return;
  }
}

function toolFromEvent(event: AgentEvent, status: ToolActivity["status"]): ToolActivity {
  const name = typeof event.toolName === "string" ? event.toolName : "tool";
  const id = typeof event.toolCallId === "string" ? event.toolCallId : `tool-${Date.now()}`;
  const timestamp = eventTimestamp(event);
  const args = event.args ?? event.input;
  const details = isRecord(event.result) ? event.result.details : undefined;
  return {
    id,
    name,
    title: toolTitle(name, args ?? details),
    status,
    ...(status === "running" ? { startedAt: timestamp } : { endedAt: timestamp }),
    args,
  };
}

function eventTimestamp(event: AgentEvent): number {
  return normalizeTimestamp(event.timestamp) ?? Date.now();
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function preferToolTitle(next: string, previous: string): string {
  if (next.startsWith("MinerU") || next.includes("GLM") || next.includes("OCR")) return next;
  return vagueToolTitle(next) && !vagueToolTitle(previous) ? previous : next;
}

function vagueToolTitle(title: string): boolean {
  return /^(Ran a command|Read files|Wrote a file|Edited files|执行命令|读取文件|写入文件|编辑文件)$/.test(title);
}

function toolTitle(name: string, args: unknown): string {
  const record = isRecord(args) ? args : {};
  const browser = BROWSER_TOOLS.find((tool) => tool.name === name);
  if (browser) return activeLocale === "zh" ? browser.label : browser.name.replace(/^browser_/, "Browser ").replaceAll("_", " ");
  const command = stringField(record, "cmd") || stringField(record, "command");
  const target = patchTarget(stringField(record, "input"));
  const file = stringField(record, "path") || stringField(record, "file_path") || target?.path || "";
  if (name.includes("exec") || name.includes("bash") || name.includes("command")) {
    return command ? commandTitle(command) : ct("cmd.ranEmpty");
  }
  if (name.includes("read")) return file ? ct("tool.read", { file }) : ct("tool.readEmpty");
  if (name.includes("write") || target?.action === "add") return file ? ct("tool.wrote", { file }) : ct("tool.wroteEmpty");
  if (name.includes("edit") || name.includes("patch")) return file ? ct("tool.edited", { file }) : ct("tool.editedEmpty");
  if (name.includes("search")) return ct("tool.search");
  if (name === "vision") return ct("tool.vision");
  if (name === "delegate") {
    const progress = delegateProgress({
      id: "preview",
      name: "delegate",
      title: "",
      status: "running",
      args,
    });
    return progress.total > 0
      ? ct("tool.delegate", { done: progress.done, total: progress.total })
      : ct("tool.delegateIdle");
  }
  return name.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function patchTarget(input: string): { action: "add" | "update" | "delete"; path: string } | undefined {
  const match = /\*\*\* (Add File|Update File|Delete File): (.+)/.exec(input);
  if (!match?.[1] || !match[2]) return undefined;
  const action = match[1] === "Add File" ? "add" : match[1] === "Delete File" ? "delete" : "update";
  return { action, path: match[2].trim() };
}

/** Raw patch / plain contents behind a write tool, for diff rendering instead of +/- text. */
export function toolWriteSource(tool: ToolActivity): { patch: string; plain: string; path: string } {
  if (tool.status === "error" || !/write|edit|patch/i.test(tool.name)) return { patch: "", plain: "", path: "" };
  const args = isRecord(tool.args) ? tool.args : {};
  const patch = stringField(args, "input");
  return {
    patch,
    plain: patch.trim() ? "" : stringField(args, "contents") || stringField(args, "content"),
    path: toolPath(tool),
  };
}

/** Code the model is writing, so the trace can show it instead of a one-line tool title. */
export function toolWritePreview(tool: ToolActivity, limit = 80): string {
  if (tool.status === "error" || !/write|edit|patch/i.test(tool.name)) return "";
  const args = isRecord(tool.args) ? tool.args : {};
  const patch = stringField(args, "input");
  if (patch.trim()) {
    const lines = splitPatch(patch)
      .filter((row) => row.kind !== "meta")
      .map((row) => (row.kind === "add" ? `+${row.next}` : row.kind === "del" ? `-${row.old}` : ` ${row.next}`));
    return clipLines(lines, limit);
  }
  return clipLines((stringField(args, "contents") || stringField(args, "content")).split("\n"), limit);
}

function clipLines(lines: string[], limit: number) {
  const text = lines.join("\n").replace(/\n+$/, "");
  if (!text.trim()) return "";
  return lines.length <= limit ? text : `${lines.slice(0, limit).join("\n")}\n…`;
}

export function toolCommand(tool: ToolActivity): string {
  const args = isRecord(tool.args) ? tool.args : {};
  return stringField(args, "cmd") || stringField(args, "command");
}

export function formatCommand(command: string): string {
  return command
    .replace(/\s*2>\s*\/dev\/null/g, "")
    .split(/\s*(?:&&|;)\s*/)
    .map((part) => part.trim())
    .filter((part) => part && !/^echo\s+["']?-/.test(part))
    .join("\n");
}

export function terminalLabel(command: string): string {
  const lines = formatCommand(command).split("\n").filter(Boolean);
  const action = [...lines].reverse().find((line) => !/^cd\s/.test(line)) ?? lines.at(-1) ?? command;
  return action.replace(/\s+/g, " ").trim();
}

function commandTitle(command: string): string {
  const lines = formatCommand(command).split("\n").filter(Boolean);
  if (lines.length === 0) return ct("cmd.ranEmpty");
  if (lines.length === 1) return ct("cmd.ran", { cmd: crop(lines[0]!, 72) });
  const bin = baseName(lines[0]!.split(/\s+/)[0] ?? "") || "command";
  return ct("cmd.ranN", { bin, n: lines.length });
}

function upsertLastAssistantTool(messages: ChatMessage[], activity: ToolActivity): ChatMessage[] {
  let index = findLastAssistant(messages, false);
  let next = messages;
  if (index < 0) {
    next = [...messages, {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      text: "",
      timestamp: activity.startedAt ?? Date.now(),
      streaming: false,
      images: [],
      tools: [],
      work: [],
    }];
    index = next.length - 1;
  }
  return next.map((message, messageIndex) => {
    if (messageIndex !== index) return message;
    const toolIndex = message.tools.findIndex((tool) => tool.id === activity.id);
    const tools = toolIndex < 0
      ? [...message.tools, activity]
      : message.tools.map((tool, current) => current === toolIndex ? {
        ...tool,
        ...activity,
        startedAt: tool.startedAt ?? activity.startedAt,
        title: preferToolTitle(activity.title, tool.title),
        args: activity.args ?? tool.args,
        output: activity.output ?? tool.output,
        details: mergeToolDetails(tool.name || activity.name, tool.details, activity.details),
      } : tool);
    const hasWorkItem = message.work.some((item) => item.type === "tool" && item.toolId === activity.id);
    const work = hasWorkItem
      ? message.work
      : [...message.work, { type: "tool" as const, id: `tool-${activity.id}`, toolId: activity.id }];
    return { ...message, tools, work };
  });
}

function mergeAssistant(message: ChatMessage, incoming: ChatMessage, streaming: boolean, startsMessage = false): ChatMessage {
  const workOffset = startsMessage ? message.work.length : message.workOffset ?? 0;
  return {
    ...message,
    streaming,
    interrupted: incoming.interrupted ?? false,
    stopReason: incoming.stopReason,
    endedAt: undefined,
    workOffset,
    text: incoming.text || message.text,
    thinking: joinThinking(message.thinking, incoming.thinking),
    timestamp: message.timestamp ?? incoming.timestamp,
    images: incoming.images.length > 0 ? incoming.images : message.images,
    work: mergeWork(message.work, incoming.work, message.tools, workOffset),
    ...(incoming.error ? { error: incoming.error } : incoming.text.trim() ? { error: undefined } : {}),
  };
}

function joinThinking(previous?: string, incoming?: string): string | undefined {
  return collapseThinking(previous, incoming) || undefined;
}

export function collapseThinking(...parts: Array<string | undefined>): string {
  const result: string[] = [];
  // 快照去重：块必须是「互不为前缀」的（下面的替换/跳过保证了这一点），所以与新块
  // 精确相等的老块至多只有一个，且它就是线性扫描会命中的第一个。先查表、查不到再扫，
  // 语义与两两比较完全一致，但追加式快照（每条 message_update 都带完整累积文本）从
  // O(块数²) 降到 O(块数)：93k 思考 ≈ 848 块，原来每次合并要几十万次 startsWith。
  const index = new Map<string, number>();
  for (const part of parts) {
    for (const piece of (part ?? "").split(/\n{2,}/)) {
      const text = piece.trim();
      if (!text) continue;
      const at = index.get(text) ?? result.findIndex((item) => item.startsWith(text) || text.startsWith(item));
      if (at < 0) {
        result.push(text);
        index.set(text, result.length - 1);
        continue;
      }
      if (text.length > result[at]!.length) {
        index.delete(result[at]!);
        result[at] = text;
        index.set(text, at);
      }
    }
  }
  return result.join("\n\n");
}

/** Pull model XML think blocks out of visible assistant text. */
export function splitThinkTags(text: string): { text: string; thinking: string } {
  if (!text) return { text: "", thinking: "" };
  const chunks: string[] = [];
  let rest = text.replace(/<(thinking|think)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_all, _tag: string, inner: string) => {
    if (inner.trim()) chunks.push(inner.trim());
    return "\n";
  });
  rest = rest.replace(/<(thinking|think)\b[^>]*>([\s\S]*)$/i, (_all, _tag: string, inner: string) => {
    if (inner.trim()) chunks.push(inner.trim());
    return "";
  });
  rest = rest.replace(/<\/?(?:thinking|think)\b[^>]*>/gi, "").replace(/\n{3,}/g, "\n\n").trim();
  return { text: rest, thinking: chunks.join("\n\n") };
}

/** Soft-structure model thinking walls so lists/sections are scannable. */
export function formatThinking(text: string): string {
  const split = splitThinkTags(text);
  return formatThinkBody(split.thinking || split.text);
}

function formatThinkBody(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/([^\n])[ \t]+(?=(?:[-*] |\d+\.\s))/g, "$1\n")
    .replace(/([^\n])[ \t]+(?=(?:Key points to report|Files to check))/gi, "$1\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Stop streaming and mark any still-running tools as interrupted when the turn ends abruptly. */
export function finalizeInterruptedTurn(messages: ChatMessage[], interrupted = false): ChatMessage[] {
  return messages.map((message, index) => {
    const last = index === messages.length - 1 && message.role === "assistant";
    const hadRunning = last && message.tools.some((tool) => tool.status === "running");
    const tools = hadRunning
      ? message.tools.map((tool) =>
        tool.status === "running"
          ? {
            ...tool,
            status: "error" as const,
            interrupted: true,
            endedAt: tool.endedAt ?? Date.now(),
            output: tool.output?.trim() || ct("error.interrupted"),
          }
          : tool,
      )
      : message.tools;
    if (!message.streaming && !message.queued && !hadRunning && !(last && interrupted)) return message;
    return { ...message, streaming: false, queued: false, tools, endedAt: message.endedAt ?? Date.now(), interrupted: message.interrupted || hadRunning || (last && interrupted) };
  });
}

export function settleStoppedTurn(messages: ChatMessage[]): ChatMessage[] {
  const last = messages.at(-1);
  if (last?.role === "assistant" && last.stopReason === "stop") return finalizeInterruptedTurn(messages);
  if (last?.role === "user") {
    const now = Date.now();
    return [...messages, { id: `${last.id}:stopped`, role: "assistant", text: "", work: [], tools: [], images: [], interrupted: true, timestamp: now, endedAt: now }];
  }
  return finalizeInterruptedTurn(messages, true);
}

export function failActiveTurn(messages: ChatMessage[], error: string): ChatMessage[] {
  const settled = settleStoppedTurn(messages);
  return settled.map((message, index) => index === settled.length - 1 && message.role === "assistant"
    ? { ...message, error, interrupted: true, streaming: false }
    : message);
}

function mergeWork(current: WorkItem[], incoming: WorkItem[], tools: ToolActivity[], offset = 0): WorkItem[] {
  const merged = incoming.length > 0 ? [...current.slice(0, offset), ...graftWork(current.slice(offset), incoming)] : current;
  const toolIds = new Set(merged.flatMap((item) => item.type === "tool" ? [item.toolId] : []));
  const missingTools = tools
    .filter((tool) => !toolIds.has(tool.id))
    .map((tool) => ({ type: "tool" as const, id: `tool-${tool.id}`, toolId: tool.id }));
  return [...merged, ...missingTools];
}

/**
 * A message snapshot only carries its own parts, so a later thought arrives without the
 * earlier ones. Update the slots the snapshot continues and append the rest, so the turn
 * keeps every thought in the order it happened.
 */
function graftWork(current: WorkItem[], incoming: WorkItem[]): WorkItem[] {
  const used = new Set<number>();
  const kept = current.map((item) => {
    const spot = incoming.findIndex((next, index) => !used.has(index) && sameSlot(item, next));
    if (spot < 0) return item;
    used.add(spot);
    return { ...incoming[spot]!, id: item.id };
  });
  return [...kept, ...incoming.filter((_, index) => !used.has(index))];
}

function sameSlot(previous: WorkItem, next: WorkItem): boolean {
  if (previous.type === "tool" && next.type === "tool") return previous.toolId === next.toolId;
  if (previous.type === "thinking" && next.type === "thinking") return previous.id === next.id;
  if (previous.type === "text" && next.type === "text") return previous.id === next.id;
  return false;
}

function findLastAssistant(messages: ChatMessage[], streamingOnly: boolean): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && (!streamingOnly || message.streaming)) return index;
  }
  return -1;
}

export function toolErrorText(tools: ToolActivity[]): string {
  return tools
    .filter((tool) => tool.status === "error")
    .map((tool) => tool.output?.trim() || ct("error.toolFailed", { title: tool.title }))
    .join("\n");
}

function stringifyToolResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return crop(value, 12_000);
  if (isRecord(value)) {
    if (typeof value.content === "string") return crop(value.content, 12_000);
    if (Array.isArray(value.content)) {
      const text = getMessageText(value.content);
      if (text) return crop(text, 12_000);
    }
    if (typeof value.error === "string" && value.error.trim()) return crop(value.error, 12_000);
    if (typeof value.message === "string" && value.message.trim()) return crop(value.message, 12_000);
  }
  try {
    return crop(JSON.stringify(value, null, 2), 12_000);
  } catch {
    return String(value);
  }
}

function toolDetails(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  if (value.details !== undefined) return value.details;
  if (Array.isArray(value.files)) return value;
}

export type DelegateTaskStatus = "pending" | "running" | "completed" | "failed";

/** 子代理运行期间的单条活动记录（运行时有界缓冲，最近约 60 条）。 */
export interface DelegateActivity {
  at: number;
  kind: "tool" | "notice" | "report";
  text: string;
  isError?: boolean;
}

export interface DelegateTaskState {
  /** 子代理委派 id（运行时的 delegationId），用于与生命周期工具结果对齐。 */
  id?: string;
  role: string;
  task: string;
  status: DelegateTaskStatus;
  /** Latest step while the child agent is running (e.g. "正在读取 …"). */
  live?: string;
  /** 本次委派的起止时间（运行时回传，用于耗时显示）。 */
  startedAt?: number;
  completedAt?: number;
  /** 已发生的工具调用与助手轮次计数（运行时回传）。 */
  toolCalls?: number;
  turns?: number;
  /** 运行期间的活动记录（有界，最近若干条）。 */
  recent?: DelegateActivity[];
  /** 子会话文件路径（主进程桥接模式回传），失败时可据此查看子代理会话。 */
  childSessionPath?: string;
  /** 子代理 token 用量（结算后由运行时回传）。 */
  usage?: { totalTokens?: number; input?: number; output?: number };
  /** 定义里 pin 的模型；未 pin 时跟随会话。 */
  model?: { providerId: string; modelId: string };
  thinkingLevel?: string;
}

export interface DelegateProgress {
  total: number;
  done: number;
  tasks: DelegateTaskState[];
}

const DELEGATE_LIFECYCLE_TOOLS = new Set(["delegate_wait", "delegate_list", "delegate_stop"]);

function lifecycleStatus(value: unknown): DelegateTaskStatus | undefined {
  if (value === "completed" || value === "truncated") return "completed";
  if (value === "failed" || value === "aborted" || value === "stopped" || value === "denied") return "failed";
  // 桥接模式的取消/中断也是终态；不能丢回 pending（会永远“进行中”）。
  if (value === "cancelled" || value === "interrupted") return "failed";
  if (value === "running" || value === "pending") return value;
  return undefined;
}

/**
 * 从生命周期工具（delegate_wait / delegate_list / delegate_stop）的结果里反推
 * 每个委派的最终状态。后台委派的 `delegate` 卡片本身不会更新，靠这里回填。
 */
export function delegationStatuses(tools: ToolActivity[]): Map<string, DelegateTaskStatus> {
  const statuses = new Map<string, DelegateTaskStatus>();
  for (const tool of tools) {
    if (!DELEGATE_LIFECYCLE_TOOLS.has(tool.name)) continue;
    const details = isRecord(tool.details) ? tool.details : {};
    const entries = [
      ...(Array.isArray(details.delegations) ? details.delegations : []),
      ...(Array.isArray(details.stopped) ? details.stopped : []),
    ];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const id = stringField(entry, "delegationId") || stringField(entry, "id");
      const status = lifecycleStatus(entry.status);
      if (id && status) statuses.set(id, status);
    }
  }
  return statuses;
}

export function delegateProgress(tool: ToolActivity, tools?: ToolActivity[]): DelegateProgress {
  const args = isRecord(tool.args) ? tool.args : {};
  const details = isRecord(tool.details) ? tool.details : {};
  const detailTasks = Array.isArray(details.tasks)
    ? details.tasks.map(normalizeDelegateTask).filter(Boolean) as DelegateTaskState[]
    : [];
  const results = Array.isArray(details.results) ? details.results : [];
  let tasks: DelegateTaskState[];
  if (detailTasks.length > 0) {
    tasks = detailTasks.map((item) => {
      const result = results.find(
        (entry) => isRecord(entry) && entry.role === item.role && entry.task === item.task,
      );
      const usage = isRecord(result) && isRecord(result.usage) ? result.usage : undefined;
      return usage ? { ...item, usage } : item;
    });
  } else {
    const argTasks = Array.isArray(args.tasks) ? args.tasks : [];
    tasks = argTasks.map((item, index) => {
      const role = isRecord(item) && typeof item.role === "string" ? item.role : "agent";
      const task = isRecord(item) && typeof item.task === "string" ? item.task : "";
      const result = results[index];
      let status: DelegateTaskStatus = tool.status === "running" ? "pending" : "completed";
      if (isRecord(result)) status = result.success === false ? "failed" : "completed";
      else if (tool.status === "running" && index < results.length) status = "completed";
      else if (tool.status === "running" && index === results.length) status = "running";
      return { role, task, status };
    });
  }
  const overrides = tools ? delegationStatuses(tools) : undefined;
  if (overrides?.size) {
    tasks = tasks.map((item) => {
      const next = item.id ? overrides.get(item.id) : undefined;
      return next && next !== item.status ? { ...item, status: next } : item;
    });
  }
  const done = typeof details.done === "number" && !overrides?.size
    ? details.done
    : tasks.filter((item) => item.status === "completed" || item.status === "failed").length;
  return {
    total: typeof details.total === "number" ? details.total : tasks.length,
    done,
    tasks,
  };
}

export function delegateToolTitle(tool: Pick<ToolActivity, "args" | "details" | "status">): string {
  const progress = delegateProgress({
    id: "delegate",
    name: "delegate",
    title: "",
    status: tool.status ?? "running",
    args: tool.args,
    details: tool.details,
  });
  return progress.total > 0
    ? ct("tool.delegate", { done: progress.done, total: progress.total })
    : ct("tool.delegateIdle");
}

export function delegateStatusLabel(status: DelegateTaskStatus): string {
  if (status === "running") return ct("trace.delegateRunning");
  if (status === "pending") return ct("trace.delegatePending");
  if (status === "failed") return ct("trace.delegateFailed");
  return ct("trace.delegateDone");
}

/** 生命周期工具（delegate_wait/list/stop）行尾的汇总 chip。 */
function delegateLifecycleChip(tool: ToolActivity): string {
  const details = isRecord(tool.details) ? tool.details : {};
  const entries = [
    ...(Array.isArray(details.delegations) ? details.delegations : []),
    ...(Array.isArray(details.stopped) ? details.stopped : []),
  ].filter(isRecord);
  if (entries.length === 0) return "";
  const statuses = entries.map((entry) => lifecycleStatus(entry.status));
  const done = statuses.filter((status) => status === "completed").length;
  const failed = statuses.filter((status) => status === "failed").length;
  const running = statuses.filter((status) => status === "running" || status === "pending").length;
  return [
    ct("trace.delegateProgress", { done, total: entries.length }),
    running ? ct("trace.delegateRunning") : "",
    failed ? ct("trace.delegateFailed") : "",
  ].filter(Boolean).join(" · ");
}

function normalizeDelegateTask(value: unknown): DelegateTaskState | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringField(value, "delegationId") || stringField(value, "id") || undefined;
  const role = typeof value.role === "string" ? value.role : "";
  const task = typeof value.task === "string" ? value.task : "";
  const live = typeof value.live === "string" && value.live.trim() ? value.live.trim() : undefined;
  // 运行时/主进程两种来源都出现过：桥接记录里是纯 modelId 字符串，进程内路径回传 {providerId, modelId}。
  const model = typeof value.model === "string" && value.model.trim()
    ? { providerId: "", modelId: value.model.trim() }
    : isRecord(value.model) && typeof value.model.providerId === "string" && typeof value.model.modelId === "string"
      ? { providerId: value.model.providerId, modelId: value.model.modelId }
      : undefined;
  const thinkingLevel = typeof value.thinkingLevel === "string" ? value.thinkingLevel : undefined;
  const startedAt = typeof value.startedAt === "number" && Number.isFinite(value.startedAt) ? value.startedAt : undefined;
  const completedAt = typeof value.completedAt === "number" && Number.isFinite(value.completedAt) ? value.completedAt : undefined;
  const toolCalls = typeof value.toolCalls === "number" && Number.isFinite(value.toolCalls) ? value.toolCalls : undefined;
  const turns = typeof value.turns === "number" && Number.isFinite(value.turns) ? value.turns : undefined;
  const recent = Array.isArray(value.recent)
    ? value.recent
      .filter(isRecord)
      .map((entry): DelegateActivity => ({
        at: typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0,
        kind: entry.kind === "notice" || entry.kind === "report" ? entry.kind : "tool",
        text: typeof entry.text === "string" ? entry.text : "",
        ...(entry.isError === true ? { isError: true as const } : {}),
      }))
      .filter((entry) => entry.text)
    : undefined;
  const childSessionPath = typeof value.childSessionPath === "string" && value.childSessionPath.trim()
    ? value.childSessionPath.trim()
    : undefined;
  const base = {
    ...(id ? { id } : {}),
    role: role || "agent",
    task,
    ...(live ? { live } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(recent?.length ? { recent } : {}),
    ...(childSessionPath ? { childSessionPath } : {}),
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
  const status = value.status;
  const normalizedStatus = lifecycleStatus(status);
  if (!normalizedStatus) {
    return role || task ? { ...base, status: "pending" } : undefined;
  }
  return { ...base, status: normalizedStatus };
}

function mergeToolDetails(name: string, previous: unknown, incoming: unknown): unknown {
  if (incoming === undefined) return previous;
  if (name !== "delegate") return incoming ?? previous;
  if (!isRecord(incoming)) return incoming ?? previous;
  const prev = isRecord(previous) ? previous : {};
  // New runtime sends cumulative { total, done, tasks, results }.
  // Live ticks may omit `results` to keep payloads small — keep the previous ones.
  if (Array.isArray(incoming.tasks) && incoming.tasks.length > 0) {
    if (!("results" in incoming) && Array.isArray(prev.results)) {
      return {
        ...prev,
        ...incoming,
        results: prev.results,
        done: typeof incoming.done === "number" ? incoming.done : prev.done,
      };
    }
    return incoming;
  }
  const prevResults = Array.isArray(prev.results) ? prev.results : [];
  const nextResults = Array.isArray(incoming.results) ? incoming.results : [];
  if (nextResults.length === 0) return { ...prev, ...incoming };
  const merged = [...prevResults];
  for (const result of nextResults) {
    if (!merged.some((item) => sameDelegateResult(item, result))) merged.push(result);
  }
  return {
    ...prev,
    ...incoming,
    results: merged,
    done: typeof incoming.done === "number" ? incoming.done : merged.length,
    total: typeof incoming.total === "number"
      ? incoming.total
      : typeof prev.total === "number" ? prev.total : merged.length,
  };
}

function sameDelegateResult(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return left === right;
  return left.role === right.role && left.task === right.task && left.output === right.output;
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface SessionFile extends FileChange {
  kind: "read" | "edit";
}

export interface SessionTodo {
  id: string;
  text: string;
  done: boolean;
  active?: boolean;
}

export function normalizeFilePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function collectFileChanges(tools: ToolActivity[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  const merge = (change: FileChange) => {
    const path = normalizeFilePath(change.path);
    const next = { ...change, path };
    const current = byPath.get(path);
    if (!current) {
      byPath.set(path, next);
      return;
    }
    byPath.set(path, {
      path,
      additions: next.additions || current.additions,
      deletions: next.deletions || current.deletions,
      patch: next.patch || current.patch,
    });
  };
  for (const tool of tools) {
    if (tool.status === "error" || !/write|edit|patch/i.test(tool.name)) continue;
    const args = isRecord(tool.args) ? tool.args : {};
    const patch = stringField(args, "input");
    if (patch) for (const change of changesFromPatch(patch)) merge(change);
    const details = isRecord(tool.details) ? tool.details : {};
    if (Array.isArray(details.files)) {
      const additions = typeof details.additions === "number" ? details.additions : 0;
      const deletions = typeof details.deletions === "number" ? details.deletions : 0;
      const files = details.files.filter((item): item is string => typeof item === "string");
      if (files.length === 1) merge({ path: files[0]!, additions, deletions });
      else for (const file of files) merge({ path: file, additions: 0, deletions: 0 });
    }
    const file = stringField(args, "path") || stringField(args, "file_path") || stringField(details, "path");
    if (file) merge({ path: file, additions: 0, deletions: 0 });
    for (const change of changesFromOutput(tool.output)) merge(change);
  }
  return [...byPath.values()];
}

export function sessionTools(messages: ChatMessage[]): ToolActivity[] {
  return [...new Map(messages.flatMap((item) => item.tools).map((tool) => [tool.id, tool])).values()];
}

export interface SessionTerminal {
  id: string;
  command: string;
}

/** Background or in-flight shell jobs the user can still see in the inspect rail. */
export function sessionTerminals(messages: ChatMessage[]): SessionTerminal[] {
  const jobs = new Map<string, string>();
  for (const message of messages) {
    for (const tool of message.tools) applySessionTerminal(jobs, tool);
  }
  return [...jobs.entries()].map(([id, command]) => ({ id, command }));
}

function applySessionTerminal(jobs: Map<string, string>, tool: ToolActivity) {
  const args = isRecord(tool.args) ? tool.args : {};
  const output = tool.output ?? "";
  const pid = stringField(args, "process_id") || output.match(/process_id:\s*(\S+)/)?.[1];
  if (/write_stdin/i.test(tool.name)) {
    if (!pid) return;
    if (args.terminate === true || /status:\s*completed|process completed/i.test(output)) jobs.delete(pid);
    return;
  }
  if (!/exec|bash|command/i.test(tool.name)) return;
  const command = stringField(args, "cmd") || stringField(args, "command") || tool.title;
  if (tool.status === "running") {
    jobs.set(pid || tool.id, command);
    return;
  }
  jobs.delete(tool.id);
  if (pid && /status:\s*running/i.test(output)) jobs.set(pid, command);
  else if (pid) jobs.delete(pid);
}

export function collectWorkingFiles(tools: ToolActivity[], mentions: string[] = []): SessionFile[] {
  const byPath = new Map<string, SessionFile>();
  for (const file of collectFileChanges(tools)) {
    byPath.set(file.path, { ...file, kind: "edit" });
  }
  for (const tool of tools) {
    if (tool.status === "error" || !/read|grep|glob|search/i.test(tool.name)) continue;
    const file = normalizeFilePath(toolPath(tool));
    if (!file || byPath.has(file)) continue;
    byPath.set(file, { path: file, kind: "read", additions: 0, deletions: 0 });
  }
  for (const file of mentions) {
    const path = normalizeFilePath(file);
    if (byPath.has(path)) continue;
    byPath.set(path, { path, kind: "read", additions: 0, deletions: 0 });
  }
  return [...byPath.values()];
}

/** Files the user attached with `@` stay openable even when the agent read them through a shell command. */
export function mentionedFiles(messages: ChatMessage[]): string[] {
  const paths = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const match of message.text.matchAll(/(?:^|\s)@(\S+)/g)) {
      const file = match[1]!.replace(/[),.;:、，。]+$/, "");
      if (file && !file.endsWith("/")) paths.add(file);
    }
  }
  return [...paths];
}

export function toolSummary(tools: ToolActivity[], thoughts = 0): string {
  const files = collectWorkingFiles(tools);
  const reads = files.filter((file) => file.kind === "read").length;
  const edits = files.filter((file) => file.kind === "edit").length;
  const commands = tools.filter((tool) => /exec|bash|command/i.test(tool.name)).length;
  const parts: string[] = [];
  if (thoughts) parts.push(ct("summary.thoughts", { n: thoughts }));
  if (reads) parts.push(ct("summary.reads", { n: reads }));
  if (commands) parts.push(ct("summary.commands", { n: commands }));
  if (edits) parts.push(ct("summary.edits", { n: edits }));
  return parts.join(ct("summary.join"));
}

export function writePayloadSize(tool: ToolActivity): number {
  const args = isRecord(tool.args) ? tool.args : {};
  const patch = stringField(args, "input");
  if (patch) {
    const added = splitPatch(patch).filter((row) => row.kind === "add").map((row) => row.next).join("\n");
    return added.length || patch.length;
  }
  return (stringField(args, "contents") || stringField(args, "content") || tool.output || "").length;
}

/** Live status line while tools run: Thinking... / Writing file... · ~N characters */
export function liveStatus(tools: ToolActivity[]): string {
  const running = [...tools].reverse().find((tool) => tool.status === "running");
  if (!running) return ct("live.thinking");
  const bytes = writePayloadSize(running);
  const count = bytes > 0
    ? ct("live.chars", { n: bytes.toLocaleString(activeLocale === "en" ? "en-US" : "zh-CN") })
    : "";
  if (/write|edit|patch/i.test(running.name)) {
    const args = isRecord(running.args) ? running.args : {};
    const file = baseName(toolPath(running) || patchTarget(stringField(args, "input"))?.path || "");
    return file ? ct("live.writing", { file, count }) : ct("live.writingFile", { count });
  }
  if (/read/i.test(running.name)) {
    const file = baseName(toolPath(running));
    return file ? ct("live.reading", { file }) : ct("live.readingFile");
  }
  if (/exec|bash|command/i.test(running.name)) return ct("live.running");
  if (running.name === "delegate_wait") {
    const details = isRecord(running.details) ? running.details : {};
    const entries = Array.isArray(details.delegations) ? details.delegations.filter(isRecord) : [];
    const active = entries.filter((entry) => entry.status === "running" || entry.status === "pending").length;
    if (entries.length > 0) return ct("live.waitingDelegations", { done: entries.length - active, total: entries.length });
  }
  if (running.name === "delegate") {
    const progress = delegateProgress(running, tools);
    const active = progress.tasks.find((item) => item.status === "running");
    if (active?.live?.trim()) return active.live.trim();
    if (progress.total > 0) return ct("live.delegating", { done: progress.done, total: progress.total });
  }
  return ct("live.thinking");
}

export function thoughtSteps(
  work: WorkItem[],
  tools: ToolActivity[],
  fallback = "",
): Array<{ text: string; tools: ToolActivity[] }> {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const steps: Array<{ text: string; tools: ToolActivity[] }> = [];
  let current: { text: string; tools: ToolActivity[] } | undefined;
  for (const item of work) {
    if (item.type === "thinking" || item.type === "text") {
      const segments = thinkingSegments(item.text);
      for (const text of segments) {
        current = { text, tools: [] };
        steps.push(current);
      }
      continue;
    }
    const tool = byId.get(item.toolId);
    if (!tool) continue;
    if (!current) {
      current = { text: "", tools: [] };
      steps.push(current);
    }
    current.tools.push(tool);
  }
  // Tool-only steps carry no narrative, so fall back to the collapsed thinking text.
  if (!steps.some((step) => step.text.trim()) && fallback.trim()) {
    const paragraphs = thinkingSegments(fallback);
    return paragraphs.map((text, index) => ({
      text,
      tools: index === paragraphs.length - 1 ? tools : [],
    }));
  }
  return steps.map((step) => ({ ...step, text: step.text ? formatThinking(step.text) : step.text }));
}

export interface TraceRow {
  id: string;
  kind: "think" | "run" | "write" | "read" | "search" | "look" | "tool";
  label: string;
  chip: string;
  /** Chips carrying code, paths or commands read better in the mono face. */
  mono: boolean;
  status?: ToolActivity["status"];
  /** Thinking markdown, for `think` rows. */
  text?: string;
  tool?: ToolActivity;
  /** 本会话全部工具：委派卡片用它回填生命周期工具给出的状态。 */
  tools?: ToolActivity[];
  /** 文件类工具的目标路径：过程区的文件行点击时用它开右侧文件标签。 */
  path?: string;
  /** 编辑/补丁行的增删统计（对齐 ZCode 的 diffCount），行内以 +N −M 展示。 */
  diff?: { added: number; removed: number };
}

/**
 * Flatten a turn into compact `label + chip` rows: consecutive thinking beats collapse into one
 * row carrying the rest as its detail, and every tool call becomes its own row.
 */
export function traceRows(work: WorkItem[], tools: ToolActivity[], fallback = ""): TraceRow[] {
  const rows: TraceRow[] = [];
  let pending: string[] = [];
  const flushThinking = () => {
    if (pending.length === 0) return;
    rows.push({
      id: `think-${rows.length}`,
      kind: "think",
      label: ct("trace.think"),
      chip: crop(headline(pending[0]!), 72),
      mono: false,
      text: pending.join("\n\n"),
    });
    pending = [];
  };
  for (const step of thoughtSteps(work, tools, fallback)) {
    if (step.text.trim()) pending.push(step.text.trim());
    if (step.tools.length === 0) continue;
    flushThinking();
    for (const tool of step.tools) {
      const row = { ...toolRow(tool, rows.length, tools), tools };
      const last = rows.at(-1);
      if (tool.name === "update_plan" && last?.tool?.name === "update_plan") {
        rows[rows.length - 1] = { ...row, id: last.id };
        continue;
      }
      rows.push(row);
    }
  }
  flushThinking();
  const lastPlan = [...rows].reverse().find((row) => row.tool?.name === "update_plan");
  if (lastPlan?.tool) {
    const steps = todosFromPlanTool(lastPlan.tool);
    if (steps?.length) lastPlan.chip = formatPlanChip(overlayPlanProgress(steps, work, tools, lastPlan.tool.id));
  }
  return rows;
}

export function toolRow(tool: ToolActivity, index = 0, tools?: ToolActivity[]): TraceRow {
  const base = { id: `row-${index}-${tool.id}`, status: tool.status, tool, mono: true };
  const name = tool.name.toLowerCase();
  if (name.startsWith("browser_")) {
    const args = isRecord(tool.args) ? tool.args : {};
    return { ...base, kind: "look", label: tool.title, chip: stringField(args, "url") || stringField(args, "name") || stringField(args, "selector") || stringField(args, "ref"), mono: false };
  }
  if (name === "delegate") {
    const progress = delegateProgress(tool, tools);
    const active = progress.tasks.find((item) => item.status === "running")
      ?? progress.tasks.find((item) => item.status === "pending")
      ?? progress.tasks[0];
    const summary = active?.task.replace(/\s+/g, " ").trim() ?? "";
    const short = summary.length > 48 ? `${summary.slice(0, 48)}…` : summary;
    const live = active?.status === "running" ? active.live?.trim() : undefined;
    const chip = [
      progress.total > 0 ? ct("trace.delegateProgress", { done: progress.done, total: progress.total }) : "",
      live || [active?.role, short].filter(Boolean).join(" · "),
    ].filter(Boolean).join(" · ");
    return { ...base, kind: "tool", label: ct("trace.delegate"), chip, mono: false };
  }
  if (name === "delegate_wait" || name === "delegate_list" || name === "delegate_stop") {
    const label = name === "delegate_wait"
      ? ct("trace.delegateWait")
      : name === "delegate_stop" ? ct("trace.delegateStop") : ct("trace.delegateList");
    return { ...base, kind: "tool", label, chip: delegateLifecycleChip(tool), mono: false };
  }
  const command = formatCommand(toolCommand(tool));
  if (command) {
    const lines = command.split("\n").filter(Boolean);
    return {
      ...base,
      kind: "run",
      label: lines.length > 1 ? ct("trace.runN", { n: lines.length }) : ct("trace.run"),
      chip: lines[0] ?? "",
    };
  }
  if (tool.name === "vision") return { ...base, kind: "look", label: ct("trace.look"), chip: "", mono: false };
  if (tool.name === "update_plan") {
    return { ...base, kind: "tool", label: ct("trace.plan"), chip: formatPlanChip(todosFromPlanTool(tool) ?? []), mono: false };
  }
  if (/web_search|fetch_content|get_search_content/.test(name)) {
    const card = parseWebSearchCard(tool.name, tool.args, tool.details, tool.output);
    return {
      ...base,
      kind: "search",
      label: name === "fetch_content" ? ct("trace.fetch") : ct("trace.web"),
      chip: card?.query || card?.url || "",
      mono: false,
    };
  }
  const args = isRecord(tool.args) ? tool.args : {};
  const file = toolPath(tool) || patchTarget(stringField(args, "input"))?.path || "";
  if (/write|edit|patch/.test(name)) {
    const lines = writtenLines(tool);
    const patch = stringField(args, "input");
    const isEdit = /edit|patch/.test(name);
    return {
      ...base,
      kind: "write",
      // 编辑/补丁行：ZCode 式「编辑 · 文件 +N −M」；整文件写入行保持「写入 N 行」
      label: isEdit ? ct("trace.edit") : lines > 0 ? ct("trace.writeLines", { n: lines }) : ct("trace.write"),
      chip: baseName(file),
      path: file || undefined,
      diff: isEdit && patch.trim() ? patchStats(patch) : undefined,
    };
  }
  if (/grep|glob|search|find/.test(name)) {
    return {
      ...base,
      kind: "search",
      label: ct("trace.search"),
      chip: stringField(args, "pattern") || stringField(args, "query") || baseName(file) || ct("trace.workspace"),
    };
  }
  if (/read|cat|view/.test(name)) return { ...base, kind: "read", label: ct("trace.read"), chip: baseName(file) || ct("trace.file"), path: file || undefined };
  return { ...base, kind: "tool", label: tool.title, chip: baseName(file), mono: Boolean(file), path: file || undefined };
}

/** 补丁的增删行数（对齐 ZCode 行内的 diffCount；只数 add/del，上下文与 hunks 不算）。 */
function patchStats(patch: string): { added: number; removed: number } {
  const rows = splitPatch(patch);
  return {
    added: rows.filter((row) => row.kind === "add").length,
    removed: rows.filter((row) => row.kind === "del").length,
  };
}

export function webSearchCard(tool: ToolActivity) {
  return parseWebSearchCard(tool.name, tool.args, tool.details, tool.output);
}

function writtenLines(tool: ToolActivity): number {
  const args = isRecord(tool.args) ? tool.args : {};
  const patch = stringField(args, "input");
  if (patch.trim()) return splitPatch(patch).filter((row) => row.kind === "add").length;
  const body = stringField(args, "contents") || stringField(args, "content");
  return body ? body.split("\n").length : 0;
}

/** Windows hands back `D:\code\app`, so both separators have to count as one. */
export function baseName(file: string): string {
  return file.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

/** Markdown thinking reads badly inside a one-line chip, so drop its syntax. */
function headline(text: string): string {
  return text
    .replace(/^[#>\s]*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/[*`_]/g, "")
    .split("\n")[0]!
    .replace(/\s+/g, " ")
    .trim();
}

function thinkingSegments(text: string): string[] {
  const formatted = formatThinking(text).trim();
  if (!formatted) return [];
  const blocks = formatted.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const lines = blocks.flatMap((block) => {
    const rows = block.split("\n").map((part) => part.trim()).filter(Boolean);
    return rows.length > 1 ? rows : [block];
  });
  if (lines.length > 1) return lines;
  if (formatted.length <= 220) return [formatted];
  return formatted
    .split(/(?<=[。！？.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => part.length > 260 ? part.match(/.{1,220}(?:\s+|$)/g)?.map((item) => item.trim()).filter(Boolean) ?? [part] : [part]);
}

/** Drop the last text beat when it is already the visible reply. */
export function omitFinalReply(work: WorkItem[], reply: string): WorkItem[] {
  const text = reply.trim();
  if (!text) return work;
  let index = -1;
  for (let current = work.length - 1; current >= 0; current -= 1) {
    if (work[current]!.type === "text") {
      index = current;
      break;
    }
  }
  if (index < 0) return work;
  const item = work[index]!;
  if (item.type !== "text") return work;
  if (item.text.includes(text) || text.includes(item.text)) return work.filter((_, current) => current !== index);
  return work;
}

export function repairMarkdownTables(text: string): string {
  return text.split(/(```[\s\S]*?```)/).map((chunk, index) => {
    if (index % 2 === 1 || !/\|[\t ]*:?-{2,}/.test(chunk)) return chunk;
    return chunk.replace(/\|\|/g, "|\n|");
  }).join("");
}

/** Drop blank fenced blocks so the UI does not paint empty gray `pre` boxes. */
export function stripEmptyMarkdown(text: string): string {
  return text
    .replace(/```[^\n]*\r?\n(?:[ \t]*\r?\n)*```/g, "")
    .replace(/```[^\n]*[ \t]*```/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function trimHttpUrl(raw: string): string {
  return raw.trim().replace(/[),.;:!?]+$/g, "");
}

export function isHttpUrl(text: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(trimHttpUrl(text));
}

export function urlChipLabel(url: string): string {
  try {
    const parsed = new URL(trimHttpUrl(url));
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.host}${path}${parsed.search}`;
  } catch {
    return trimHttpUrl(url).replace(/^https?:\/\//i, "");
  }
}

export function takeTrailingUrl(text: string, cursor: number): { next: string; url: string } | undefined {
  const before = text.slice(0, cursor);
  const match = before.match(/https?:\/\/[^\s]+$/i);
  if (!match?.[0]) return;
  const url = trimHttpUrl(match[0]);
  if (!isHttpUrl(url)) return;
  const start = before.length - match[0].length;
  return { url, next: `${text.slice(0, start)}${text.slice(cursor)}` };
}

export function splitHttpUrls(text: string): Array<{ type: "text" | "url"; value: string }> {
  const parts: Array<{ type: "text" | "url"; value: string }> = [];
  const pattern = /https?:\/\/[^\s]+/gi;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > last) parts.push({ type: "text", value: text.slice(last, index) });
    const url = trimHttpUrl(raw);
    if (isHttpUrl(url)) {
      parts.push({ type: "url", value: url });
      if (raw.length > url.length) parts.push({ type: "text", value: raw.slice(url.length) });
    } else {
      parts.push({ type: "text", value: raw });
    }
    last = index + raw.length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts.length > 0 ? parts : [{ type: "text", value: text }];
}

export function isFileChipToken(token: string): boolean {
  const path = token.startsWith("@") ? token.slice(1) : token;
  if (!path || path.endsWith("/")) return false;
  return path.includes("/") || path.includes(".");
}

/** URLs and `@path` tokens for restoring chips in the composer. */
export function splitPromptChips(text: string): Array<{ type: "text" | "url" | "file"; value: string }> {
  const parts: Array<{ type: "text" | "url" | "file"; value: string }> = [];
  for (const part of splitHttpUrls(text)) {
    if (part.type === "url") {
      parts.push(part);
      continue;
    }
    const pattern = /@[^\s]+/g;
    let last = 0;
    for (const match of part.value.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > last) parts.push({ type: "text", value: part.value.slice(last, index) });
      const raw = match[0];
      if (isFileChipToken(raw)) parts.push({ type: "file", value: raw.slice(1) });
      else parts.push({ type: "text", value: raw });
      last = index + raw.length;
    }
    if (last < part.value.length) parts.push({ type: "text", value: part.value.slice(last) });
  }
  return parts.length > 0 ? parts : [{ type: "text", value: text }];
}

export function parseFeaturesJson(input: string): SessionTodo[] {
  try {
    const data = JSON.parse(input) as unknown;
    const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.features) ? data.features : [];
    const todos: SessionTodo[] = [];
    for (const item of list) {
      if (!isRecord(item)) continue;
      const text = stringField(item, "description") || stringField(item, "text") || stringField(item, "title");
      if (!text) continue;
      todos.push({
        id: stringField(item, "id") || `feature-${todos.length}`,
        text,
        done: item.passes === true,
      });
    }
    return todos;
  } catch {
    return [];
  }
}

export function collectTodos(messages: ChatMessage[], precomputedTools?: ToolActivity[]): SessionTodo[] {
  // App 每帧都会调这里；tools 由调用方复用（sessionTools 本身也要扫全量消息），
  // 不传时保持原行为。注意 plan 进度覆盖也要用同一份，别再扫一遍。
  const tools = precomputedTools ?? sessionTools(messages);
  let fromPlan: SessionTodo[] | undefined;
  let lastPlanId: string | undefined;
  const fromTools: SessionTodo[] = [];
  for (const tool of tools) {
    const planned = todosFromPlanTool(tool);
    if (planned) {
      fromPlan = planned;
      lastPlanId = tool.id;
      continue;
    }
    if (!/todo/i.test(tool.name)) continue;
    const args = isRecord(tool.args) ? tool.args : {};
    const list = [args.todos, args.items, args.tasks].find(Array.isArray);
    if (!Array.isArray(list)) continue;
    list.forEach((item, index) => {
      if (typeof item === "string" && item.trim()) {
        fromTools.push({ id: `${tool.id}-${index}`, text: item.trim(), done: tool.status === "complete" });
        return;
      }
      if (!isRecord(item)) return;
      const text = stringField(item, "content") || stringField(item, "text") || stringField(item, "title");
      if (!text) return;
      fromTools.push({
        id: stringField(item, "id") || `${tool.id}-${index}`,
        text,
        done: item.status === "completed" || item.status === "complete" || item.done === true,
      });
    });
  }
  if (fromPlan?.length) {
    return lastPlanId
      ? overlayPlanProgress(fromPlan, turnWork(messages), tools, lastPlanId)
      : fromPlan;
  }
  if (fromTools.length) return fromTools;
  const text = messages.filter((item) => item.role === "assistant").map((item) => item.text).join("\n");
  const checks: SessionTodo[] = [];
  for (const match of text.matchAll(/^[\t ]*- \[([ xX])\] (.+)$/gm)) {
    checks.push({ id: `check-${checks.length}`, text: match[2]!.trim(), done: match[1] !== " " });
  }
  if (checks.length) return checks;
  return [];
}

/** Plan mode finished a turn with an incomplete structured plan — show approval UI. */
export function planAwaitingApproval(
  permission: PermissionMode,
  running: boolean,
  todos: SessionTodo[],
): boolean {
  if (permission !== "plan" || running || todos.length === 0) return false;
  return todos.some((item) => !item.done);
}

export type ProgressTaskStatus = "pending" | "running" | "completed" | "failed";

export type ProgressTaskKind = "plan" | "delegate";

/**
 * 底部进度浮层使用的最小任务项：仅聚合 delegate 与 plan 两类。
 * `kind` 让浮层区分两个维度——plan 是顺序的计划步骤，delegate 是并行的子代理任务，
 * 后者缩进挂在「发起时计划推进到的那一步」下面，不再平铺在列表尾部。
 */
export interface ProgressTask {
  id: string;
  subject: string;
  status: ProgressTaskStatus;
  activeForm?: string;
  kind?: ProgressTaskKind;
  /** 子代理角色（explorer / code-reviewer / …），浮层显示为 role chip。 */
  role?: string;
  /** 所属计划步骤的 id：有此字段才缩进渲染；挂在计划之前发起的子代理没有它。 */
  parentId?: string;
  /** 原始完整文本（委派 brief 全文），仅用于 tooltip，不占列表行宽。 */
  detail?: string;
}

/** 计划快照里「当前推进到」的步骤下标，用于把委派子任务挂到正确的步骤下。 */
function activePlanIndex(steps: SessionTodo[]): number {
  const running = steps.findIndex((step) => step.active);
  if (running >= 0) return running;
  const pending = steps.findIndex((step) => !step.done);
  if (pending >= 0) return pending;
  return steps.length - 1;
}

/**
 * 子代理委派行的短标题：剥掉「工作目录 <path>（…）。」这类 brief 前缀，取首句再截断；
 * 完整 brief 由调用方放进 `detail`，只在 tooltip 里出现。
 */
export function delegateTaskLabel(role: string, task: string): string {
  const flat = task.replace(/\s+/g, " ").trim();
  // 只吃掉「工作目录 <path>（注释）。」这一段：路径部分不允许空格与中文标点，
  // 否则「工作目录 /repo，请只读分析…」会把正文一起吞掉，标题反而更误导。
  const body = flat
    .replace(/^工作目录\s*[^\s，,。．；;：:（()）]*\s*(?:[（(][^）)]{0,40}[）)])?\s*[。．.：:，,、；;！!？?—-]*/, "")
    .trim() || flat;
  const sentence = body.split(/[。．!！?？;；]/)[0]?.trim() ?? "";
  const label = sentence || body;
  if (!label) return role;
  return label.length > 42 ? `${label.slice(0, 41).trimEnd()}…` : label;
}

/**
 * 聚合会话中 delegate（委派）与 plan（update_plan/规划）的进度，供底部复合浮层展示。
 * 仅聚合这两类（不包含 TaskCreate/TaskUpdate 任务工具）。
 * 输出顺序：计划步骤按计划顺序，委派子任务紧跟其所属步骤；两者维度不同（顺序 vs 并行），
 * 浮层据此分层渲染并分开计数。
 */
export function collectProgressTasks(messages: ChatMessage[], precomputedTools?: ToolActivity[]): ProgressTask[] {
  const tools = precomputedTools ?? sessionTools(messages);
  // update_plan 每推进一步都会被再调一次（同一份计划的不同快照）。只取最后一次有
  // 步骤的规划工具，否则同一份计划会按调用次数在「任务规划」列表里重复出现。
  let latestPlan: { id: string; steps: SessionTodo[] } | undefined;
  for (const tool of tools) {
    const steps = todosFromPlanTool(tool);
    if (steps) latestPlan = { id: tool.id, steps };
  }
  const steps: ProgressTask[] = (latestPlan?.steps ?? []).map((todo, index) => ({
    id: `${latestPlan?.id ?? "plan"}-${todo.id ?? index}`,
    subject: todo.text.trim() || "任务",
    status: todo.done ? "completed" : todo.active ? "running" : "pending",
    activeForm: todo.active ? todo.text.trim() : undefined,
    kind: "plan",
  }));
  // 子任务按「发起那一刻计划推进到哪一步」挂载：迭代工具时维护当前位置的计划快照。
  const children = new Map<number, ProgressTask[]>();
  const orphans: ProgressTask[] = [];
  // 同一委派 id 可能出现在多次更新里：保留首次出现的位置，用最新字段原地覆盖。
  const placed = new Map<string, ProgressTask>();
  let seenPlan: { id: string; steps: SessionTodo[] } | undefined;
  for (const tool of tools) {
    const snapshot = todosFromPlanTool(tool);
    if (snapshot) seenPlan = { id: tool.id, steps: snapshot };
    if (tool.name !== "delegate") continue;
    // 锚定到「发起那一刻正在进行的步骤」；若最后一份计划把步骤替换/重排了（文本对不上），
    // 宁可不挂，也不要钉到一个无关步骤上：这种情况平铺在列表末尾。
    let owner: number | undefined;
    if (seenPlan?.steps.length && steps.length) {
      const index = activePlanIndex(seenPlan.steps);
      const clamped = Math.min(index, steps.length - 1);
      if (steps[clamped]?.subject === seenPlan.steps[index]?.text.trim()) owner = clamped;
    }
    const progress = delegateProgress(tool, tools);
    progress.tasks.forEach((item, index) => {
      const id = item.id ?? `${tool.id}-${item.role}-${index}`;
      const status: ProgressTaskStatus = item.status === "running"
        ? "running"
        : item.status === "failed" ? "failed" : item.status === "pending" ? "pending" : "completed";
      const brief = item.task.replace(/\s+/g, " ").trim();
      const task: ProgressTask = {
        id,
        subject: delegateTaskLabel(item.role, item.task),
        status,
        activeForm: item.live?.trim() ?? undefined,
        kind: "delegate",
        role: item.role,
        ...(brief ? { detail: brief } : {}),
      };
      const previous = placed.get(id);
      if (previous) {
        Object.assign(previous, task);
        if (!task.detail) delete previous.detail;
        return;
      }
      placed.set(id, task);
      const parent = owner === undefined ? undefined : steps[owner];
      if (owner === undefined || !parent) {
        orphans.push(task);
        return;
      }
      task.parentId = parent.id;
      const list = children.get(owner) ?? [];
      list.push(task);
      children.set(owner, list);
    });
  }
  const tasks: ProgressTask[] = [];
  steps.forEach((step, index) => {
    tasks.push(step);
    tasks.push(...(children.get(index) ?? []));
  });
  tasks.push(...orphans);
  return tasks;
}

function todosFromPlanTool(tool: ToolActivity): SessionTodo[] | undefined {
  if (!/plan/i.test(tool.name)) return undefined;
  const args = isRecord(tool.args) ? tool.args : {};
  const details = isRecord(tool.details) ? tool.details : {};
  return planStepsFromUnknown(args.plan) ?? planStepsFromUnknown(details.steps) ?? planStepsFromUnknown(details.plan);
}

function planStepsFromUnknown(value: unknown): SessionTodo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const todos: SessionTodo[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) continue;
    const text = stringField(item, "step") || stringField(item, "content") || stringField(item, "text") || stringField(item, "title");
    if (!text) continue;
    const status = stringField(item, "status");
    todos.push({
      id: stringField(item, "id") || `plan-${index}`,
      text,
      done: status === "completed" || status === "complete" || item.done === true,
      ...(status === "in_progress" ? { active: true } : {}),
    });
  }
  return todos.length ? todos : undefined;
}

function formatPlanChip(steps: SessionTodo[]): string {
  const done = steps.filter((item) => item.done).length;
  const active = steps.find((item) => item.active)?.text;
  if (steps.length === 0) return "";
  return active ? `${done}/${steps.length} · ${crop(headline(active), 40)}` : `${done}/${steps.length}`;
}

/** Model often skips mid-step update_plan; count write/exec bursts after the last plan as completed steps. */
function overlayPlanProgress(
  plan: SessionTodo[],
  work: WorkItem[],
  tools: ToolActivity[],
  afterToolId: string,
): SessionTodo[] {
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  let after = false;
  let pending = false;
  let bursts = 0;
  for (const item of work) {
    if (item.type === "tool" && item.toolId === afterToolId) {
      after = true;
      continue;
    }
    if (!after) continue;
    if (item.type === "thinking" || item.type === "text") {
      if (pending) {
        bursts += 1;
        pending = false;
      }
      continue;
    }
    const tool = byId.get(item.toolId);
    if (tool && isPlanProgressWork(tool)) pending = true;
  }
  if (pending) bursts += 1;
  if (bursts === 0) return plan;
  const done = Math.min(plan.length, plan.filter((item) => item.done).length + bursts);
  return plan.map((todo, index) => {
    const { active: _active, ...rest } = todo;
    return {
      ...rest,
      done: index < done,
      ...(index === done && done < plan.length ? { active: true } : {}),
    };
  });
}

function isPlanProgressWork(tool: ToolActivity): boolean {
  if (tool.status === "error") return false;
  const name = tool.name.toLowerCase();
  if (name === "update_plan" || /read|grep|glob|search|find|list/.test(name)) return false;
  if (/exec|bash|command/.test(name)) {
    return formatCommand(toolCommand(tool)).split("\n").some((line) => line && !/^cd\s/.test(line));
  }
  return /write|edit|patch/.test(name);
}

export function toolPath(tool: ToolActivity): string {
  const args = isRecord(tool.args) ? tool.args : {};
  const details = isRecord(tool.details) ? tool.details : {};
  return stringField(args, "path") || stringField(args, "file_path") || stringField(args, "target_file") || stringField(details, "path");
}

export type SplitRow = { kind: "ctx" | "add" | "del" | "chg" | "meta"; old: string; next: string };

/** Turn apply_patch / unified hunks into git-style split rows. */
export function splitPatch(patch: string): SplitRow[] {
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  const rows: SplitRow[] = [];
  let index = 0;
  const take = (prefix: string) => {
    const chunk: string[] = [];
    while (index < lines.length && lines[index]!.startsWith(prefix) && !lines[index]!.startsWith(`${prefix}${prefix}${prefix}`)) {
      chunk.push(lines[index]!.slice(1));
      index += 1;
    }
    return chunk;
  };
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line || line.startsWith("***") || line.startsWith("@@") || line.startsWith("diff") || line.startsWith("+++") || line.startsWith("---")) {
      if (line) rows.push({ kind: "meta", old: line, next: "" });
      index += 1;
      continue;
    }
    if (line.startsWith("-") || line.startsWith("+")) {
      for (const old of line.startsWith("-") ? take("-") : []) rows.push({ kind: "del", old, next: "" });
      for (const next of take("+")) rows.push({ kind: "add", old: "", next });
      continue;
    }
    rows.push({ kind: "ctx", old: line.startsWith(" ") ? line.slice(1) : line, next: line.startsWith(" ") ? line.slice(1) : line });
    index += 1;
  }
  return rows;
}

function changesFromPatch(input: string): FileChange[] {
  if (!input.trim()) return [];
  const sections: Array<{ path: string; lines: string[] }> = [];
  let current: { path: string; lines: string[] } | undefined;
  for (const line of input.replaceAll("\r\n", "\n").split("\n")) {
    const match = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/.exec(line);
    if (match?.[1]) {
      if (current) sections.push(current);
      current = { path: match[1], lines: [line] };
      continue;
    }
    if (!current || line === "*** Begin Patch" || line === "*** End Patch") continue;
    current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections.map((section) => ({
    path: section.path,
    additions: section.lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: section.lines.filter((line) => line.startsWith("-") && !line.startsWith("---") && !line.startsWith("***")).length,
    patch: section.lines.join("\n"),
  }));
}

function changesFromOutput(output?: string): FileChange[] {
  if (!output) return [];
  const diff = /(?:diff: )?\+(\d+)\s+-(\d+)/.exec(output);
  const listed = /files:\s*(.+)/.exec(output);
    const files = listed?.[1]
    ? listed[1].split(",").map((item) => item.trim()).filter(Boolean)
    : output.split("\n").map((line) => line.trim()).filter((line) => /^(?:[\w./-]+\/)+[\w./-]+\.\w{1,12}$/.test(line) || /^(?:[\w./-]+\/)+[\w./-]+$/.test(line));
  if (files.length === 0) return [];
  const additions = diff ? Number(diff[1]) : 0;
  const deletions = diff ? Number(diff[2]) : 0;
  if (files.length === 1) return [{ path: files[0]!, additions, deletions }];
  return files.map((path) => ({ path, additions: 0, deletions: 0 }));
}

function stringField(value: JsonRecord, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

function crop(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

/** Values needed to inflate a placeholder sidebar row for a just-started thread. */
export interface SessionSeed {
  path: string;
  cwd: string;
  title: string;
  provider?: string;
  model?: string;
}

/**
 * A brand-new thread's JSONL only lands on disk after the first assistant message
 * is persisted, so a freshly refreshed thread list misses it during the first turn.
 * Insert a placeholder row (matching the eventual index entry) until the next list
 * refresh reconciles it.
 */
export function upsertSessionSummary(sessions: SessionSummary[], seed: SessionSeed, timestamp = Date.now()): SessionSummary[] {
  const id = seed.path.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") || seed.path;
  const row: SessionSummary = {
    path: seed.path,
    storagePath: seed.path,
    id,
    cwd: seed.cwd,
    title: crop(seed.title, 96),
    createdAt: new Date(timestamp).toISOString(),
    updatedAt: new Date(timestamp).toISOString(),
    ...(seed.provider ? { provider: seed.provider } : {}),
    ...(seed.model ? { model: seed.model } : {}),
    messageCount: 1,
    preview: crop(seed.title, 240),
    pinned: false,
    archived: false,
  };
  const rest = sessions.filter(
    (session) => session.id !== row.id && session.path !== row.path && session.storagePath !== row.storagePath,
  );
  return [row, ...rest];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function spliceFileMention(text: string, path: string, at: number): { next: string; caret: number } {
  const token = `@${path}`;
  const index = Math.max(0, Math.min(at, text.length));
  const left = text.slice(0, index);
  const right = text.slice(index);
  const glue = left && !/\s$/.test(left) ? " " : "";
  const next = `${left}${glue}${token} ${right}`;
  return { next, caret: left.length + glue.length + token.length + 1 };
}

export function workspaceRelative(abs: string, cwd: string): string | undefined {
  const root = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  const file = abs.replace(/\\/g, "/");
  if (file === root) return "";
  if (file.startsWith(`${root}/`)) return file.slice(root.length + 1);
}

export function filterMentionPaths(files: string[], query: string): string[] {
  const raw = query.toLowerCase();
  // Typing a folder path without trailing slash still browses one level inside it.
  const needle = raw && !raw.endsWith("/") && files.some((file) => file.toLowerCase() === `${raw}/`)
    ? `${raw}/`
    : raw;
  const filtered = files.filter((file) => {
    const lower = file.toLowerCase();
    if (!needle) {
      const trimmed = file.endsWith("/") ? file.slice(0, -1) : file;
      return !trimmed.includes("/");
    }
    // Drill-in: only the folder itself + one level of children.
    if (needle.endsWith("/")) {
      if (lower === needle) return true;
      if (!lower.startsWith(needle)) return false;
      const rest = file.slice(needle.length);
      const trimmed = rest.endsWith("/") ? rest.slice(0, -1) : rest;
      return trimmed.length > 0 && !trimmed.includes("/");
    }
    return lower.startsWith(needle) || lower.includes(`/${needle}`) || lower.includes(needle);
  });
  filtered.sort((left, right) => {
    const dir = Number(right.endsWith("/")) - Number(left.endsWith("/"));
    if (dir) return dir;
    if (needle) {
      const prefix = Number(right.toLowerCase().startsWith(needle)) - Number(left.toLowerCase().startsWith(needle));
      if (prefix) return prefix;
      if (needle.endsWith("/") && left.toLowerCase() === needle) return -1;
      if (needle.endsWith("/") && right.toLowerCase() === needle) return 1;
    }
    return left.localeCompare(right);
  });
  // Folder browse must not hide siblings; fuzzy search can stay capped.
  return needle.endsWith("/") ? filtered : filtered.slice(0, 80);
}
