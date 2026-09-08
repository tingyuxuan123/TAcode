import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "./agent-host";
import { serviceRuntimeConfig } from "../shared/provider-config";
import { browserText } from "../shared/browser-tools";
import type { AgentEvent } from "../shared/types";

afterEach(() => vi.unstubAllEnvs());

it("advertises browser tools to the real model request and round-trips execution over desktop IPC", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tether-browser-runtime-"));
  const calls: Record<string, unknown>[] = [];
  const execute = vi.fn(async () => browserText({ title: "本地浏览器测试页", tabId: "test-tab", elements: [] }));
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push(JSON.parse(body));
    const delta = calls.length === 1
      ? { role: "assistant", tool_calls: [{ index: 0, id: "browser-test", type: "function", function: { name: "browser_navigate", arguments: JSON.stringify({ url: "http://localhost:8080" }) } }] }
      : { role: "assistant", content: "已读取本地浏览器测试页" };
    const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(event({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] }) +
      event({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: calls.length === 1 ? "tool_calls" : "stop" }] }) + "data: [DONE]\n\n");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  const runtimeHome = join(dir, "runtime");
  await mkdir(runtimeHome);
  await writeFile(join(runtimeHome, "settings.json"), JSON.stringify({ credentialStore: "file" }));
  await writeFile(join(runtimeHome, "auth.json"), "{}");
  vi.stubEnv("TETHER_HOME", runtimeHome);
  const config = serviceRuntimeConfig({ id: "test", name: "Local browser fixture", vendorKey: "custom", apiStyle: "chat_completions", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "fixture", contextWindow: 32000, maxTokens: 1024 }], isEnabled: true, createdAt: "", updatedAt: "" });
  const events: AgentEvent[] = [];
  const errors: string[] = [];
  const host = new AgentHost((event) => events.push(event), (error) => errors.push(error), execute);
  try {
    await host.start({ cwd: dir, provider: "openai", model: "fixture", permission: "auto", sandbox: "workspace-write", providerExtension: resolve("src/extensions/provider.ts"), browserExtension: resolve("src/extensions/browser.ts"), desktopProvider: { config, apiKey: "fixture-key" } });
    await host.request("prompt", { message: "打开本地浏览器测试页" });
    const deadline = Date.now() + 15000;
    while (!events.some((event) => event.type === "agent_end") && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
    expect(errors).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0].tools)).toContain("browser_observe");
    expect(JSON.stringify(calls[0].messages)).toContain("Tether 内置浏览器");
    expect(execute).toHaveBeenCalledWith("browser_navigate", { url: "http://localhost:8080" }, expect.any(AbortSignal));
    expect(JSON.stringify(calls[1].messages)).toContain("本地浏览器测试页");
  } finally {
    await host.stop();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
