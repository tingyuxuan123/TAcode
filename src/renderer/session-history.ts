import type { ChatMessage } from "./conversation";

/** 旧记录与运行时快照可能重叠；保留完整旧记录、采用更新的尾部并稳定消息 id。 */
export function mergeHistoryMessages(history: ChatMessage[], live: ChatMessage[]): ChatMessage[] {
  if (!history.length) return live;
  if (!live.length) return history;
  const identity = (message: ChatMessage) => JSON.stringify([message.role, message.timestamp, message.text, message.tools.map((tool) => tool.id)]);
  const byId = new Map(history.map((message, index) => [message.id, index]));
  const indexes = new Map<string, number[]>();
  history.forEach((message, index) => {
    const key = identity(message);
    const values = indexes.get(key) ?? [];
    values.push(index);
    indexes.set(key, values);
  });
  let overlap = -1;
  let lastMatch = -1;
  const next = live.map((message) => {
    let index = message.id.startsWith("entry-") ? byId.get(message.id)
      : indexes.get(identity(message))?.find((position) => position > lastMatch);
    // 唯一可能尚未落盘的旧消息是尾部的当前回答；快照可能包含它的新正文。
    const tail = history.at(-1)!;
    if (index === undefined && !message.id.startsWith("entry-") && message.timestamp !== undefined
      && tail.timestamp === message.timestamp && tail.role === message.role && history.length - 1 > lastMatch) index = history.length - 1;
    if (index === undefined) return message;
    if (overlap < 0) overlap = index;
    lastMatch = index;
    return message.id === history[index]!.id ? message : { ...message, id: history[index]!.id };
  });
  return [...(overlap < 0 ? history : history.slice(0, overlap)), ...next];
}
