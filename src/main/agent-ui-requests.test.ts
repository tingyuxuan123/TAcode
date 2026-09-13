import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHost } from "./agent-host";
import type { AgentEvent } from "../shared/types";

const hosts: AgentHost[] = [];
function harness(runtimeId = "a") {
  const events: AgentEvent[] = [];
  const writes: Record<string, unknown>[] = [];
  const host = new AgentHost((event) => events.push(event), () => {});
  host.runtimeId = runtimeId;
  host.sessionKey = `/${runtimeId}.jsonl`;
  hosts.push(host);
  const internals = host as unknown as { child: unknown; handleLine(line: string): void };
  const emit = (event: Record<string, unknown>) => internals.handleLine(JSON.stringify(event));
  const write = vi.fn((line: string) => {
    const request = JSON.parse(line);
    writes.push(request);
    if (request.type !== "extension_ui_response") queueMicrotask(() => emit({
      type: "response", id: request.id, success: true,
      data: request.type === "get_state" ? { sessionFile: host.sessionKey }
        : request.type === "get_messages" ? { messages: [] }
          : request.type === "get_available_models" ? { models: [] }
            : request.type === "get_available_thinking_levels" ? { levels: [] }
              : request.type === "get_commands" ? { commands: [] } : {},
    }));
    return true;
  });
  // 不创建 OS 进程；命令仍经过真实的行协议和 PendingRequest 路由。
  internals.child = { exitCode: null, stdin: { write, destroyed: false } };
  return { host, events, writes, write, emit };
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  vi.useRealTimers();
});

describe("pending Agent UI requests", () => {
  it("recovers a request from snapshots even after it falls out of the replay buffer", async () => {
    const { host, emit } = harness();
    emit({ type: "extension_ui_request", method: "confirm", id: "approval", title: "允许写入？" });
    for (let index = 0; index < 510; index += 1) emit({ type: "notification", index });
    expect(host.replaySince(0).some((event) => event.id === "approval")).toBe(false);
    const snapshot = await host.snapshot();
    expect(snapshot.pendingUiRequests).toMatchObject([{ id: "approval", __runtimeId: "a", __sessionId: "/a.jsonl" }]);
  });

  it("routes replies to their owner, sends once, and prevents payloads changing the request id", async () => {
    const a = harness("a");
    const b = harness("b");
    a.emit({ type: "extension_ui_request", method: "confirm", id: "request-a" });
    await expect(b.host.respondToUi("request-a", { confirmed: true })).rejects.toThrow("已结束");
    await a.host.respondToUi("request-a", { confirmed: true, id: "other", type: "prompt" });
    await expect(a.host.respondToUi("request-a", { confirmed: true })).rejects.toThrow("已结束");
    expect(a.writes.filter((item) => item.type === "extension_ui_response")).toEqual([{ type: "extension_ui_response", id: "request-a", confirmed: true }]);
    expect(b.writes).toEqual([]);
    expect((await a.host.snapshot()).pendingUiRequests).toEqual([]);
  });

  it("keeps an unanswered request available when writing the reply fails", async () => {
    const { host, emit, write } = harness();
    emit({ type: "extension_ui_request", method: "input", id: "request" });
    write.mockImplementationOnce(() => { throw new Error("write failed"); });
    await expect(host.respondToUi("request", { value: "value" })).rejects.toThrow("write failed");
    expect((await host.snapshot()).pendingUiRequests?.map((item) => item.id)).toEqual(["request"]);
    await host.respondToUi("request", { value: "retry" });
    expect((await host.snapshot()).pendingUiRequests).toEqual([]);
  });

  it("expires timed requests and emits a dismissal for background views", async () => {
    vi.useFakeTimers();
    const { host, emit, events } = harness();
    emit({ type: "extension_ui_request", method: "confirm", id: "timed", timeout: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(events.some((event) => event.type === "desktop_ui_request_resolved" && event.id === "timed")).toBe(true);
    await expect(host.respondToUi("timed", { confirmed: true })).rejects.toThrow("已结束");
  });

  it("cancels every pending dialog before aborting a turn", async () => {
    const { host, emit, writes } = harness();
    emit({ type: "extension_ui_request", method: "confirm", id: "first" });
    emit({ type: "extension_ui_request", method: "editor", id: "second" });
    await host.request("abort");
    expect(writes.slice(0, 3)).toMatchObject([
      { type: "extension_ui_response", id: "first", cancelled: true },
      { type: "extension_ui_response", id: "second", cancelled: true },
      { type: "abort" },
    ]);
    expect((await host.snapshot()).pendingUiRequests).toEqual([]);
  });

  it("does not retain approvals after the turn settles or the worker exits", async () => {
    const { host, emit } = harness();
    emit({ type: "extension_ui_request", method: "confirm", id: "settled" });
    emit({ type: "agent_settled" });
    expect((await host.snapshot()).pendingUiRequests).toEqual([]);
    emit({ type: "extension_ui_request", method: "confirm", id: "stopped" });
    await host.stop();
    await expect(host.respondToUi("stopped", { confirmed: true })).rejects.toThrow("No workspace");
  });
});
