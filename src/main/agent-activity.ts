import { isAgentUiDialog } from "../shared/agent-ui";
import type { AgentEvent, AgentSessionActivity } from "../shared/types";

interface Entry {
  activity: AgentSessionActivity;
  lastSeq: number;
  turnError?: string;
  aborted: boolean;
}

/** 不保存转录，只保存每个会话最近的执行结果与仍有效的询问。 */
export class AgentActivityStore {
  private readonly entries = new Map<string, Entry>();
  private readonly retiredRuntimes = new Set<string>();
  private version = 0;

  constructor(private readonly publish: (activity: AgentSessionActivity) => void = () => {}) {}

  list(): AgentSessionActivity[] {
    return [...this.entries.values()].map(({ activity }) => structuredClone(activity));
  }

  bind(runtimeId: string, sessionPath?: string): AgentSessionActivity {
    if (this.retiredRuntimes.has(runtimeId)) throw new Error("该会话运行实例已被替换。");
    const entry = this.entry(runtimeId);
    if (sessionPath && entry.activity.sessionPath !== sessionPath) {
      // worker 重建时保留上次失败/完成结果；旧 worker 的请求不能交给新 worker。
      const previous = [...this.entries.values()].find((item) => item !== entry && item.activity.sessionPath === sessionPath);
      if (previous) {
        if (entry.activity.status === "idle" && !previous.activity.running) {
          const { status, error, unread } = previous.activity;
          entry.activity = { ...entry.activity, status, error, unread };
        }
        this.entries.delete(previous.activity.runtimeId);
        this.retiredRuntimes.add(previous.activity.runtimeId);
      }
      entry.activity = { ...entry.activity, sessionPath };
      this.commit(entry);
    }
    return structuredClone(entry.activity);
  }

  observe(event: AgentEvent): void {
    if (!event.__runtimeId || this.retiredRuntimes.has(event.__runtimeId)) return;
    const entry = this.entry(event.__runtimeId);
    if (typeof event.__seq === "number") {
      if (event.__seq <= entry.lastSeq) return;
      entry.lastSeq = event.__seq;
    }
    if (event.__sessionId && entry.activity.sessionPath !== event.__sessionId) this.bind(event.__runtimeId, event.__sessionId);
    const current = entry.activity;
    if (event.type === "agent_start") {
      entry.turnError = undefined;
      entry.aborted = false;
      entry.activity = { ...current, status: "running", running: true, pendingRequests: [], error: undefined, unread: false };
    } else if (isAgentUiDialog(event)) {
      if (current.pendingRequests.some((request) => request.id === event.id)) return;
      entry.activity = { ...current, status: "waiting", pendingRequests: [...current.pendingRequests, event], unread: true };
    } else if (event.type === "desktop_ui_request_resolved") {
      const pendingRequests = current.pendingRequests.filter((request) => request.id !== event.id);
      if (pendingRequests.length === current.pendingRequests.length) return;
      entry.activity = {
        ...current,
        pendingRequests,
        status: pendingRequests.length ? "waiting" : current.running ? "running" : current.error ? "failed" : "idle",
        unread: pendingRequests.length ? current.unread : Boolean(current.error),
      };
    } else if (event.type === "message_end" || event.type === "agent_end") {
      // 错误可能随后被自动重试恢复，等真正 settled 后再作为最终失败显示。
      const message = event.type === "message_end" ? event.message
        : Array.isArray(event.messages) ? [...event.messages].reverse().find(isAssistant) : undefined;
      if (!isAssistant(message)) return;
      entry.turnError = message.stopReason === "error"
        ? String(message.errorMessage || message.error || "Agent request failed") : undefined;
      entry.aborted = message.stopReason === "aborted";
      return;
    } else if (event.type === "auto_retry_end") {
      entry.turnError = event.success === true ? undefined
        : typeof event.finalError === "string" ? event.finalError : entry.turnError;
      return;
    } else if (event.type === "agent_settled") {
      if (!current.running && current.pendingRequests.length === 0) return;
      const error = entry.turnError ?? current.error;
      entry.activity = {
        ...current, running: false, pendingRequests: [], error,
        status: error ? "failed" : entry.aborted ? "stopped" : "completed",
        unread: !entry.aborted || Boolean(error),
      };
    } else if (event.type === "desktop_runtime_stopped") {
      if (!current.running && current.pendingRequests.length === 0) return;
      entry.activity = { ...current, running: false, pendingRequests: [], status: current.error ? "failed" : "stopped", unread: Boolean(current.error) };
    } else {
      return;
    }
    this.commit(entry);
  }

  fail(runtimeId: string, sessionPath: string | undefined, error: string, fatal: boolean): void {
    if (this.retiredRuntimes.has(runtimeId)) return;
    const entry = this.entry(runtimeId);
    if (sessionPath) this.bind(runtimeId, sessionPath);
    entry.turnError = error;
    entry.activity = {
      ...entry.activity, error, status: "failed", unread: true,
      running: fatal ? false : entry.activity.running,
      pendingRequests: fatal ? [] : entry.activity.pendingRequests,
    };
    this.commit(entry);
  }

  acknowledge(runtimeId: string, version: number): void {
    const entry = this.entries.get(runtimeId);
    if (!entry || !entry.activity.unread || entry.activity.version !== version) return;
    entry.activity = { ...entry.activity, unread: false };
    this.commit(entry);
  }

  private entry(runtimeId: string): Entry {
    let entry = this.entries.get(runtimeId);
    if (!entry) {
      entry = { activity: { runtimeId, version: 0, status: "idle", running: false, pendingRequests: [], unread: false }, lastSeq: 0, aborted: false };
      this.entries.set(runtimeId, entry);
    }
    return entry;
  }

  private commit(entry: Entry): void {
    entry.activity = { ...entry.activity, version: ++this.version };
    this.publish(structuredClone(entry.activity));
  }
}

function isAssistant(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).role === "assistant");
}
