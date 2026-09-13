import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "./agent-host";
import type { AgentEvent, AgentSessionStats } from "../shared/types";
import { serviceRuntimeConfig } from "../shared/provider-config";

const baseStats: AgentSessionStats = {
  sessionId: "test", userMessages: 1, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 1,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
  contextUsage: { tokens: 1_000, contextWindow: 64_000, percent: 1.5625 },
};
const message = (length: number) => ({ role: "assistant", content: [{ type: "text", text: "x".repeat(length) }], stopReason: "stop" });

function mockHost() {
  const events: AgentEvent[] = [];
  const requests: Array<{ type: string; id: string }> = [];
  const host = new AgentHost((event) => events.push(event), () => {});
  host.runtimeId = "runtime";
  host.sessionKey = "/session.jsonl";
  const internal = host as unknown as { child: unknown; handleLine(line: string): void };
  const emit = (event: Record<string, unknown>) => internal.handleLine(JSON.stringify(event));
  internal.child = { exitCode: null, stdin: { destroyed: false, write: (line: string) => { requests.push(JSON.parse(line)); } } };
  const respond = () => {
    const request = requests.at(-1)!;
    emit({ type: "response", id: request.id, success: true, data: baseStats });
  };
  return { host, events, requests, emit, respond };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("host stats publishing", () => {
  it("coalesces streamed chunks, tags updates to their session, and sends final stats immediately", async () => {
    vi.useFakeTimers();
    const h = mockHost();
    try {
      h.emit({ type: "agent_start" });
      await vi.advanceTimersByTimeAsync(0);
      h.respond();
      await vi.advanceTimersByTimeAsync(0);
      const initialRequests = h.requests.length;
      for (let i = 1; i <= 100; i++) h.emit({ type: "message_update", message: message(i * 40) });
      await vi.advanceTimersByTimeAsync(499);
      expect(h.requests).toHaveLength(initialRequests);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.requests).toHaveLength(initialRequests + 1);
      h.respond();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.events.at(-1)).toMatchObject({ type: "desktop_session_stats", __runtimeId: "runtime", __sessionId: "/session.jsonl",
        stats: { contextUsage: { tokens: 2_000, estimated: true } } });
      expect(h.events.some((event) => event.type === "agent_settled")).toBe(false);

      h.emit({ type: "message_end", message: message(4_000) });
      h.emit({ type: "agent_settled" });
      await vi.advanceTimersByTimeAsync(0);
      expect(h.requests).toHaveLength(initialRequests + 2);
      h.respond();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.events.at(-1)?.type).toBe("desktop_session_stats");
    } finally { await h.host.stop(); }
  });

  it("does not overlap requests or emit a response from before a message boundary", async () => {
    vi.useFakeTimers();
    const h = mockHost();
    try {
      h.emit({ type: "agent_start" });
      await vi.advanceTimersByTimeAsync(0);
      h.emit({ type: "message_update", message: message(4_000) });
      h.emit({ type: "message_end", message: message(4_000) });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.requests).toHaveLength(1);
      h.respond();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.events.filter((event) => event.type === "desktop_session_stats")).toHaveLength(0);
      expect(h.requests).toHaveLength(2);
      h.respond();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.events.at(-1)?.type).toBe("desktop_session_stats");
    } finally { await h.host.stop(); }
  });

  it("cancels pending stats work on stop", async () => {
    vi.useFakeTimers();
    const h = mockHost();
    h.emit({ type: "message_update", message: message(4_000) });
    await h.host.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.requests).toHaveLength(0);
    expect(h.events.filter((event) => event.type === "desktop_session_stats")).toHaveLength(0);
  });
});

it("updates context through a real streaming RPC reply and tool loop before the run settles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tacode-live-context-"));
  const home = join(dir, "runtime-home");
  await mkdir(home);
  await writeFile(join(home, "settings.json"), JSON.stringify({ credentialStore: "file" }));
  await writeFile(join(home, "auth.json"), "{}");
  await writeFile(join(dir, "fixture.txt"), "fixture\n".repeat(1_000));
  vi.stubEnv("TACODE_HOME", home);
  const responses: ServerResponse[] = [];
  const chunk = (response: ServerResponse, delta: Record<string, unknown>, finish_reason: string | null = null) => {
    response.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  };
  const finish = (response: ServerResponse, reason: string, input: number, output: number) => {
    chunk(response, {}, reason);
    response.write(`data: ${JSON.stringify({ id: "test", choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_tokens_details: { cached_tokens: input - 1_000 } } })}\n\n`);
    response.end("data: [DONE]\n\n");
  };
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the model request without logging prompts. */ }
    responses.push(response);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    chunk(response, { role: "assistant", content: "x".repeat(responses.length === 1 ? 8_000 : 1_600) });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  const config = serviceRuntimeConfig({ id: "context", name: "Context fixture", vendorKey: "custom", apiStyle: "chat_completions",
    baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "context-model", contextWindow: 64_000, maxTokens: 4_096 }],
    isEnabled: true, createdAt: "", updatedAt: "" });
  const events: AgentEvent[] = [];
  const errors: string[] = [];
  const host = new AgentHost((event) => events.push(event), (error) => errors.push(error));
  const latestStats = () => events.filter((event) => event.type === "desktop_session_stats").at(-1)?.stats as AgentSessionStats | undefined;
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      if (!host.isRunning()) throw new Error(`Worker exited: ${errors.join("\n")}`);
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error(`Timed out; events: ${events.map((event) => event.type).join(", ")}; ${errors.join("\n")}`);
  };
  try {
    const snapshot = await host.start({ cwd: dir, provider: "openai", model: "context-model", baseUrl: config.baseUrl,
      permission: "plan", sandbox: "read-only", activeTools: ["read_file"], providerExtension: resolve("src/extensions/provider.ts"),
      desktopProvider: { config, apiKey: "fixture-only" } });
    host.sessionKey = snapshot.state.sessionFile as string;
    await host.request("prompt", { message: "Read fixture.txt, then finish." });
    await waitFor(() => (latestStats()?.contextUsage?.tokens ?? 0) >= 2_000);
    expect(latestStats()?.contextUsage).toMatchObject({ contextWindow: 64_000, estimated: true });
    expect(latestStats()?.turnUsage?.tokens).toBeUndefined();
    expect(events.some((event) => event.type === "agent_settled")).toBe(false);

    chunk(responses[0], { tool_calls: [{ index: 0, id: "read-1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "fixture.txt" }) } }] });
    finish(responses[0], "tool_calls", 10_000, 200);
    await waitFor(() => responses.length === 2 && (latestStats()?.contextUsage?.tokens ?? 0) > 10_200 && latestStats()?.turnUsage?.tools.calls === 1);
    expect(latestStats()?.turnUsage?.tokens).toMatchObject({ input: 1_000, cacheRead: 9_000, output: 200, total: 10_200 });
    expect(latestStats()?.turnUsage?.tools.tokens).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "agent_settled")).toBe(false);

    finish(responses[1], "stop", 12_000, 600);
    await waitFor(() => events.some((event) => event.type === "agent_settled") && latestStats()?.contextUsage?.estimated === false && latestStats()?.turnUsage?.tokens?.total === 22_800);
    expect(latestStats()?.contextUsage).toMatchObject({ tokens: 12_600, contextWindow: 64_000, estimated: false });
    expect(latestStats()?.tokens.total).toBe(22_800);
    expect(latestStats()?.turnUsage?.outputTokens).toBe(800);
    expect(errors).toEqual([]);
  } finally {
    await host.stop();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
