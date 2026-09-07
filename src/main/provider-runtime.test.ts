import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getTetherRpcEntryPath } from "tether-agent-core";
import { serviceRuntimeConfig } from "../shared/provider-config";
import type { CatalogApiStyle } from "../shared/provider-presets";

function streamFixture(style: CatalogApiStyle): string {
  const event = (data: Record<string, unknown>) => `${data.type ? `event: ${data.type}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
  if (style === "anthropic_messages") return [
    { type: "message_start", message: { id: "test", type: "message", role: "assistant", model: "private-model", content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ].map(event).join("");
  if (style === "google_generative_ai") return event({ candidates: [{ content: { parts: [{ text: "OK" }], role: "model" }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 } });
  if (style === "responses") {
    const item = { id: "msg", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
    return [
      { type: "response.created", response: { id: "resp", status: "in_progress", output: [] } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } },
      { type: "response.content_part.added", item_id: "msg", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "OK" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp", status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
    ].map(event).join("");
  }
  return [
    { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
    { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ].map(event).join("") + "data: [DONE]\n\n";
}

it.each([
  ["chat_completions", "openai-completions", "/gateway/v1/chat/completions", "authorization", "Bearer !literal-service-key"],
  ["responses", "openai-responses", "/gateway/v1/responses", "authorization", "Bearer !literal-service-key"],
  ["anthropic_messages", "anthropic-messages", "/gateway/v1/messages", "x-api-key", "!literal-service-key"],
  ["google_generative_ai", "google-generative-ai", "/gateway/v1/models/private-model:streamGenerateContent?alt=sse", "x-goog-api-key", "!literal-service-key"],
] as const)("runs %s through the real RPC worker with isolated service credentials", async (style, api, endpoint, authHeader, expectedAuth) => {
  const dir = await mkdtemp(join(tmpdir(), "tether-provider-runtime-"));
  const calls: Array<{ url?: string; auth?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ url: request.url, auth: request.headers[authHeader] as string | undefined, body: JSON.parse(body) });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(streamFixture(style));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  const home = join(dir, "runtime-home");
  await mkdir(home);
  await writeFile(join(home, "settings.json"), JSON.stringify({ credentialStore: "file" }));
  await writeFile(join(home, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "wrong-stored-key" } }));
  const config = serviceRuntimeConfig({ id: "test", name: "Isolated gateway", vendorKey: "custom", apiStyle: style,
    baseUrl: `http://127.0.0.1:${address.port}/gateway/v1`, models: [{ id: "private-model", contextWindow: 32000, maxTokens: 1024, supportsImages: true }],
    isEnabled: true, createdAt: "", updatedAt: "" });
  const child = spawn(process.execPath, [getTetherRpcEntryPath(), "--mode", "rpc", "--provider", "openai", "--model", "private-model", "--transport", "chat",
    "--harness", "safe", "--permission", "plan", "--sandbox", "read-only", "--extension", resolve("src/extensions/provider.ts")], {
    cwd: dir,
    env: { ...process.env, TETHER_HOME: home, OPENAI_API_KEY: "wrong-env-key", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      TETHER_DESKTOP_PROVIDER_CONFIG: JSON.stringify(config), TETHER_DESKTOP_PROVIDER_KEY: "!literal-service-key" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  type RpcEvent = { id?: string; type: string; success?: boolean; data?: { model: unknown }; [key: string]: unknown };
  const events: RpcEvent[] = [];
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
    const lines = output.split("\n"); output = lines.pop() ?? "";
    for (const line of lines) { try { events.push(JSON.parse(line)); } catch { /* startup diagnostics */ } }
  });
  const waitFor = async (predicate: (event: RpcEvent) => boolean) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const event = events.find(predicate);
      if (event) return event;
      if (child.exitCode !== null) throw new Error(`RPC exited: ${stderr}`);
      await new Promise((done) => setTimeout(done, 25));
    }
    throw new Error(`RPC timed out: ${stderr}\n${JSON.stringify(events).slice(-3000)}`);
  };
  try {
    child.stdin.write(JSON.stringify({ id: "state", type: "get_state" }) + "\n");
    const state = await waitFor((event) => event.id === "state");
    expect(state.success, stderr).toBe(true);
    expect(state.data?.model).toMatchObject({ id: "private-model", api, contextWindow: 32000, maxTokens: 1024, input: ["text", "image"] });
    child.stdin.write(JSON.stringify({ id: "prompt", type: "prompt", message: "Reply OK. Do not use tools." }) + "\n");
    await waitFor((event) => event.type === "agent_end");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: endpoint, auth: expectedAuth });
    if (style !== "google_generative_ai") expect(calls[0].body.model).toBe("private-model");
    expect(JSON.stringify(events)).toContain("OK");
    expect(JSON.stringify(events)).not.toContain("!literal-service-key");
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null) await new Promise<void>((done) => child.once("exit", () => done()));
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
