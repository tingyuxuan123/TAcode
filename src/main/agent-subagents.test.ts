import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "./agent-host";
import type { AgentEvent } from "../shared/types";
import { serviceRuntimeConfig } from "../shared/provider-config";

/**
 * 真实 RPC worker 的委派冒烟：父模型调用 `delegate`，子代理跑完，报告回到父上下文。
 *
 * 用本地 mock 网关分三种请求：父代理首轮返回 delegate 工具调用；子代理返回报告；
 * 父代理后续轮次返回收尾文本。断言工具事件、卡片 details 与最终文本。
 */

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "private-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function textStream(text: string): string {
  return `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;
}

function delegateCallStream(): string {
  const args = JSON.stringify({ tasks: [{ role: "explorer", task: "Report the entry point" }] });
  return `${chunk(
    {
      role: "assistant",
      tool_calls: [
        {
          index: 0,
          id: "call_delegate",
          type: "function",
          function: { name: "delegate", arguments: args },
        },
      ],
    },
    null,
  )}${chunk({}, "tool_calls")}data: [DONE]\n\n`;
}

afterEach(() => vi.unstubAllEnvs());

describe("subagent delegation through the real RPC worker", () => {
  it("runs a subagent and returns its report to the parent turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tacode-subagent-runtime-"));
    const requests: Array<{ system: string; messages: number; body: string }> = [];
    let parentRequests = 0;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const system = String(messages.find((message) => message.role === "system")?.content ?? "");
      requests.push({ system, messages: messages.length, body });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (system.includes("subagent inside TACode")) {
        response.end(textStream("subagent-report-ok"));
        return;
      }
      parentRequests += 1;
      response.end(parentRequests === 1 ? delegateCallStream() : textStream("parent-done"));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address() as { port: number };
    const home = join(dir, "runtime-home");
    await mkdir(home);
    await writeFile(join(home, "settings.json"), JSON.stringify({ credentialStore: "file" }));
    vi.stubEnv("TETHER_HOME", home);
    vi.stubEnv("OPENAI_API_KEY", "sk-test-dummy");
    const config = serviceRuntimeConfig({
      id: "test",
      name: "Isolated gateway",
      vendorKey: "custom",
      apiStyle: "chat_completions",
      baseUrl: `http://127.0.0.1:${address.port}/gateway/v1`,
      models: [{ id: "private-model", contextWindow: 32000, maxTokens: 1024 }],
      isEnabled: true,
      createdAt: "",
      updatedAt: "",
    });

    const events: AgentEvent[] = [];
    const errors: string[] = [];
    const host = new AgentHost((event) => events.push(event), (error) => errors.push(error));
    const waitFor = async (predicate: (event: AgentEvent) => boolean) => {
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const event = events.find(predicate);
        if (event) return event;
        if (!host.isRunning()) throw new Error(`RPC exited: ${errors.join("\n")}`);
        await new Promise((done) => setTimeout(done, 25));
      }
      throw new Error(`RPC timed out: ${errors.join("\n")}\n${JSON.stringify(events).slice(-3000)}`);
    };

    try {
      await host.start({
        cwd: dir,
        provider: "openai",
        model: "private-model",
        baseUrl: config.baseUrl,
        permission: "auto",
        sandbox: "read-only",
        providerExtension: resolve("src/extensions/provider.ts"),
        desktopProvider: { config, apiKey: "" },
      });
      await host.request("prompt", { message: "Delegate the exploration." });

      const start = await waitFor(
        (event) => event.type === "tool_execution_start" && event.toolName === "delegate",
      );
      expect(start).toBeTruthy();

      const end = await waitFor(
        (event) => event.type === "tool_execution_end" && event.toolName === "delegate",
      );
      const details = (end as { result?: { details?: Record<string, unknown> } }).result?.details;
      expect(details).toMatchObject({ total: 1, done: 1 });
      expect((details?.tasks as Array<Record<string, unknown>>)[0]).toMatchObject({
        role: "explorer",
        status: "completed",
      });
      expect((details?.results as Array<Record<string, unknown>>)[0]).toMatchObject({
        role: "explorer",
        success: true,
      });
      expect(JSON.stringify(details)).toContain("subagent-report-ok");

      await waitFor((event) => event.type === "agent_end");
      expect(JSON.stringify(events)).toContain("parent-done");
      expect(errors).toEqual([]);
      // 父代理先委派、子代理请求、父代理收尾：至少 3 次模型请求。
      expect(requests.length).toBeGreaterThanOrEqual(3);
      expect(requests.some((item) => item.system.includes("subagent inside TACode"))).toBe(true);
      // 子代理目录注入系统上下文：模型看不到 ~/.tether/subagents 目录，只能猜角色名。
      expect(requests.some((item) => item.body.includes("Subagent catalog for the `delegate` tool"))).toBe(true);
      expect(requests.some((item) => item.body.includes("- explorer:") && item.body.includes("maxTurns 40"))).toBe(true);
    } finally {
      await host.stop();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
