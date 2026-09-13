import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "../shared/types";
import { serviceRuntimeConfig } from "../shared/provider-config";
import { AgentHost } from "./agent-host";
import { SkillsManager } from "./skills-manager";
import { McpManager } from "./mcp-manager";

const sse = (delta: Record<string, unknown>, finish: string): string => [
  { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
  { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: finish }] },
].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";

interface ModelRequest {
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content: unknown }>;
}

afterEach(() => vi.unstubAllEnvs());

describe("Skills / MCP 真实 Agent 链路", () => {
  it("现有会话重载技能，MCP 工具真正执行，停用和 plan 模式会移除工具", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tacode-capability-runtime-"));
    const home = path.join(root, "home"); const project = path.join(root, "project");
    await fsp.mkdir(home); await fsp.mkdir(project);
    await fsp.writeFile(path.join(home, "settings.json"), JSON.stringify({ credentialStore: "file" }));
    vi.stubEnv("TACODE_HOME", home);
    new ProjectTrustStore(home).set(project, true);
    const requests: ModelRequest[] = [];
    const server = createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk;
      const modelRequest = JSON.parse(body) as ModelRequest; requests.push(modelRequest);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const echo = modelRequest.tools?.find((tool) => tool.function.name.startsWith("mcp__") && tool.function.name.includes("echo"));
      const afterTool = modelRequest.messages.at(-1)?.role === "tool";
      if (echo && !afterTool) response.end(sse({ role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: echo.function.name, arguments: '{"text":"runtime MCP works"}' } }] }, "tool_calls"));
      else response.end(sse({ role: "assistant", content: "Done." }, "stop"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const config = serviceRuntimeConfig({ id: "capability-test", name: "Local fixture", vendorKey: "custom", apiStyle: "chat_completions", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: [{ id: "fixture", contextWindow: 32000, maxTokens: 1024 }], isEnabled: true, createdAt: "", updatedAt: "" });
    const events: AgentEvent[] = []; const errors: string[] = [];
    const host = new AgentHost((event) => events.push(event), (error) => errors.push(error));
    const skills = new SkillsManager(path.join(root, "user")); const mcp = new McpManager();
    const prompt = async (message: string) => {
      const before = events.filter((event) => event.type === "agent_settled").length;
      await host.request("prompt", { message });
      const deadline = Date.now() + 12_000;
      while (events.filter((event) => event.type === "agent_settled").length <= before && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events.filter((event) => event.type === "agent_settled").length, errors.join("\n")).toBeGreaterThan(before);
    };
    const commands = async () => (await host.request<{ commands: Array<{ name: string }> }>("get_commands")).commands.map((command) => command.name);
    try {
      await host.start({ cwd: project, provider: "openai", model: "fixture", permission: "full", sandbox: "danger-full-access", providerExtension: path.resolve("src/extensions/provider.ts"), desktopProvider: { config, apiKey: "" } });
      const skill = await skills.create("---\nname: runtime-skill\ndescription: Runtime reload fixture\n---\n\nOnly say done.\n", "project", project);
      host.invalidateCapabilities();
      expect(await commands()).toContain("skill:runtime-skill");
      await skills.setEnabled(skill.id, false, project); host.invalidateCapabilities();
      expect(await commands()).not.toContain("skill:runtime-skill");
      await skills.setEnabled(skill.id, true, project); host.invalidateCapabilities();
      expect(await commands()).toContain("skill:runtime-skill");
      // 仅扩展重载命令不能偷偷触发模型请求。
      expect(requests).toEqual([]);

      await mcp.save({ name: "fixture", kind: "stdio", command: process.execPath, args: [path.resolve("scripts/fixtures/mcp-server.mjs")] }, undefined, "project", project);
      host.invalidateCapabilities();
      await prompt("Use the fixture tool once.");
      expect(events.some((event) => event.type === "tool_execution_end" && String(event.toolName).startsWith("mcp__"))).toBe(true);
      expect(JSON.stringify(requests.at(-1)?.messages)).toContain("runtime MCP works");

      await host.request("prompt", { message: "/permissions plan" });
      await prompt("Now just reply.");
      expect(requests.at(-1)?.tools?.some((tool) => tool.function.name.startsWith("mcp__"))).toBe(false);
      await host.request("prompt", { message: "/permissions full" });
      await mcp.setEnabled("fixture", false, "project", project); host.invalidateCapabilities();
      await prompt("Reply without MCP.");
      expect(requests.at(-1)?.tools?.some((tool) => tool.function.name.startsWith("mcp__"))).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await host.stop();
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 35_000);
});
