import { describe, expect, it } from "vitest";
import { parseMcpServers, serializeMcpServers } from "./integrations";
import { formatMcpServerJson, importMcpServers, parseMcpArguments, parseMcpKeyValues, parseMcpServerJson, validateMcpServer } from "./mcp-config";

describe("MCP 配置契约", () => {
  it("保留环境变量、请求头、SSE、停用状态和未知扩展字段", () => {
    const raw = { mcpServers: {
      local: { command: "npx", args: ["-y", "server", "/a path"], env: { TOKEN: "literal" }, cwd: "/work", timeout: 15, disabled: true, custom: { keep: true } },
      remote: { type: "sse", url: "http://localhost:1234/sse", headers: { Authorization: "Bearer secret" } },
    } };
    expect(serializeMcpServers(parseMcpServers(raw))).toEqual(raw);
  });

  it("导入标准、Proma 和直接映射格式，不静默导入半份配置", () => {
    expect(importMcpServers('{"servers":{"search":{"type":"http","url":"https://example.com/mcp","enabled":false}}}')).toEqual([{ name: "search", kind: "http", url: "https://example.com/mcp", disabled: true }]);
    expect(importMcpServers('{"local":{"command":"node"}}')[0].name).toBe("local");
    expect(() => importMcpServers('{"mcpServers":{"valid":{"command":"node"},"broken":{}}}')).toThrow();
    expect(() => importMcpServers('{"mcpServers":{"bad":{"command":"node","env":{"TOKEN":123}}}}')).toThrow();
    expect(() => importMcpServers('{"mcpServers":{"bad":{"type":"ftp","url":"https://example.com"}}}')).toThrow();
  });

  it("参数中的空格、逗号和 JSON 空参数不会被 shell 分词破坏", () => {
    expect(parseMcpArguments('-y\nserver\n/a path/with,comma')).toEqual(["-y", "server", "/a path/with,comma"]);
    expect(parseMcpArguments('["", "  preserved  ", "a\\nb"]')).toEqual(["", "  preserved  ", "a\nb"]);
    expect(() => parseMcpArguments('["ok",3]')).toThrow();
    expect(parseMcpKeyValues("TOKEN=a=b\nPATH= spaces ", "=")).toEqual({ TOKEN: "a=b", PATH: " spaces " });
    expect(parseMcpKeyValues("Authorization: Bearer token:part", ":")).toEqual({ Authorization: "Bearer token:part" });
    expect(() => parseMcpKeyValues("malformed", "=")).toThrow();
    expect(() => parseMcpKeyValues("Authorization: one\nauthorization: two", ":")).toThrow();
  });

  it("阻止非法 URL、原型键、头注入以及旁路字段", () => {
    expect(() => validateMcpServer({ name: "x", kind: "http", url: "file:///etc/passwd" })).toThrow();
    expect(() => validateMcpServer({ name: "__proto__", kind: "stdio", command: "node" })).toThrow();
    expect(() => validateMcpServer({ name: "x", kind: "http", url: "http://localhost", headers: { Authorization: "a\r\nX: b" } })).toThrow();
    expect(() => validateMcpServer({ name: "x", kind: "stdio", command: "node", timeout: Number.NaN })).toThrow();
    const value = validateMcpServer({ name: "x", kind: "stdio", command: "node", extra: { disabled: true, command: "wrong", keep: true } });
    expect(serializeMcpServers([value])).toEqual({ mcpServers: { x: { command: "node", keep: true } } });
  });

  it("编辑器 JSON 模式支持裸映射与 mcpServers 包裹，且一次只接受一个服务器", () => {
    expect(parseMcpServerJson('{"local":{"command":"node","args":["a b"],"env":{"TOKEN":"x"},"custom":{"keep":true}}}')).toEqual({ name: "local", kind: "stdio", command: "node", args: ["a b"], env: { TOKEN: "x" }, extra: { custom: { keep: true } } });
    expect(parseMcpServerJson('{"mcpServers":{"remote":{"type":"sse","url":"https://example.com/sse"}}}')).toEqual({ name: "remote", kind: "sse", url: "https://example.com/sse" });
    expect(() => parseMcpServerJson('{"mcpServers":{"a":{"command":"node"},"b":{"command":"node"}}}')).toThrow("一次只能保存一个");
    expect(() => parseMcpServerJson('{"empty":{}}')).toThrow();
    expect(() => parseMcpServerJson('{"bad":{"type":"ftp","url":"https://example.com"}}')).toThrow();
    expect(() => parseMcpServerJson('{"bad":{"command":"node","env":{"TOKEN":123}}}')).toThrow();
    expect(() => parseMcpServerJson('{"__proto__":{"command":"node"}}')).toThrow();
    expect(() => parseMcpServerJson("not json")).toThrow();
  });

  it("表单生成的 JSON 能原样粘回编辑器", () => {
    const row = { name: "local-fixture", kind: "stdio" as const, command: "node", args: ["-y", "/a path/server.mjs"], env: { MCP_FIXTURE_VALUE: "json" }, timeout: 15, description: "fixture", extra: { custom: true } };
    const text = formatMcpServerJson(row);
    expect(text).toMatch(/^\{\n {2}"local-fixture": \{/);
    expect(parseMcpServerJson(text)).toEqual(row);
    expect(parseMcpServerJson(formatMcpServerJson({ name: "remote", kind: "sse", url: "https://example.com/sse" }))).toEqual({ name: "remote", kind: "sse", url: "https://example.com/sse" });
    expect(formatMcpServerJson({ name: "", kind: "http", url: "https://example.com/mcp" })).toContain('"my-mcp-server"');
  });
});
