import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "./agent-host";
import { sessionFileOf } from "./agent-manager";
import { SESSION_TITLE_PROMPT } from "../runtime/session-title";
import { listTacodeThreads } from "../runtime/state";
import type { AgentEvent } from "../shared/types";
import { serviceRuntimeConfig } from "../shared/provider-config";

function textStream(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({
    id: "title-test", object: "chat.completion.chunk", created: 0, model: "private-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  return `${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;
}

afterEach(() => vi.unstubAllEnvs());

describe("automatic title through the real RPC worker", () => {
  it.each([false, true])("summarizes once without blocking the reply or overriding a manual rename: manual=%s", async (manual) => {
    const dir = await mkdtemp(join(tmpdir(), "tacode-title-"));
    const home = join(dir, "home");
    await mkdir(home);
    await writeFile(join(home, "settings.json"), JSON.stringify({ credentialStore: "file" }));
    vi.stubEnv("TACODE_HOME", home);
    vi.stubEnv("OPENAI_API_KEY", "unused-built-in-test-key");
    let releaseTitle: (() => void) | undefined;
    const titleRequests: Record<string, any>[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      const parsed = JSON.parse(body);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (parsed.messages?.some((message: any) => message.role === "system" && message.content === SESSION_TITLE_PROMPT)) {
        titleRequests.push({ ...parsed, authorization: request.headers.authorization });
        releaseTitle = () => { if (!response.destroyed) response.end(textStream("Three.js 博丽神社微缩场景")); };
      } else {
        response.end(textStream("reply-ok"));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const config = serviceRuntimeConfig({
      id: "title-service", name: "Title test", vendorKey: "custom", apiStyle: "chat_completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      models: [{ id: "private-model", contextWindow: 32_000, maxTokens: 1024 }],
      isEnabled: true, createdAt: "", updatedAt: "",
    });
    const events: AgentEvent[] = [];
    const errors: string[] = [];
    const host = new AgentHost((event) => events.push(event), (error) => errors.push(error));
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error(`Title test timed out: ${errors.join("\n")}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      const snapshot = await host.start({
        cwd: dir, provider: "openai", model: "private-model", baseUrl: config.baseUrl,
        permission: "auto", sandbox: "read-only", autoTitle: true,
        providerExtension: resolve("src/extensions/provider.ts"),
        desktopProvider: { config, apiKey: "title-service-test-key" },
      });
      host.sessionKey = sessionFileOf(snapshot);
      const firstMessage = "请使用 Three.js 制作一个完整的博丽神社微缩三维场景。".repeat(20);
      await host.request("prompt", { message: firstMessage });
      await waitFor(() => Boolean(releaseTitle) && events.some((event) => event.type === "agent_settled"));
      expect(events.some((event) => event.type === "session_info_changed")).toBe(false);
      expect(titleRequests).toHaveLength(1);
      expect(titleRequests[0].authorization).toBe("Bearer title-service-test-key");
      expect(titleRequests[0].messages).toEqual([
        { role: "system", content: SESSION_TITLE_PROMPT },
        { role: "user", content: firstMessage },
      ]);
      expect(titleRequests[0].tools ?? []).toHaveLength(0);
      const title = manual ? "我手动设置的标题" : "Three.js 博丽神社微缩场景";
      if (manual) await host.request("set_session_name", { name: title });
      releaseTitle!();
      await waitFor(() => events.some((event) => event.type === "session_info_changed" && event.name === title));

      // 后续消息不会再生成标题；摘要不混进正常聊天记录。
      await host.request("prompt", { message: "补充要求" });
      await waitFor(() => events.filter((event) => event.type === "agent_settled").length >= 2);
      expect(titleRequests).toHaveLength(1);
      expect(await host.request("get_state")).toMatchObject({ sessionName: title });
      const history = await host.request<{ messages: Array<{ role: string; content: unknown }> }>("get_messages");
      expect(history.messages.filter((message) => message.role === "assistant")).toHaveLength(2);
      expect(await readFile(host.sessionKey!, "utf8")).toContain(JSON.stringify(title));
      const threads = await listTacodeThreads();
      expect(threads.find((thread) => thread.title === title)).toBeDefined();
      expect(errors).toEqual([]);
    } finally {
      await host.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
