import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { AgentEvent } from "../shared/types";
import { applyAgentEvent, type ChatMessage } from "./conversation";
import { createStreamScheduler } from "./stream-scheduler";

/** 消息归并始终继续，隐藏面板只保留一份最新消息，不为每个 token 发布 React 状态。 */
export class PanelMessageStream {
  private current: ChatMessage[] = [];
  private published = this.current;
  private visible = false;
  private listeners = new Set<() => void>();
  private scheduler?: ReturnType<typeof createStreamScheduler>;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.published;
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) { this.scheduler?.flush(); this.publish(); }
  }
  push = (event: AgentEvent): void => {
    this.scheduler ??= createStreamScheduler((events) => {
      this.current = events.reduce(applyAgentEvent, this.current);
      this.publish();
    });
    this.scheduler.push(event);
  };
  replace = (value: ChatMessage[] | ((messages: ChatMessage[]) => ChatMessage[])): void => {
    this.scheduler?.flush();
    this.current = typeof value === "function" ? value(this.current) : value;
    this.publish();
  };
  clearPending(): void { this.scheduler?.clear(); }
  dispose(): void { this.scheduler?.dispose(); this.scheduler = undefined; }
  private publish(): void {
    if (!this.visible || this.published === this.current) return;
    this.published = this.current;
    for (const listener of this.listeners) listener();
  }
}

export function usePanelMessageStream(active: boolean) {
  const [stream] = useState(() => new PanelMessageStream());
  const messages = useSyncExternalStore(stream.subscribe, stream.getSnapshot, stream.getSnapshot);
  useLayoutEffect(() => { stream.setVisible(active); }, [active, stream]);
  useEffect(() => () => stream.dispose(), [stream]);
  const clearPending = useCallback(() => stream.clearPending(), [stream]);
  return { messages, setMessages: stream.replace, push: stream.push, clearPending };
}
