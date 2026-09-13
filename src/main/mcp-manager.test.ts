import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { McpManager } from "./mcp-manager";
import { loadRuntimeMcpServers, mcpConfigPath } from "../runtime/capability-config";

describe("MCP 配置持久化与项目隔离", () => {
  let root: string;
  let project: string;
  let home: string;
  let manager: McpManager;
  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "tacode-mcp-manager-"));
    project = path.join(root, "project"); home = path.join(root, "runtime-home");
    await fsp.mkdir(project); await fsp.mkdir(home);
    vi.stubEnv("TACODE_HOME", home); manager = new McpManager();
  });
  afterEach(async () => { vi.unstubAllEnvs(); await fsp.rm(root, { recursive: true, force: true }); });

  it("未信任的项目不启动 MCP；受信项目同名项覆盖全局，包括停用", async () => {
    await manager.save({ name: "shared", kind: "stdio", command: "global" }, undefined, "user");
    await manager.save({ name: "shared", kind: "http", url: "http://127.0.0.1/mcp", disabled: true }, undefined, "project", project);
    expect((await loadRuntimeMcpServers(project))[0].command).toBe("global");
    new ProjectTrustStore(home).set(project, true);
    expect(await loadRuntimeMcpServers(project)).toEqual([]);
    await manager.setEnabled("shared", true, "project", project);
    expect((await loadRuntimeMcpServers(project))[0].kind).toBe("http");
    expect((await manager.list("user")).servers[0].command).toBe("global");
  });

  it("增删改、重命名和并发写入保留其他服务器与顶层字段", async () => {
    const file = mcpConfigPath("user");
    await fsp.writeFile(file, JSON.stringify({ note: "keep", mcpServers: { existing: { command: "node", custom: true, env: { TOKEN: "keep" } } } }));
    await Promise.all([
      manager.save({ name: "one", kind: "stdio", command: "npx", args: ["a path"], env: { KEY: "x" } }, undefined, "user"),
      manager.save({ name: "two", kind: "sse", url: "http://localhost/sse", headers: { Authorization: "Bearer test" } }, undefined, "user"),
    ]);
    await manager.save({ name: "renamed", kind: "stdio", command: "node" }, "one", "user");
    await manager.remove("two", "user");
    const raw = JSON.parse(await fsp.readFile(file, "utf8"));
    expect(raw).toEqual({ note: "keep", mcpServers: { existing: { command: "node", custom: true, env: { TOKEN: "keep" } }, renamed: { command: "node" } } });
  });

  it("冲突导入整批回滚、损坏配置不覆盖、项目路径互不混淆", async () => {
    await manager.save({ name: "existing", kind: "stdio", command: "node" }, undefined, "project", project);
    const file = mcpConfigPath("project", project);
    const before = await fsp.readFile(file, "utf8");
    await expect(manager.import('{"mcpServers":{"new":{"command":"new"},"existing":{"command":"changed"}}}', "project", project)).rejects.toThrow("同名");
    expect(await fsp.readFile(file, "utf8")).toBe(before);
    const other = path.join(root, "other"); await fsp.mkdir(other);
    expect((await manager.list("project", other)).servers).toEqual([]);
    await fsp.writeFile(file, "{bad json");
    await expect(manager.save({ name: "x", kind: "stdio", command: "node" }, undefined, "project", project)).rejects.toThrow("无法读取");
    expect(await fsp.readFile(file, "utf8")).toBe("{bad json");
  });
});
