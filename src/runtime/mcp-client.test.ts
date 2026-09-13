import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpConnection, mcpErrorMessage, mcpToolName, testMcpServer } from "./mcp-client";

const fixture = path.resolve("scripts/fixtures/mcp-server.mjs");
const local = { name: "fixture", kind: "stdio" as const, command: process.execPath, args: [fixture] };
const closeServer = (server: Server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
afterEach(() => vi.unstubAllEnvs());

describe("官方 MCP SDK 真实连接", () => {
  it("stdio 握手、分页工具发现、参数执行与显式环境变量生效", async () => {
    vi.stubEnv("TACODE_MCP_UNSHARED_SECRET", "do-not-inherit");
    const connection = await McpConnection.open({ ...local, env: { MCP_FIXTURE_VALUE: "passed" } }, process.cwd());
    try {
      expect(connection.tools.map((tool) => tool.name)).toEqual(["echo", "fail"]);
      const result = await connection.call("echo", { text: "hello MCP" });
      expect(result.content).toEqual([{ type: "text", text: "hello MCP" }]);
      expect(result.structuredContent).toMatchObject({ configured: "passed", cwd: process.cwd() });
      expect(result.structuredContent).not.toHaveProperty("unconfigured");
      expect((await connection.call("fail", {})).isError).toBe(true);
    } finally { await connection.close(); }
    await expect(connection.call("echo", { text: "closed" })).rejects.toThrow("关闭");
  });

  it("测试连接失败会回收 stdio 子进程，并返回可读的超时错误", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tacode-mcp-timeout-"));
    const pidFile = path.join(root, "pid");
    try {
      const result = await testMcpServer({ ...local, timeout: 1, env: { MCP_FIXTURE_HANG: "1", MCP_FIXTURE_PID_FILE: pidFile } }, process.cwd());
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/超时|timeout/i);
      const pid = Number(await fsp.readFile(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { await fsp.rm(root, { recursive: true, force: true }); }
  }, 10_000);

  it("HTTP 请求头传到握手和调用，测试只发现工具不执行", async () => {
    const methods: string[] = [];
    const headers: Array<string | undefined> = [];
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") { response.writeHead(405).end(); return; }
      let text = ""; for await (const chunk of request) text += chunk;
      const message = JSON.parse(text); methods.push(message.method); headers.push(request.headers.authorization);
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1" } }
        : { tools: [{ name: "http_echo", inputSchema: { type: "object", properties: {} } }] };
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await testMcpServer({ name: "http", kind: "http", url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, headers: { Authorization: "Bearer secret" } }, process.cwd());
      expect(result.success).toBe(true);
      expect(result.tools.map((tool) => tool.name)).toEqual(["http_echo"]);
      expect(headers.every((header) => header === "Bearer secret")).toBe(true);
      expect(methods).not.toContain("tools/call");
    } finally { await closeServer(server); }
  });

  it("工具名稳定且不因净化或截断发生冲突；错误不泄露密钥", () => {
    const left = mcpToolName("a.b", "tool"); const right = mcpToolName("a_b", "tool");
    expect(left).not.toBe(right); expect(left).toBe(mcpToolName("a.b", "tool"));
    expect(mcpToolName("x".repeat(100), "y".repeat(100)).length).toBeLessThanOrEqual(64);
    const error = mcpErrorMessage(new Error("Bearer secret at https://example.com/mcp?key=hidden"), { name: "x", kind: "http", url: "https://example.com", headers: { Authorization: "Bearer secret" } });
    expect(error).not.toContain("secret"); expect(error).not.toContain("hidden");
  });

  it("SSE 事件流和 POST 请求都带认证头，并能执行发现的工具", async () => {
    vi.stubEnv("TACODE_MCP_SSE_TOKEN", "sse-fixture-token");
    const headers: Array<string | undefined> = [];
    let stream: ServerResponse | undefined;
    const server = createServer(async (request, response) => {
      headers.push(request.headers.authorization);
      if (request.method === "GET" && request.url === "/sse") {
        stream = response;
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        response.write("event: endpoint\ndata: /messages?sessionId=fixture\n\n");
        return;
      }
      if (request.method !== "POST") { response.writeHead(404).end(); return; }
      let text = ""; for await (const chunk of request) text += chunk;
      const message = JSON.parse(text);
      response.writeHead(202).end();
      if (message.id === undefined) return;
      const result = message.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sse-fixture", version: "1" } }
        : message.method === "tools/list" ? { tools: [{ name: "sse_echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }
        : { content: [{ type: "text", text: message.params.arguments.text }] };
      stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let connection: McpConnection | undefined;
    try {
      connection = await McpConnection.open({ name: "sse", kind: "sse", url: `http://127.0.0.1:${(server.address() as { port: number }).port}/sse`, headers: { Authorization: "Bearer ${TACODE_MCP_SSE_TOKEN}" }, timeout: 3 }, process.cwd());
      expect(connection.tools.map((tool) => tool.name)).toEqual(["sse_echo"]);
      expect((await connection.call("sse_echo", { text: "SSE round trip" })).content).toEqual([{ type: "text", text: "SSE round trip" }]);
      expect(headers.length).toBeGreaterThanOrEqual(5);
      expect(headers.every((header) => header === "Bearer sse-fixture-token")).toBe(true);
    } finally { await connection?.close(); await closeServer(server); }
  });
});
