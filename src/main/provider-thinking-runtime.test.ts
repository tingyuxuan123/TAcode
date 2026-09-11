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

it("keeps configured Anthropic reasoning tiers consistent through model switches and actual requests", async () => {
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
        { id: "deepseek-v4-flash", reasoning: true, thinkingLevels: ["minimal", "xhigh", "max"], contextWindow: 128000, maxTokens: 64000 },
        { id: "legacy-reasoner", reasoning: true, contextWindow: 128000, maxTokens: 64000 },
        { id: "forced-adaptive-4", reasoning: true, thinkingLevels: ["minimal", "low", "medium", "high"], thinkingDispatch: "adaptive", contextWindow: 128000, maxTokens: 64000 },
        { id: "forced-budget-6", reasoning: true, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"], thinkingDispatch: "budget", contextWindow: 128000, maxTokens: 64000 },
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

    await choose("deepseek-v4-flash", ["minimal", "xhigh", "max"]);
    for (const [level, effort] of [["minimal", "low"], ["xhigh", "xhigh"], ["max", "max"]]) {
      await host.request("set_thinking_level", { level });
      expect(await host.request("get_state")).toMatchObject({ thinkingLevel: level });
      expect(await prompt()).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort } });
    }

    await choose("legacy-reasoner", ["minimal", "low", "medium", "high"]);
    for (const [level, budget] of [["minimal", 1024], ["high", 16384]] as const) {
      await host.request("set_thinking_level", { level });
      const payload = await prompt();
      expect(payload).toMatchObject({ thinking: { type: "enabled", budget_tokens: budget } });
      expect(payload).not.toHaveProperty("output_config");
    }

    await choose("forced-adaptive-4", ["minimal", "low", "medium", "high"]);
    for (const [level, effort] of [["minimal", "low"], ["medium", "medium"], ["high", "high"]] as const) {
      await host.request("set_thinking_level", { level });
      expect(await prompt()).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort } });
    }

    // 显式选择 token 预算后，即使声明了极高/最大也不再走自适应。
    await choose("forced-budget-6", ["minimal", "low", "medium", "high", "xhigh", "max"]);
    for (const [level, budget] of [["low", 2048], ["max", 16384]] as const) {
      await host.request("set_thinking_level", { level });
      const payload = await prompt();
      expect(payload).toMatchObject({ thinking: { type: "enabled", budget_tokens: budget } });
      expect(payload).not.toHaveProperty("output_config");
    }

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
