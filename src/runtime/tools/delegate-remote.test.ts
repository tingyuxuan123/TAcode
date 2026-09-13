import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DelegationAction, DelegationRecordSnapshot, DelegationStatus } from "../../shared/delegation";
import { registerRemoteDelegateTools } from "./delegate";

/** 注册远程委派工具并截获 pi.on 处理器与桥接事件，用于模拟「用户停止父会话」的时序。 */
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function setup(startStatus: DelegationStatus = "running") {
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const listeners = new Set<(event: DelegationRecordSnapshot) => void>();
  const sendUserMessage = vi.fn();
  const eventHandlers = new Map<string, (event: unknown, ctx?: ExtensionContext) => void>();
  const records: DelegationRecordSnapshot[] = [];
  const request = vi.fn(async (action: DelegationAction): Promise<unknown> => {
    if (action === "wait") return {
      status: "completed",
      delegations: records.map((record) => ({ ...record, status: "completed", report: `结果 ${record.delegationId}` })),
    };
    const record: DelegationRecordSnapshot = {
      delegationId: `child-${records.length}`, parentSessionPath: "/parent.jsonl", role: "explorer", task: "检查", title: "检查",
      permission: "auto", status: startStatus, startedAt: 1,
    };
    records.push(record);
    return record;
  });
  registerRemoteDelegateTools({
    registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
    sendUserMessage,
    on: (event: string, handler: (event: unknown, ctx?: ExtensionContext) => void) => {
      const previous = eventHandlers.get(event);
      eventHandlers.set(event, (value, ctx) => { previous?.(value, ctx); handler(value, ctx); });
    },
  } as unknown as ExtensionAPI, {
    client: {
      request,
      onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    startPayload: () => ({ role: "explorer", task: "检查", cwd: "/tmp", provider: "test", sandbox: "read-only", network: false }),
  });
  const startBackground = async (): Promise<DelegationRecordSnapshot> => {
    await tools.get("delegate")!.execute(`tool-${records.length}`, { tasks: [{ role: "explorer", task: "检查" }], background: true }, undefined, undefined, {} as ExtensionContext);
    return records.at(-1)!;
  };
  const emit = (event: DelegationRecordSnapshot) => { for (const listener of listeners) listener(event); };
  cleanups.push(() => eventHandlers.get("session_shutdown")?.({}));
  return { tools, listeners, sendUserMessage, eventHandlers, startBackground, request, records, emit };
}

describe("background delegation completion notifications", () => {
  it.each<DelegationStatus>(["completed", "failed", "cancelled", "interrupted"])("handles %s after the original tool has returned", async (status) => {
    const { listeners, sendUserMessage, startBackground } = setup();
    const record = await startBackground();
    const result = { ...record, status, completedAt: 2, report: "结果" };
    for (const listener of listeners) listener(result);
    if (status === "cancelled" || status === "interrupted") expect(sendUserMessage).not.toHaveBeenCalled();
    else await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce());
    for (const listener of listeners) listener(result);
    expect(sendUserMessage.mock.calls.length).toBe(status === "cancelled" || status === "interrupted" ? 0 : 1);
  });

  it.each<DelegationStatus>(["completed", "failed", "truncated", "cancelled", "interrupted"])("启动响应已为 %s 时遵循相同的投递规则", async (status) => {
    const { sendUserMessage, startBackground } = setup(status);
    await startBackground();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sendUserMessage).toHaveBeenCalledTimes(status === "cancelled" || status === "interrupted" ? 0 : 1);
  });

  it("drops late completion reports once the parent turn was aborted by the user", async () => {
    const { listeners, sendUserMessage, eventHandlers, startBackground } = setup();
    const first = await startBackground();
    // 用户按下停止：当前 turn 以 aborted 收尾，此后到达的委派终态不再注入。
    eventHandlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "aborted" } });
    for (const listener of listeners) listener({ ...first, status: "completed", completedAt: 2, report: "结果" });
    expect(sendUserMessage).not.toHaveBeenCalled();
    // 只有真实的新输入恢复投递；自动续跑的 agent_start 不代表用户要求继续。
    eventHandlers.get("input")?.({ source: "interactive", text: "继续" });
    const second = await startBackground();
    for (const listener of listeners) listener({ ...second, status: "completed", completedAt: 3, report: "结果B" });
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce());
  });

  it("keeps delivering when a turn ends normally", async () => {
    const { listeners, sendUserMessage, eventHandlers, startBackground } = setup();
    const record = await startBackground();
    eventHandlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop" } });
    for (const listener of listeners) listener({ ...record, status: "completed", completedAt: 2, report: "结果" });
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce());
  });

  it("does not deliver a late card for reports already returned by delegate_wait", async () => {
    const { tools, listeners, sendUserMessage, startBackground } = setup();
    const record = await startBackground();
    // 父代理通过 delegate_wait 当面拿到报告：已终态的 id 从回灌集合移除。
    await tools.get("delegate_wait")!.execute("wait", { delegationIds: [record.delegationId] }, undefined, undefined, {} as ExtensionContext);
    // 之后同样的终态事件不再回灌成卡片（本地 registry.wait 的 delivered 语义对齐）。
    for (const listener of listeners) listener({ ...record, status: "completed", completedAt: 2, report: "结果" });
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("三个子代理在 wait 返回前完成，报告只通过工具交付一次", async () => {
    const { tools, request, records, emit, sendUserMessage, startBackground } = setup();
    for (let index = 0; index < 3; index += 1) await startBackground();
    let resolveWait!: (value: unknown) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => { resolveWait = resolve; }));
    const waiting = tools.get("delegate_wait")!.execute("wait", {}, undefined, undefined, {} as ExtensionContext);
    const completed = records.map((record) => ({ ...record, status: "completed" as const, report: `结果 ${record.delegationId}` }));
    for (const record of completed) emit(record);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sentWhileWaiting = sendUserMessage.mock.calls.length;
    resolveWait({ status: "completed", delegations: completed });
    await waiting;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sentWhileWaiting).toBe(0);
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("报告先于 wait 完成时先保留，父代理读取后结束也不重复通知", async () => {
    const { tools, emit, sendUserMessage, eventHandlers, startBackground } = setup();
    eventHandlers.get("agent_start")?.({});
    const record = await startBackground();
    emit({ ...record, status: "completed", report: "结果" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sendUserMessage).not.toHaveBeenCalled();
    await tools.get("delegate_wait")!.execute("wait", {}, undefined, undefined, {} as ExtensionContext);
    eventHandlers.get("agent_end")?.({});
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("父代理空闲后合并通知尚未读取的三份报告", async () => {
    const { emit, sendUserMessage, eventHandlers, startBackground } = setup();
    eventHandlers.get("agent_start")?.({});
    for (let index = 0; index < 3; index += 1) {
      const record = await startBackground();
      emit({ ...record, status: "completed", report: `结果 ${record.delegationId}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sendUserMessage).not.toHaveBeenCalled();
    eventHandlers.get("agent_end")?.({});
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce());
    for (let index = 0; index < 3; index += 1) expect(sendUserMessage.mock.calls[0][0]).toContain(`结果 child-${index}`);
  });

  it("agent_end 后会话仍在收尾时继续保留报告，真正空闲后才投递", async () => {
    const { emit, sendUserMessage, eventHandlers, startBackground } = setup();
    let idle = false;
    const context = { isIdle: () => idle } as ExtensionContext;
    eventHandlers.get("agent_start")?.({}, context);
    const record = await startBackground();
    eventHandlers.get("agent_end")?.({}, context);
    emit({ ...record, status: "completed", report: "结果" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sendUserMessage).not.toHaveBeenCalled();
    idle = true;
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce());
  });

  it("wait 失败时释放未交付的报告，之后仍只通知一次", async () => {
    const { tools, request, emit, sendUserMessage, startBackground } = setup();
    const record = await startBackground();
    let rejectWait!: (error: Error) => void;
    request.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectWait = reject; }));
    const waiting = tools.get("delegate_wait")!.execute("wait", {}, undefined, undefined, {} as ExtensionContext);
    emit({ ...record, status: "completed", report: "结果" });
    rejectWait(new Error("wait failed"));
    await expect(waiting).rejects.toThrow("wait failed");
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce());
  });

  it("wait 超时只确认已返回的终态，未完成的报告稍后仍通知", async () => {
    const { tools, request, emit, sendUserMessage, startBackground } = setup();
    const first = await startBackground();
    const second = await startBackground();
    request.mockImplementationOnce(async () => {
      const completed = { ...first, status: "completed" as const, report: "结果 A" };
      emit(completed);
      return { status: "timeout", delegations: [completed, second] };
    });
    await tools.get("delegate_wait")!.execute("wait", {}, undefined, undefined, {} as ExtensionContext);
    emit({ ...second, status: "completed", report: "结果 B" });
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce());
    expect(sendUserMessage.mock.calls[0][0]).toContain("结果 B");
    expect(sendUserMessage.mock.calls[0][0]).not.toContain("结果 A");
  });

  it("停止后自动 agent_start 不会恢复旧报告投递", async () => {
    const { emit, sendUserMessage, eventHandlers, startBackground } = setup();
    eventHandlers.get("agent_start")?.({});
    const record = await startBackground();
    emit({ ...record, status: "completed", report: "结果" });
    eventHandlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "aborted" } });
    eventHandlers.get("input")?.({ source: "extension", text: "自动消息" });
    eventHandlers.get("agent_start")?.({});
    eventHandlers.get("agent_end")?.({});
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("delegate_continue 返回的报告不会在父代理结束后再次通知", async () => {
    const { tools, request, emit, sendUserMessage, eventHandlers, startBackground } = setup();
    eventHandlers.get("agent_start")?.({});
    const record = await startBackground();
    emit({ ...record, status: "completed", report: "旧报告" });
    request.mockImplementationOnce(async () => {
      const completed = { ...record, status: "completed" as const, report: "续跑报告" };
      emit(completed);
      return completed;
    });
    const result = await tools.get("delegate_continue")!.execute("continue", { delegationId: record.delegationId, message: "继续检查" }, undefined, undefined, {} as ExtensionContext);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("续跑报告") }]);
    eventHandlers.get("agent_end")?.({});
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("关闭父会话会清理已缓存报告和事件订阅", async () => {
    const { emit, sendUserMessage, listeners, eventHandlers, startBackground } = setup();
    const record = await startBackground();
    emit({ ...record, status: "completed", report: "结果" });
    eventHandlers.get("session_shutdown")?.({});
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});
