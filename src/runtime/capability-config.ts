import fsp from "node:fs/promises";
import path from "node:path";
import { ProjectTrustStore, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CapabilityScope } from "../shared/capabilities.js";
import { parseMcpServers, type McpServerRow } from "../shared/integrations.js";
import { validateMcpServer } from "../shared/mcp-config.js";
import { getTacodeHome } from "./home.js";

export function isCapabilityProjectTrusted(cwd?: string): boolean {
  if (!cwd) return false;
  const decision = new ProjectTrustStore(getTacodeHome()).get(cwd);
  if (decision !== null) return decision;
  return SettingsManager.create(cwd, getTacodeHome(), { projectTrusted: false }).getDefaultProjectTrust() === "always";
}

export function mcpConfigPath(scope: CapabilityScope, cwd?: string): string {
  if (scope === "project") {
    if (!cwd) throw new Error("请先选择项目");
    return path.join(cwd, ".tacode", "mcp.json");
  }
  return path.join(getTacodeHome(), "mcp.json");
}

/** 配置损坏时保留原文件并报错，不能当作空配置覆盖。 */
export async function readMcpConfig(file: string): Promise<Record<string, unknown>> {
  try {
    const stat = await fsp.stat(file);
    if (stat.size > 1_000_000) throw new Error("MCP 配置文件过大");
    const raw: unknown = JSON.parse(await fsp.readFile(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MCP 配置必须是对象");
    return raw as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`无法读取 MCP 配置 ${file}：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 项目同名项覆盖全局项，包括 disabled=true 的显式覆盖。 */
export async function loadRuntimeMcpServers(cwd: string): Promise<McpServerRow[]> {
  const global = parseMcpServers(await readMcpConfig(mcpConfigPath("user")));
  let project: McpServerRow[] = [];
  if (isCapabilityProjectTrusted(cwd)) {
    const file = mcpConfigPath("project", cwd);
    try {
      const [realRoot, realFile] = await Promise.all([fsp.realpath(cwd), fsp.realpath(file)]);
      const relative = path.relative(realRoot, realFile);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("项目 MCP 配置不能指向项目外");
      project = parseMcpServers(await readMcpConfig(realFile));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const merged = new Map([...global, ...project].map((server) => [server.name, server]));
  return [...merged.values()].filter((server) => !server.disabled).map(validateMcpServer);
}
