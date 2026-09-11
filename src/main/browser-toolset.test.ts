import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "./agent-host";
import type { AgentEvent } from "../shared/types";
import { serviceRuntimeConfig } from "../shared/provider-config";

/**
 * 真实 RPC worker 的工具集回归测试。
 *
 * 背景（会话 2026-09-11T07-13-26-347Z_01a08f50 实录）：生成过程中切换权限模式时，
 * runtime 用 `setActiveTools(options.activeTools)` 整体替换激活集，把不在 `--tools` 里的
 * `browser_*` 静默摘掉，模型随后撞 `Tool browser_navigate not found`。
 * 现在激活集由 `src/shared/tool-set.ts` 统一计算，扩展只注册贡献。
 *
 * 这里用 mock 网关记录每一轮请求真正下发的工具名——这正是模型看到的东西。
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

/** 从 chat_completions 请求体里取本次下发给模型的工具名。 */
function requestToolNames(body: string): string[] {
  const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
  return (parsed.tools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => typeof name === "string");
}

afterEach(() => vi.unstubAllEnvs());

describe("browser tools across a mid-session permission switch", () => {
  it("切到 full 之后模型仍然拿得到 browser_* 工具", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tacode-browser-toolset-"));
    const bodies: string[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      bodies.push(body);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(textStream("ok"));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address() as { port: number };

    const home = join(dir, "runtime-home");
    await mkdir(home);
    await writeFile(join(home, "settings.json"), JSON.stringify({ credentialStore: "file" }));
    vi.stubEnv("TACODE_HOME", home);
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

    try {
      await host.start({
        cwd: dir,
        provider: "openai",
        model: "private-model",
        baseUrl: config.baseUrl,
        permission: "auto",
        sandbox: "read-only",
        // 关键：TACode 的工具表里没有 browser_*（等同于默认会话）
        activeTools: ["read_file", "list_files", "search_files", "exec_command", "update_plan", "apply_patch"],
        browserExtension: resolve("src/extensions/browser.ts"),
        providerExtension: resolve("src/extensions/provider.ts"),
        desktopProvider: { config, apiKey: "" },
      });

      await host.request("prompt", { message: "first" });
      // 生成结束（mock 网关直接收尾）：此刻请求体里的工具名就是模型看到的工具。
      await new Promise((done) => setTimeout(done, 300));
      const before = requestToolNames(bodies.at(-1) ?? "{}");
      expect(before).toContain("read_file");
      expect(before).toContain("browser_navigate");
      expect(before).toContain("browser_list_tabs");

      // 复现故障动作：会话中途切换权限模式（界面上的权限选择器走的就是这条命令）。
      await host.request("prompt", { message: "/permissions full" });
      await host.request("prompt", { message: "second" });
      await new Promise((done) => setTimeout(done, 300));
      const after = requestToolNames(bodies.at(-1) ?? "{}");
      // 旧实现在这里会变成不含 browser_*，模型随后调用即 `Tool browser_navigate not found`。
      expect(after).toContain("read_file");
      expect(after).toContain("browser_navigate");
      expect(after).toContain("browser_list_tabs");

      // plan 模式（F3）：浏览器工具仍在下发给模型的表里，交互限制改由调用期拒绝
      // （否则模型会先撞一次 `Tool browser_click not found`）。
      await host.request("prompt", { message: "/permissions plan" });
      await host.request("prompt", { message: "third" });
      await new Promise((done) => setTimeout(done, 300));
      const planned = requestToolNames(bodies.at(-1) ?? "{}");
      expect(planned).toContain("read_file");
      expect(planned).toContain("update_plan");
      expect(planned).toContain("browser_navigate");
      expect(planned).toContain("browser_observe");
      // 同时确认计划模式确实在收敛基础工具（证明上面的断言不是恒真）。
      expect(planned).not.toContain("apply_patch");
    } finally {
      await host.stop().catch(() => undefined);
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

/**
 * F3：plan 模式下浏览器工具仍在表里，但交互类调用由 tool_call 钩子在调用期拒绝，
 * 给模型一句可执行的原因（对齐 Proma 的调用期 deny），而不是 `Tool … not found`。
 */
describe("plan 模式的浏览器交互限制", () => {
  it("拒绝 browser_click 并说明原因，且不触达浏览器桥接", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tacode-browser-plan-"));
    const browserCalls: string[] = [];
    let round = 0;
    const server = createServer(async (request, response) => {
      for await (const _part of request) {
        // drain
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      round += 1;
      response.end(round === 1 ? toolCallStream("browser_click", { ref: "tab-e1" }) : textStream("done"));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address() as { port: number };

    const home = join(dir, "runtime-home");
    await mkdir(home);
    await writeFile(join(home, "settings.json"), JSON.stringify({ credentialStore: "file" }));
    vi.stubEnv("TACODE_HOME", home);
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
    const host = new AgentHost(
      (event) => events.push(event),
      (error) => errors.push(error),
      async (tool) => {
        browserCalls.push(tool);
        return { content: [{ type: "text" as const, text: "browser-ok" }] };
      },
    );

    try {
      await host.start({
        cwd: dir,
        provider: "openai",
        model: "private-model",
        baseUrl: config.baseUrl,
        permission: "plan",
        sandbox: "read-only",
        providerExtension: resolve("src/extensions/provider.ts"),
        browserExtension: resolve("src/extensions/browser.ts"),
        desktopProvider: { config, apiKey: "" },
      });
      await host.request("prompt", { message: "点一下登录按钮" });

      const deadline = Date.now() + 20_000;
      let result = events.find((event) => event.type === "tool_execution_end");
      while (!result && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 25));
        result = events.find((event) => event.type === "tool_execution_end");
      }
      const text = JSON.stringify(events.filter((event) => event.type === "tool_execution_end"));
      expect(text).toContain("计划模式");
      expect(text).toContain("browser_observe");
      expect(browserCalls).toEqual([]);
    } finally {
      await host.stop().catch(() => undefined);
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 40_000);
});

function toolCallStream(name: string, args: Record<string, unknown>): string {
  return `${chunk(
    {
      role: "assistant",
      tool_calls: [
        { index: 0, id: "call_browser", type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    },
    null,
  )}${chunk({}, "tool_calls")}data: [DONE]\n\n`;
}
