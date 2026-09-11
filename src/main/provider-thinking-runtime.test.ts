import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "./agent-host";
import { serviceRuntimeConfig } from "../shared/provider-config";
import { levelsForModel, pickEffortOptions } from "../shared/thinking";
import type { AgentEvent, AgentSnapshot } from "../shared/types";

function reply(model: string): string {
  return [
    { type: "message_start", message: { id: "test", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

afterEach(() => vi.unstubAllEnvs());

function openAiChatReply(): string {
  return [
    { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
    { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

function openAiResponsesReply(): string {
  const item = { id: "msg", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
  return [
    { type: "response.created", response: { id: "resp", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
    { type: "response.content_part.added", item_id: "msg", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "OK" },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp", status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

it.each([
  ["chat_completions", "reasoning_effort"],
  ["responses", "reasoning"],
] as const)("sends %s thinking depth in that protocol's own field shape", async (style, field) => {
  const dir = await mkdtemp(join(tmpdir(), `tacode-thinking-${style}-`));
  const requests: Array<Record<string, unknown>> = [];
  const events: AgentEvent[] = [];
  const errors: string[] = [];
  const host = new AgentHost((event) => events.push(event), (error) => errors.push(error));
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body) as Record<string, unknown>);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(style === "responses" ? openAiResponsesReply() : openAiChatReply());
  });
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as { port: number };
    await writeFile(join(dir, "settings.json"), JSON.stringify({ credentialStore: "file" }));
    vi.stubEnv("TACODE_HOME", dir);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const configured = ["low", "medium", "high", "xhigh", "max"];
    const config = serviceRuntimeConfig({ id: "test", name: "OpenAI gateway", vendorKey: "custom", apiStyle: style,
      baseUrl: `http://127.0.0.1:${port}/v1`, isEnabled: true, createdAt: "", updatedAt: "", models: [
        { id: "reasoning-gateway", reasoning: true, thinkingLevels: configured, contextWindow: 128000, maxTokens: 64000 },
      ] });
    await host.start({ cwd: dir, provider: "openai", model: "reasoning-gateway", permission: "plan", sandbox: "read-only",
      providerExtension: resolve("src/extensions/provider.ts"), desktopProvider: { config, apiKey: "test-service-key" } });
    const available = await host.request<{ levels: string[] }>("get_available_thinking_levels");
    expect(pickEffortOptions(available.levels)).toEqual(configured);

    await host.request("set_thinking_level", { level: "xhigh" });
    await host.request("prompt", { message: "Reply OK. Do not use tools." });
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 10000 });
    const payload = requests[0];
    // 档位原样透传：OpenAI 两类协议只是字段位置不同，Anthropic 的 thinking/output_config 一律不出现。
    if (field === "reasoning_effort") expect(payload).toMatchObject({ reasoning_effort: "xhigh" });
    else expect(payload).toMatchObject({ reasoning: { effort: "xhigh", summary: "auto" } });
    expect(payload).not.toHaveProperty("thinking");
    expect(payload).not.toHaveProperty("output_config");
    expect(errors).toEqual([]);
  } finally {
    await host.stop();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

it("dispatches configured Anthropic reasoning tiers verbatim, defaulting to adaptive effort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tacode-thinking-runtime-"));
  const requests: Array<Record<string, unknown>> = [];
  const events: AgentEvent[] = [];
  const errors: string[] = [];
  const host = new AgentHost((event) => events.push(event), (error) => errors.push(error));
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as Record<string, unknown>;
    requests.push(payload);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(reply(String(payload.model)));
  });
  try {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as { port: number };
    await writeFile(join(dir, "settings.json"), JSON.stringify({ credentialStore: "file" }));
    vi.stubEnv("TACODE_HOME", dir);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    const screenshotModel = "deepseek-v4-flash-vision-exp";
    const configured = ["low", "medium", "high", "max"];
    const config = serviceRuntimeConfig({ id: "test", name: "Thinking gateway", vendorKey: "custom", apiStyle: "anthropic_messages",
      baseUrl: `http://127.0.0.1:${port}/v1`, isEnabled: true, createdAt: "", updatedAt: "", models: [
        { id: screenshotModel, reasoning: true, supportsImages: true, thinkingLevels: configured, contextWindow: 128000, maxTokens: 64000 },
        { id: "deepseek-v4-flash", reasoning: true, thinkingLevels: ["low", "xhigh", "max"], contextWindow: 128000, maxTokens: 64000 },
        { id: "adaptive-default", reasoning: true, contextWindow: 128000, maxTokens: 64000 },
        { id: "budget-reasoner", reasoning: true, thinkingDispatch: "budget", contextWindow: 128000, maxTokens: 64000 },
        { id: "plain-chat", reasoning: false, thinkingLevels: ["max"], contextWindow: 128000, maxTokens: 64000 },
      ] });
    await host.start({ cwd: dir, provider: "openai", model: screenshotModel, permission: "plan", sandbox: "read-only",
      providerExtension: resolve("src/extensions/provider.ts"), desktopProvider: { config, apiKey: "test-service-key" } });
    const catalog = await host.request<{ models: AgentSnapshot["models"] }>("get_available_models");
    expect(pickEffortOptions(levelsForModel(screenshotModel, catalog.models))).toEqual(configured);

    const prompt = async () => {
      const completed = events.filter((event) => event.type === "agent_end").length;
      const count = requests.length;
      await host.request("prompt", { message: "Reply OK. Do not use tools." });
      await vi.waitFor(() => expect(events.filter((event) => event.type === "agent_end")).toHaveLength(completed + 1), { timeout: 10000 });
      expect(requests).toHaveLength(count + 1);
      return requests.at(-1)!;
    };
    const choose = async (modelId: string, levels: string[]) => {
      await host.request("set_model", { provider: "openai", modelId });
      const available = await host.request<{ levels: string[] }>("get_available_thinking_levels");
      expect(pickEffortOptions(available.levels)).toEqual(levels);
    };
    await choose(screenshotModel, configured);
    for (const level of ["high", "max"]) {
      await host.request("set_thinking_level", { level });
      expect(await host.request("get_state")).toMatchObject({ thinkingLevel: level, model: { id: screenshotModel } });
      expect(await prompt()).toMatchObject({ model: screenshotModel, thinking: { type: "adaptive" }, output_config: { effort: level } });
    }

    // 档位原样下发：xhigh / max 不再被改名或折算，也不需要显式声明极高/最大后才走自适应。
    await choose("deepseek-v4-flash", ["low", "xhigh", "max"]);
    for (const level of ["low", "xhigh", "max"]) {
      await host.request("set_thinking_level", { level });
      expect(await host.request("get_state")).toMatchObject({ thinkingLevel: level });
      const payload = await prompt();
      expect(payload).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: level } });
      expect(payload).not.toHaveProperty("budget_tokens");
    }

    // 未配置档位的模型默认五档，且开箱即走自适应 effort。
    await choose("adaptive-default", ["low", "medium", "high", "xhigh", "max"]);
    await host.request("set_thinking_level", { level: "medium" });
    expect(await prompt()).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "medium" } });

    // 只认 budget_tokens 的网关靠显式开关回落到 token 预算，且不发 output_config。
    await choose("budget-reasoner", ["low", "medium", "high", "xhigh", "max"]);
    await host.request("set_thinking_level", { level: "high" });
    const budgeted = await prompt();
    expect(budgeted).toMatchObject({ thinking: { type: "enabled" } });
    expect(budgeted).not.toHaveProperty("output_config");
    expect((budgeted.thinking as { budget_tokens?: number }).budget_tokens).toBeGreaterThan(0);

    await choose("plain-chat", []);

    await host.request("set_thinking_level", { level: "max" });
    expect(await host.request("get_state")).toMatchObject({ thinkingLevel: "off" });
    expect(await prompt()).not.toHaveProperty("thinking");
    expect(errors).toEqual([]);
  } finally {
    await host.stop();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
