import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DelegationAction, DelegationRecordSnapshot, DelegationStatus } from "../../shared/delegation";
import { registerRemoteDelegateTools } from "./delegate";

/** 注册远程委派工具并截获 pi.on 处理器与桥接事件，用于模拟「用户停止父会话」的时序。 */
function setup() {
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const listeners = new Set<(event: DelegationRecordSnapshot) => void>();
  const sendUserMessage = vi.fn();
  const eventHandlers = new Map<string, (event: unknown) => void>();
  const records: DelegationRecordSnapshot[] = [];
  registerRemoteDelegateTools({
    registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
    sendUserMessage,
    on: (event: string, handler: (event: unknown) => void) => { eventHandlers.set(event, handler); },
  } as unknown as ExtensionAPI, {
    client: {
      request: async (action: DelegationAction) => {
        if (action === "wait") {
          // 桥接 wait 返回的是当前快照：已终态的委派带终态状态。
          const last = records.at(-1);
          return { status: "completed", delegations: last ? [{ ...last, status: "completed" as const }] : [] };
        }
        const record: DelegationRecordSnapshot = {
          delegationId: `child-${records.length}`, parentSessionPath: "/parent.jsonl", role: "explorer", task: "检查", title: "检查",
          permission: "auto", status: "running", startedAt: 1,
        };
        records.push(record);
        return record;
      },
      onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    },
    startPayload: () => ({ role: "explorer", task: "检查", cwd: "/tmp", provider: "test", sandbox: "read-only", network: false }),
  });
  const startBackground = async (): Promise<DelegationRecordSnapshot> => {
    await tools.get("delegate")!.execute(`tool-${records.length}`, { tasks: [{ role: "explorer", task: "检查" }], background: true }, undefined, undefined, {} as ExtensionContext);
    return records.at(-1)!;
  };
  return { tools, listeners, sendUserMessage, eventHandlers, startBackground };
}

describe("background delegation completion notifications", () => {
  it.each<DelegationStatus>(["completed", "failed", "cancelled", "interrupted"])("handles %s after the original tool has returned", async (status) => {
    const { listeners, sendUserMessage, startBackground } = setup();
    const record = await startBackground();
    const result = { ...record, status, completedAt: 2, report: "结果" };
    for (const listener of listeners) listener(result);
    if (status === "cancelled" || status === "interrupted") expect(sendUserMessage).not.toHaveBeenCalled();
    else expect(sendUserMessage).toHaveBeenCalledOnce();
    for (const listener of listeners) listener(result);
    expect(sendUserMessage.mock.calls.length).toBe(status === "cancelled" || status === "interrupted" ? 0 : 1);
  });

  it("drops late completion reports once the parent turn was aborted by the user", async () => {
    const { listeners, sendUserMessage, eventHandlers, startBackground } = setup();
    const first = await startBackground();
    // 用户按下停止：当前 turn 以 aborted 收尾，此后到达的委派终态不再注入。
    eventHandlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "aborted" } });
    for (const listener of listeners) listener({ ...first, status: "completed", completedAt: 2, report: "结果" });
    expect(sendUserMessage).not.toHaveBeenCalled();
    // 真实的新输入（agent_start）之后恢复注入，迟到的报告才回到父会话。
    eventHandlers.get("agent_start")?.({});
    const second = await startBackground();
    for (const listener of listeners) listener({ ...second, status: "completed", completedAt: 3, report: "结果B" });
    expect(sendUserMessage).toHaveBeenCalledOnce();
  });

  it("keeps delivering when a turn ends normally", async () => {
    const { listeners, sendUserMessage, eventHandlers, startBackground } = setup();
    const record = await startBackground();
    eventHandlers.get("turn_end")?.({ message: { role: "assistant", stopReason: "stop" } });
    for (const listener of listeners) listener({ ...record, status: "completed", completedAt: 2, report: "结果" });
    expect(sendUserMessage).toHaveBeenCalledOnce();
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
});
