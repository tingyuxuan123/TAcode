import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DelegationRecordSnapshot, DelegationStatus } from "../../shared/delegation";
import { registerRemoteDelegateTools } from "./delegate";

describe("background delegation completion notifications", () => {
  it.each<DelegationStatus>(["completed", "failed", "cancelled", "interrupted"])("handles %s after the original tool has returned", async (status) => {
    const tools = new Map<string, ToolDefinition<any, any, any>>();
    const listeners = new Set<(event: DelegationRecordSnapshot) => void>();
    const sendUserMessage = vi.fn();
    const record: DelegationRecordSnapshot = {
      delegationId: "child", parentSessionPath: "/parent.jsonl", role: "explorer", task: "检查", title: "检查",
      permission: "auto", status: "running", startedAt: 1,
    };
    registerRemoteDelegateTools({
      registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool), sendUserMessage,
    } as unknown as ExtensionAPI, {
      client: {
        request: async () => record,
        onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
      startPayload: () => ({ role: "explorer", task: "检查", cwd: "/tmp", provider: "test", sandbox: "read-only", network: false }),
    });
    await tools.get("delegate")!.execute("tool", { tasks: [{ role: "explorer", task: "检查" }], background: true }, undefined, undefined, {} as ExtensionContext);
    const result = { ...record, status, completedAt: 2, report: "结果" };
    for (const listener of listeners) listener(result);
    if (status === "cancelled" || status === "interrupted") expect(sendUserMessage).not.toHaveBeenCalled();
    else expect(sendUserMessage).toHaveBeenCalledOnce();
    for (const listener of listeners) listener(result);
    expect(sendUserMessage.mock.calls.length).toBe(status === "cancelled" || status === "interrupted" ? 0 : 1);
  });
});
