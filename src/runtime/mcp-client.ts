import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpTestResult } from "../shared/capabilities.js";
import type { McpServerRow } from "../shared/integrations.js";
import { validateMcpServer } from "../shared/mcp-config.js";

export function mcpFingerprint(server: McpServerRow): string {
  return createHash("sha256").update(JSON.stringify(server)).digest("hex");
}

/** 即使两个名称净化后相同，也不会覆盖另一个服务器的工具。 */
export function mcpToolName(server: string, tool: string): string {
  const readable = `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 43);
  const suffix = createHash("sha256").update(JSON.stringify([server, tool])).digest("hex").slice(0, 10);
  return `mcp__${readable}_${suffix}`;
}

function expandValue(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const result = process.env[name];
    if (result === undefined) throw new Error(`缺少环境变量 ${name}`);
    return result;
  });
}

export function mcpErrorMessage(error: unknown, server: McpServerRow): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = [...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})].flatMap((value) => {
    try { return [value, expandValue(value)]; } catch { return [value]; }
  });
  for (const secret of secrets) if (secret.length >= 4) message = message.split(secret).join("[redacted]");
  message = message.replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
    try { const url = new URL(value); if (url.search) url.search = "?[redacted]"; return url.href; } catch { return value; }
  });
  return message.slice(0, 800);
}

export class McpConnection {
  private readonly client = new Client({ name: "TACode", version: "0.2.9" }, { capabilities: {} });
  private readonly lifetime = new AbortController();
  private transport?: Transport;
  private closed = false;
  private closing?: Promise<void>;
  readonly tools: Tool[] = [];

  get isClosed(): boolean { return this.closed; }

  private constructor(readonly server: McpServerRow, readonly cwd: string) {}

  static async open(input: McpServerRow, cwd: string, signal?: AbortSignal): Promise<McpConnection> {
    const connection = new McpConnection(validateMcpServer(input), cwd);
    const timeout = (connection.server.timeout ?? 20) * 1_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => connection.lifetime.abort(signal?.reason ?? new Error("MCP 连接已取消"));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await Promise.race([
        connection.connect(),
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(connection.lifetime.signal.reason);
          if (connection.lifetime.signal.aborted) onAbort();
          else connection.lifetime.signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => connection.lifetime.abort(new Error(`MCP 连接超时（${timeout / 1_000} 秒）`)), timeout);
        }),
      ]);
      return connection;
    } catch (error) {
      await connection.close();
      throw new Error(mcpErrorMessage(error, connection.server));
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async connect(): Promise<void> {
    const config = this.server;
    const headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key, expandValue(value)]));
    const fetchWithLifetime: typeof fetch = (input, init) => fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, this.lifetime.signal]) : this.lifetime.signal,
    });
    if (config.kind === "stdio") {
      const env = Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, expandValue(value)]));
      const transport = new StdioClientTransport({
        command: config.command!, args: config.args,
        cwd: config.cwd ? path.resolve(this.cwd, config.cwd) : this.cwd,
        env: { ...getDefaultEnvironment(), ...env },
        stderr: "pipe", maxBufferSize: 8 * 1024 * 1024,
      });
      // 消耗 stderr 以免子进程阻塞，但不把潜在密钥写进桌面日志。
      transport.stderr?.on("data", () => undefined);
      this.transport = transport;
    } else if (config.kind === "http") {
      this.transport = new StreamableHTTPClientTransport(new URL(expandValue(config.url!)), { requestInit: { headers }, fetch: fetchWithLifetime });
    } else {
      this.transport = new SSEClientTransport(new URL(expandValue(config.url!)), {
        requestInit: { headers }, fetch: fetchWithLifetime,
      });
    }
    this.client.onerror = () => undefined;
    this.client.onclose = () => { this.closed = true; };
    // SDK 的握手异常和外部超时可能同时 close；复用同一 Promise 才会等到进程退出。
    const closeTransport = this.transport.close.bind(this.transport);
    let transportClosing: Promise<void> | undefined;
    this.transport.close = () => transportClosing ??= closeTransport();
    await this.client.connect(this.transport, { timeout: (config.timeout ?? 20) * 1_000, signal: this.lifetime.signal });
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined, { timeout: (config.timeout ?? 20) * 1_000, signal: this.lifetime.signal });
      this.tools.push(...page.tools);
      if (this.tools.length > 2_000) throw new Error("MCP 返回了过多工具");
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("MCP 工具分页游标重复");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    if (this.closed) throw new Error("MCP 连接已关闭，请刷新连接");
    // 有副作用的调用失败时不自动重试，避免重复提交。
    return await this.client.callTool({ name, arguments: args }, undefined, {
      signal: signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal,
      timeout: (this.server.timeout ?? 60) * 1_000,
    }) as CallToolResult;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifetime.abort(new Error("MCP 连接已关闭"));
    this.closing = (async () => {
      await this.client.close().catch(() => undefined);
      await this.transport?.close().catch(() => undefined);
    })();
    return this.closing;
  }
}

export async function testMcpServer(server: McpServerRow, cwd: string): Promise<McpTestResult> {
  let connection: McpConnection | undefined;
  try {
    connection = await McpConnection.open(server, cwd);
    const tools = connection.tools.map(({ name, description }) => ({ name, ...(description ? { description } : {}) }));
    return { success: true, message: `连接成功，发现 ${tools.length} 个工具`, tools, checkedAt: Date.now() };
  } catch (error) {
    return { success: false, message: mcpErrorMessage(error, server), tools: [], checkedAt: Date.now() };
  } finally { await connection?.close(); }
}
