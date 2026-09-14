import { parseMcpServers, serializeMcpServers, type McpServerRow } from "./integrations";

const RESERVED_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** IPC、JSON 导入、编辑器 JSON 粘贴和运行时共用同一份校验。 */
export function validateMcpServer(value: unknown): McpServerRow {
  if (!record(value)) throw new Error("MCP 配置必须是对象");
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 100 || RESERVED_NAMES.has(value.name.trim())) {
    throw new Error("请输入有效的服务器名称（最多 100 个字符）");
  }
  if (!["stdio", "http", "sse"].includes(String(value.kind))) throw new Error("不支持的 MCP 传输方式");
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") throw new Error("MCP 启用状态无效");
  const next: McpServerRow = { name: value.name.trim(), kind: value.kind as McpServerRow["kind"] };
  if (value.disabled === true) next.disabled = true;
  for (const key of ["description", "cwd"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || value[key].length > 4_096 || value[key].includes("\0")) throw new Error(`MCP ${key} 无效`);
      if (value[key].trim()) next[key] = value[key].trim();
    }
  }
  if (value.timeout !== undefined) {
    if (typeof value.timeout !== "number" || !Number.isFinite(value.timeout) || value.timeout < 1 || value.timeout > 300) throw new Error("超时须为 1–300 秒");
    next.timeout = value.timeout;
  }
  for (const key of ["env", "headers"] as const) {
    if (value[key] === undefined) continue;
    if (!record(value[key]) || Object.keys(value[key]).length > 100) throw new Error(`MCP ${key} 须为字符串键值对`);
    const entries = Object.entries(value[key]);
    for (const [name, text] of entries) {
      if (!name || RESERVED_NAMES.has(name) || typeof text !== "string" || text.length > 16_384 || /[\0\r\n]/.test(name + (key === "headers" ? text : ""))) throw new Error(`MCP ${key} 包含无效的键值对`);
      if (key === "headers" && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error("HTTP 请求头名称无效");
      if (key === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("环境变量名称无效");
    }
    next[key] = Object.fromEntries(entries) as Record<string, string>;
  }
  if (next.kind === "stdio") {
    if (typeof value.command !== "string" || !value.command.trim() || value.command.length > 4_096 || /[\0\r\n]/.test(value.command)) throw new Error("请输入启动命令，例如 npx 或可执行文件路径");
    next.command = value.command.trim();
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.length > 256 || value.args.some((arg) => typeof arg !== "string" || arg.length > 16_384 || arg.includes("\0"))) throw new Error("启动参数必须是字符串数组");
      next.args = value.args as string[];
    }
  } else {
    if (typeof value.url !== "string" || value.url.length > 8_192) throw new Error("请输入 MCP 服务器 URL");
    let url: URL;
    try { url = new URL(value.url); } catch { throw new Error("请输入有效的 HTTP 或 HTTPS 地址"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("MCP 地址只支持 HTTP / HTTPS；凭据请填入请求头");
    next.url = value.url.trim();
  }
  if (record(value.extra)) {
    const fields = new Set(["name", "kind", "type", "command", "args", "url", "disabled", "enabled", "description", "env", "headers", "cwd", "timeout"]);
    next.extra = Object.fromEntries(Object.entries(value.extra).filter(([key]) => !fields.has(key) && !RESERVED_NAMES.has(key)));
  }
  return next;
}

/** 解包 JSON 文本里的服务器映射，同时支持 mcpServers、servers 和直接映射三种写法。 */
function parseServerMap(json: string): Record<string, unknown> {
  if (json.length > 1_000_000) throw new Error("MCP 配置文件过大");
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Error("JSON 格式不正确，请检查引号和逗号"); }
  if (!record(raw)) throw new Error("MCP 配置必须是 JSON 对象");
  const servers = raw.mcpServers ?? raw.servers ?? raw;
  if (!record(servers)) throw new Error("MCP 配置必须是 JSON 对象");
  return servers;
}

/**
 * 单条配置的严格校验。不允许 parser 的宽松兼容逻辑掩盖错误输入（尤其是环境变量与参数），
 * 因此把 args / env / headers 原样回灌给 validateMcpServer。
 */
function parseEntry(name: string, source: Record<string, unknown>): McpServerRow {
  if (source.type !== undefined && !["stdio", "http", "sse"].includes(String(source.type))) throw new Error(`不支持的 MCP 传输方式：${String(source.type)}`);
  const [row] = parseMcpServers({ mcpServers: { [name]: source } });
  if (!row) throw new Error(`服务器 ${name} 需要 command 或 url`);
  return validateMcpServer({ ...row, ...(source.args !== undefined ? { args: source.args } : {}), ...(source.env !== undefined ? { env: source.env } : {}), ...(source.headers !== undefined ? { headers: source.headers } : {}) });
}

export function importMcpServers(json: string): McpServerRow[] {
  const servers = parseServerMap(json);
  const names = Object.keys(servers);
  if (names.length === 0 || names.length > 100) throw new Error("请提供 1–100 个 MCP 服务器配置");
  return names.map((name) => {
    const source = servers[name];
    if (!record(source)) throw new Error(`服务器 ${name} 的配置必须是 JSON 对象`);
    return parseEntry(name, source);
  });
}

/** 编辑器 JSON 模式：一次一个服务器，键名即服务器名称。 */
export function parseMcpServerJson(json: string): McpServerRow {
  const servers = parseServerMap(json);
  const names = Object.keys(servers);
  if (names.length !== 1) throw new Error("JSON 模式一次只能保存一个 MCP 服务器；批量请返回列表使用「导入」");
  const name = names[0]!;
  const source = servers[name];
  if (!record(source)) throw new Error(`服务器 ${name} 的配置必须是 JSON 对象`);
  return parseEntry(name, source);
}

/** 表单 → JSON：按 mcpServers 的字段规则输出单个服务器的裸映射，未知扩展字段保留。 */
export function formatMcpServerJson(row: McpServerRow): string {
  const name = row.name.trim() || "my-mcp-server";
  const body = serializeMcpServers([{ ...row, name }]).mcpServers[name] ?? {};
  return JSON.stringify({ [name]: body }, null, 2);
}

export function parseMcpArguments(text: string): string[] {
  if (text.trim().startsWith("[")) {
    let args: unknown;
    try { args = JSON.parse(text); } catch { throw new Error("参数 JSON 无效"); }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("参数须为字符串数组");
    return args;
  }
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function parseMcpKeyValues(text: string, separator: "=" | ":"): Record<string, string> {
  const entries = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const index = line.indexOf(separator);
    if (index <= 0) throw new Error(`每行应为 ${separator === "=" ? "KEY=value" : "Header: value"}`);
    return [line.slice(0, index).trim(), separator === "=" ? line.slice(index + 1) : line.slice(index + 1).trim()];
  });
  if (new Set(entries.map(([key]) => key.toLowerCase())).size !== entries.length) throw new Error("键名重复，请保留一项");
  return Object.fromEntries(entries);
}
