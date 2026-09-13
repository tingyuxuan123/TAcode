import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type TextContent, type ImageContent } from "@earendil-works/pi-ai";
import { applyToolSet, clearToolContribution, setToolContribution } from "../shared/tool-set.js";
import { loadRuntimeMcpServers } from "./capability-config.js";
import { McpConnection, mcpErrorMessage, mcpFingerprint, mcpToolName } from "./mcp-client.js";
import type { PermissionMode, TacodeRuntimeOptions } from "./options.js";

/** MCP 工具与浏览器工具一样贡献给统一工具集，不覆盖已有工具或绕过审批。 */
export function registerMcpTools(pi: ExtensionAPI, options: TacodeRuntimeOptions, permission: () => PermissionMode): void {
  const connections = new Map<string, { fingerprint: string; connection: McpConnection }>();
  const failures = new Map<string, number>();
  const lifetime = new AbortController();
  let refreshing: Promise<void> | undefined;
  const restricted = options.toolsExplicit;

  const refresh = (ctx: ExtensionContext): Promise<void> => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (permission() === "plan" || restricted) {
        setToolContribution("mcp", { names: [] });
        applyToolSet(pi);
        return;
      }
      const servers = await loadRuntimeMcpServers(ctx.cwd);
      const live = new Map(servers.map((server) => [server.name, mcpFingerprint(server)]));
      for (const [name, value] of connections) {
        if (live.get(name) !== value.fingerprint || value.connection.isClosed) { connections.delete(name); await value.connection.close(); }
      }
      const outcomes = await Promise.allSettled(servers.map(async (server) => {
        const fingerprint = mcpFingerprint(server);
        if (connections.has(server.name) || Date.now() - (failures.get(fingerprint) ?? 0) < 30_000) return;
        try {
          const connection = await McpConnection.open(server, ctx.cwd, lifetime.signal);
          if (lifetime.signal.aborted) { await connection.close(); return; }
          connections.set(server.name, { fingerprint, connection });
          failures.delete(fingerprint);
          for (const tool of connection.tools) {
            pi.registerTool({
              name: mcpToolName(server.name, tool.name),
              label: `${server.name} · ${tool.name}`,
              description: tool.description || `${server.name}: ${tool.name}`,
              parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
              async execute(_id, args, signal) {
                const configured = (await loadRuntimeMcpServers(ctx.cwd)).find((item) => item.name === server.name);
                if (!configured || mcpFingerprint(configured) !== fingerprint) throw new Error("此 MCP 已停用或配置已改变，请在下一轮重新调用");
                try {
                  const result = await connection.call(tool.name, args, signal);
                  const content: Array<TextContent | ImageContent> = result.content.flatMap((item): Array<TextContent | ImageContent> => {
                    if (item.type === "text") return [{ type: "text", text: item.text }];
                    if (item.type === "image" && /^image\/(png|jpeg|webp|gif)$/.test(item.mimeType)) return [{ type: "image", data: item.data, mimeType: item.mimeType }];
                    return [{ type: "text", text: JSON.stringify(item) }];
                  });
                  if (result.structuredContent) content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
                  if (result.isError) throw new Error(content.filter((item) => item.type === "text").map((item) => item.text).join("\n") || "MCP 工具执行失败");
                  return { content: content.length ? content : [{ type: "text" as const, text: "操作完成" }], details: { server: server.name, tool: tool.name } };
                } catch (error) { throw new Error(mcpErrorMessage(error, server)); }
              },
            });
          }
        } catch (error) {
          failures.set(fingerprint, Date.now());
          if (!lifetime.signal.aborted) ctx.ui.notify(`MCP ${server.name}：${mcpErrorMessage(error, server)}`, "warning");
        }
      }));
      for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
      if (lifetime.signal.aborted) return;
      setToolContribution("mcp", { names: [...connections.values()].flatMap(({ connection }) => connection.tools.map((tool) => mcpToolName(connection.server.name, tool.name))) });
      applyToolSet(pi);
    })().catch((error) => {
      // 无法确认当前配置时收回工具；不可继续使用可能已被禁用的缓存连接。
      setToolContribution("mcp", { names: [] });
      applyToolSet(pi);
      if (!lifetime.signal.aborted) ctx.ui.notify(`MCP：${error instanceof Error ? error.message : String(error)}`, "warning");
    }).finally(() => { refreshing = undefined; });
    return refreshing;
  };

  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("before_agent_start", async (_event, ctx) => { await refresh(ctx); });
  pi.on("session_shutdown", async () => {
    lifetime.abort();
    await refreshing;
    await Promise.allSettled([...connections.values()].map(({ connection }) => connection.close()));
    connections.clear();
    clearToolContribution("mcp");
  });
}
