import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "./agent-host";
import type { AgentEvent } from "../shared/types";
import { serviceRuntimeConfig } from "../shared/provider-config";
import {
  DELEGATION_BRIDGE_EVENT,
  type DelegationBridgeRequest,
  type DelegationRecordSnapshot,
} from "../shared/delegation";

interface ModelRequest {
  messages: Array<{ role: string; content?: unknown }>;
}

function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-delivery-test", object: "chat.completion.chunk", created: 0,
    model: "private-model", choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function textStream(text: string): string {
  return `${chunk({ role: "assistant", content: text })}${chunk({}, "stop")}data: [DONE]\n\n`;
}

function toolStream(name: string, args: Record<string, unknown>): string {
  return `${chunk({ role: "assistant", tool_calls: [{
    index: 0, id: `call_${name}`, type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }] })}${chunk({}, "tool_calls")}data: [DONE]\n\n`;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

/** 真实 RPC worker + 本地模型网关；委派桥只控制完成事件与 wait 响应的先后顺序。 */
async function runtime(
  respond: (requestNumber: number, response: ServerResponse) => void,
  handleDelegation?: (request: DelegationBridgeRequest, host: AgentHost) => Promise<unknown>,
) {
  const dir = await mkdtemp(join(tmpdir(), "tacode-delegation-delivery-"));
  const requests: ModelRequest[] = [];
  const events: AgentEvent[] = [];
  const errors: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    requests.push(JSON.parse(body) as ModelRequest);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    respond(requests.length, response);
  });
  const host = new AgentHost((event) => events.push(event), (error) => errors.push(error), undefined, undefined, undefined, handleDelegation);
  cleanups.push(async () => {
    await host.stop();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  const runtimeHome = join(dir, "runtime-home");
  await mkdir(runtimeHome);
  await writeFile(join(runtimeHome, "settings.json"), JSON.stringify({ credentialStore: "file" }));
  vi.stubEnv("TACODE_HOME", runtimeHome);
  vi.stubEnv("OPENAI_API_KEY", "sk-test-dummy");
  const config = serviceRuntimeConfig({
    id: "test", name: "Isolated gateway", vendorKey: "custom", apiStyle: "chat_completions",
    baseUrl: `http://127.0.0.1:${port}/gateway/v1`,
    models: [{ id: "private-model", contextWindow: 32000, maxTokens: 1024 }],
    isEnabled: true, createdAt: "", updatedAt: "",
  });
  await host.start({
    cwd: dir, provider: "openai", model: "private-model", baseUrl: config.baseUrl,
    permission: "auto", sandbox: "read-only",
    providerExtension: resolve("src/extensions/provider.ts"),
    desktopProvider: { config, apiKey: "" },
  });
  const waitForEvent = async (predicate: (event: AgentEvent) => boolean) => {
    await vi.waitFor(() => {
      expect(host.isRunning(), errors.join("\n")).toBe(true);
      expect(events.some(predicate), JSON.stringify(events.slice(-5))).toBe(true);
    }, { timeout: 10_000, interval: 25 });
  };
  const userMessages = async () => {
    const history = await host.request<{ messages: Array<{ role: string; content: unknown }> }>("get_messages");
    return history.messages.filter((message) => message.role === "user");
  };
  return { host, requests, events, errors, waitForEvent, userMessages };
}

describe("delegation report delivery through the real RPC worker", () => {
  it("三个完成事件先于 delegate_wait 响应到达，主代理只收尾一次", async () => {
    const records: DelegationRecordSnapshot[] = [];
    const { host, requests, events, errors, waitForEvent, userMessages } = await runtime((requestNumber, response) => {
      if (requestNumber === 1) {
        response.end(toolStream("delegate", {
          tasks: Array.from({ length: 3 }, (_, index) => ({ role: "explorer", task: `Inspect part ${index}` })),
          background: true,
        }));
      } else if (requestNumber === 2) {
        response.end(toolStream("delegate_wait", { timeoutSeconds: 5 }));
      } else {
        response.end(textStream("parent-conclusion"));
      }
    }, async (request, parent) => {
      if (request.action === "start") {
        const record: DelegationRecordSnapshot = {
          delegationId: `child-${records.length}`, parentSessionPath: request.parentSessionPath,
          role: "explorer", task: `Inspect part ${records.length}`, title: "检查",
          permission: "auto", status: "running", startedAt: Date.now(),
        };
        records.push(record);
        return record;
      }
      if (request.action === "wait") {
        const completed = records.map((record) => ({
          ...record, status: "completed" as const, completedAt: Date.now(), report: `complete report-${record.delegationId}`,
        }));
        for (const record of completed) parent.sendDelegationEvent({ type: DELEGATION_BRIDGE_EVENT, event: record });
        // 让旧实现有时间把三个报告排入 Pi，再交还工具结果，复现真实会话时序。
        await new Promise((done) => setTimeout(done, 250));
        return { status: "completed", delegations: completed };
      }
      throw new Error(`Unexpected delegation action: ${request.action}`);
    });
    await host.request("prompt", { message: "Inspect three parts and summarize their reports." });
    await waitForEvent((event) => event.type === "agent_end");
    // 覆盖空闲后的报告投递延迟，同时等待可能被错误触发的续跑结束。
    await host.waitForIdle({ startGraceMs: 400 });
    expect(errors).toEqual([]);
    expect(records).toHaveLength(3);
    expect(requests).toHaveLength(3);
    for (const record of records) expect(JSON.stringify(requests[2])).toContain(`report-${record.delegationId}`);
    expect(await userMessages()).toHaveLength(1);
    const conclusions = events.filter((event) => event.type === "message_end" && JSON.stringify(event.message).includes("parent-conclusion"));
    expect(conclusions).toHaveLength(1);
    expect(await host.request("get_state")).toMatchObject({ isStreaming: false, pendingMessageCount: 0 });
  }, 30_000);

  it("停止一次就清掉三条已排队的自动报告，用户新消息仍可正常执行", async () => {
    const { host, requests, errors, waitForEvent, userMessages } = await runtime((requestNumber, response) => {
      if (requestNumber === 1) {
        response.write(chunk({ role: "assistant", content: "working" }));
        // 首轮保持生成状态，直到用户 abort 关闭连接。
      } else {
        response.end(textStream("fresh-response"));
      }
    });
    await host.request("prompt", { message: "Start working." });
    await waitForEvent((event) => event.type === "message_update" && JSON.stringify(event).includes("working"));
    for (let index = 0; index < 3; index += 1) {
      await host.request("follow_up", { message: `automatic-child-report-${index}` });
    }
    expect(await host.request("get_state")).toMatchObject({ pendingMessageCount: 3 });
    await host.request("abort");
    await host.waitForIdle({ startGraceMs: 400 });
    expect(requests).toHaveLength(1);
    expect(await userMessages()).toHaveLength(1);
    expect(await host.request("get_state")).toMatchObject({ isStreaming: false, pendingMessageCount: 0 });

    await host.request("prompt", { message: "Continue with fresh user input." });
    await host.waitForIdle();
    expect(requests).toHaveLength(2);
    const messages = await userMessages();
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[1])).toContain("Continue with fresh user input.");
    expect(errors).toEqual([]);
  }, 30_000);
});
