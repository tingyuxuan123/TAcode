import { describe, expect, it } from "vitest";
import { AgentActivityStore } from "./agent-activity";
import type { AgentEvent } from "../shared/types";

function harness() {
  const store = new AgentActivityStore();
  const sequences = new Map<string, number>();
  const emit = (runtimeId: string, event: AgentEvent) => {
    const seq = (sequences.get(runtimeId) ?? 0) + 1;
    sequences.set(runtimeId, seq);
    store.observe({ ...event, __runtimeId: runtimeId, __sessionId: `/${runtimeId}.jsonl`, __seq: seq });
  };
  return { store, emit, current: (id: string) => store.list().find((item) => item.runtimeId === id)! };
}

describe("session activity recovery", () => {
  it("keeps background requests independently and answers one without clearing another", () => {
    const { store, emit, current } = harness();
    emit("a", { type: "agent_start" });
    emit("b", { type: "agent_start" });
    emit("a", { type: "extension_ui_request", id: "a-1", method: "confirm", title: "允许写入？" });
    emit("a", { type: "extension_ui_request", id: "a-2", method: "input", title: "分支名称" });
    expect(current("a")).toMatchObject({ status: "waiting", running: true, unread: true });
    expect(current("b")).toMatchObject({ status: "running", pendingRequests: [] });
    const snapshot = store.list();
    expect(snapshot.find((item) => item.runtimeId === "a")?.pendingRequests.map((item) => item.id)).toEqual(["a-1", "a-2"]);
    emit("a", { type: "desktop_ui_request_resolved", id: "a-1" });
    expect(current("a").pendingRequests.map((item) => item.id)).toEqual(["a-2"]);
    emit("a", { type: "desktop_ui_request_resolved", id: "a-2" });
    expect(current("a")).toMatchObject({ status: "running", pendingRequests: [], unread: false });
  });

  it("does not classify a failed background turn as successful completion", () => {
    const { emit, current } = harness();
    emit("a", { type: "agent_start" });
    emit("a", { type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "gateway unavailable" }] });
    expect(current("a").status).toBe("running");
    emit("a", { type: "agent_settled" });
    expect(current("a")).toMatchObject({ status: "failed", error: "gateway unavailable", running: false, unread: true });
  });

  it("lets a successful retry replace the earlier model failure", () => {
    const { emit, current } = harness();
    emit("a", { type: "agent_start" });
    emit("a", { type: "agent_end", willRetry: true, messages: [{ role: "assistant", stopReason: "error", errorMessage: "temporary" }] });
    emit("a", { type: "auto_retry_end", success: true });
    emit("a", { type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    emit("a", { type: "agent_settled" });
    expect(current("a")).toMatchObject({ status: "completed", error: undefined, unread: true });
  });

  it("does not clear a newer notification with an acknowledgement of an older version", () => {
    const { store, emit, current } = harness();
    emit("a", { type: "agent_start" });
    emit("a", { type: "extension_ui_request", id: "first", method: "confirm" });
    const version = current("a").version;
    emit("a", { type: "extension_ui_request", id: "second", method: "confirm" });
    store.acknowledge("a", version);
    expect(current("a").unread).toBe(true);
    store.acknowledge("a", current("a").version);
    expect(current("a")).toMatchObject({ unread: false, status: "waiting" });
    expect(current("a").pendingRequests).toHaveLength(2);
  });

  it("keeps completion read after a duplicate settled event", () => {
    const { store, emit, current } = harness();
    emit("a", { type: "agent_start" });
    emit("a", { type: "agent_settled" });
    store.acknowledge("a", current("a").version);
    emit("a", { type: "agent_settled" });
    expect(current("a")).toMatchObject({ status: "completed", unread: false });
  });

  it("clears requests on stop and retains fatal errors across worker replacement", () => {
    const { store, emit, current } = harness();
    emit("a", { type: "agent_start" });
    emit("a", { type: "extension_ui_request", id: "request", method: "confirm" });
    store.fail("a", "/a.jsonl", "worker exited", true);
    emit("a", { type: "desktop_runtime_stopped" });
    expect(current("a")).toMatchObject({ status: "failed", pendingRequests: [], running: false });
    store.bind("replacement", "/a.jsonl");
    expect(current("replacement")).toMatchObject({ status: "failed", error: "worker exited", unread: true, pendingRequests: [] });
    store.observe({ type: "agent_start", __runtimeId: "a", __sessionId: "/a.jsonl", __seq: 500 });
    expect(store.list()).toHaveLength(1);
    expect(current("replacement").status).toBe("failed");
    store.observe({ type: "agent_start", __runtimeId: "replacement", __sessionId: "/a.jsonl", __seq: 1 });
    expect(current("replacement")).toMatchObject({ status: "running", error: undefined, unread: false });
  });

  it("treats user cancellation as stopped, not a successful unread result", () => {
    const { emit, current } = harness();
    emit("a", { type: "agent_start" });
    emit("a", { type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
    emit("a", { type: "agent_settled" });
    expect(current("a")).toMatchObject({ status: "stopped", unread: false });
  });
});
