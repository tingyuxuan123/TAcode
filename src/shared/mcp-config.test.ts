import { describe, expect, it } from "vitest";
import { parseMcpServers, serializeMcpServers } from "./integrations";
import { importMcpServers, parseMcpArguments, parseMcpKeyValues, validateMcpServer } from "./mcp-config";

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
});
