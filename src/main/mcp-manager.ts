import path from "node:path";
import type { CapabilityScope, McpSnapshot } from "../shared/capabilities";
import { parseMcpServers, serializeMcpServers, type McpServerRow } from "../shared/integrations";
import { importMcpServers, validateMcpServer } from "../shared/mcp-config";
import { isCapabilityProjectTrusted, mcpConfigPath, readMcpConfig } from "../runtime/capability-config";
import { writeJsonAtomic } from "./atomic-file";
import { withCapabilityLock } from "./skills-manager";

export class McpManager {
  async list(scope: CapabilityScope, cwd?: string): Promise<McpSnapshot> {
    const file = mcpConfigPath(scope, cwd);
    return { servers: parseMcpServers(await readMcpConfig(file)), configPath: file, projectTrusted: isCapabilityProjectTrusted(cwd) };
  }

  private mutate(scope: CapabilityScope, cwd: string | undefined, update: (servers: Record<string, unknown>) => void): Promise<void> {
    const file = mcpConfigPath(scope, cwd);
    return withCapabilityLock(path.resolve(file), async () => {
      const raw = await readMcpConfig(file);
      const source = raw.mcpServers ?? raw.servers ?? {};
      if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("MCP 服务器配置格式无效，请先修复配置文件");
      const servers = { ...source } as Record<string, unknown>;
      update(servers);
      if (Object.keys(servers).length > 100) throw new Error("最多配置 100 个 MCP 服务器");
      const { servers: _legacy, ...rest } = raw;
      await writeJsonAtomic(file, { ...rest, mcpServers: servers });
    });
  }

  save(input: McpServerRow, previousName: string | undefined, scope: CapabilityScope, cwd?: string): Promise<void> {
    const server = validateMcpServer(input);
    return this.mutate(scope, cwd, (servers) => {
      if (previousName !== undefined && !Object.hasOwn(servers, previousName)) throw new Error("服务器已被移除，请刷新列表");
      if (server.name !== previousName && Object.hasOwn(servers, server.name)) throw new Error(`已存在同名服务器：${server.name}`);
      if (previousName) delete servers[previousName];
      servers[server.name] = serializeMcpServers([server]).mcpServers[server.name];
    });
  }

  setEnabled(name: string, enabled: boolean, scope: CapabilityScope, cwd?: string): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("无效的 MCP 启用状态");
    return this.mutate(scope, cwd, (servers) => {
      if (!Object.hasOwn(servers, name) || !servers[name] || typeof servers[name] !== "object") throw new Error("找不到此 MCP 服务器");
      const current = servers[name] as Record<string, unknown>;
      const { disabled: _disabled, enabled: _enabled, ...rest } = current;
      servers[name] = { ...rest, ...(enabled ? {} : { disabled: true }) };
    });
  }

  remove(name: string, scope: CapabilityScope, cwd?: string): Promise<void> {
    return this.mutate(scope, cwd, (servers) => {
      if (!Object.hasOwn(servers, name)) throw new Error("找不到此 MCP 服务器");
      delete servers[name];
    });
  }

  async import(json: string, scope: CapabilityScope, cwd?: string): Promise<number> {
    const rows = importMcpServers(json);
    await this.mutate(scope, cwd, (servers) => {
      const duplicate = rows.find((row) => Object.hasOwn(servers, row.name));
      if (duplicate) throw new Error(`已存在同名服务器：${duplicate.name}。未覆盖或导入任何配置`);
      Object.assign(servers, serializeMcpServers(rows).mcpServers);
    });
    return rows.length;
  }
}
