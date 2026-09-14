import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { AgentEvent } from "../shared/types";
import { serviceRuntimeConfig } from "../shared/provider-config";
import { AgentHost } from "./agent-host";
import { AgentManager, type AgentHostStartOptions } from "./agent-manager";
import { SkillsManager } from "./skills-manager";
import { McpManager } from "./mcp-manager";

afterEach(() => vi.unstubAllEnvs());

it("reloads only the newly trusted session after approvals/children finish, preserves history and settings, and cannot resurrect a stopped session", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tacode-trust-reload-"));
  const home = path.join(root, "home"), project = path.join(root, "project"), other = path.join(root, "other"), cancelled = path.join(root, "cancelled");
  await Promise.all([home, project, other, cancelled].map((directory) => fsp.mkdir(directory)));
  await fsp.writeFile(path.join(home, "settings.json"), JSON.stringify({ credentialStore: "file" }));
  vi.stubEnv("TACODE_HOME", home);
  const trust = new ProjectTrustStore(home);
  trust.setMany([{ path: project, decision: false }, { path: other, decision: true }, { path: cancelled, decision: false }]);
  const requests: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const modelRequest = JSON.parse(body); requests.push(modelRequest);
    const echo = modelRequest.tools?.find((tool: { function: { name: string } }) => tool.function.name.startsWith("mcp__") && tool.function.name.includes("echo"));
    const toolCall = echo && modelRequest.messages.at(-1)?.role !== "tool";
    const delta = toolCall ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: echo.function.name, arguments: '{"text":"trusted MCP works"}' } }] } : { role: "assistant", content: "History retained." };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end([
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
      { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }] },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = serviceRuntimeConfig({ id: "reload-fixture", name: "Local fixture", vendorKey: "custom", apiStyle: "chat_completions", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: [{ id: "fixture" }, { id: "alternate" }], isEnabled: true, createdAt: "", updatedAt: "" });
  const approvalExtension = path.join(root, "approval.mjs");
  await fsp.writeFile(approvalExtension, 'export default pi => { pi.registerCommand("hold-approval", {description:"fixture", handler: async (_args, ctx) => { await ctx.ui.confirm("Fixture approval", "Wait before reloading"); }}); };');
  const events: AgentEvent[] = [], errors: string[] = [];
  let children = false;
  const manager: AgentManager = new AgentManager({
    hasDelegations: () => children,
    createHost: (runtimeId) => new AgentHost((event) => {
      events.push(event);
      if (["agent_settled", "desktop_ui_request_resolved", "desktop_capabilities_idle"].includes(event.type)) manager.flushScheduledCapabilities(runtimeId);
    }, (error) => errors.push(error)),
  });
  const options = (cwd: string): AgentHostStartOptions => ({ cwd, provider: "openai", model: "fixture", permission: "plan", sandbox: "workspace-write", browserExtension: approvalExtension, providerExtension: path.resolve("src/extensions/provider.ts"), desktopProvider: { config, apiKey: "" } });
  const pid = (host: AgentHost) => (host as unknown as { child?: { pid?: number } }).child?.pid;
  const prompt = async (host: AgentHost, message: string) => {
    const before = events.filter((event) => event.type === "agent_settled" && event.__runtimeId === host.runtimeId).length;
    await manager.command(host.runtimeId, "prompt", { message });
    await vi.waitFor(() => expect(events.filter((event) => event.type === "agent_settled" && event.__runtimeId === host.runtimeId).length, errors.join("\n")).toBeGreaterThan(before), { timeout: 12_000 });
  };
  try {
    const skills = new SkillsManager(path.join(root, "user"));
    await skills.create("---\nname: trusted-only\ndescription: Trust reload fixture\n---\nOnly say done.\n", "project", project);
    await new McpManager().save({ name: "fixture", kind: "stdio", command: process.execPath, args: [path.resolve("scripts/fixtures/mcp-server.mjs")] }, undefined, "project", project);
    const a = await manager.start(options(project));
    const b = await manager.start(options(other));
    const first = manager.findRuntime(a.runtimeId)!, second = manager.findRuntime(b.runtimeId)!;
    const firstPid = pid(first), secondPid = pid(second);
    await prompt(first, "Keep this history across reload.");
    const before = await first.request<{ messages: unknown[] }>("get_messages");
    expect((await first.readCapabilities(true)).skills.map((skill) => skill.name)).not.toContain("trusted-only");
    expect((await first.readCapabilities()).mcpTools).toEqual([]);
    await first.request("prompt", { message: "/permissions full" });
    const state = await first.request<{ model: { provider: string } }>("get_state");
    await first.request("set_model", { provider: state.model.provider, modelId: "alternate" });
    const approval = manager.command(first.runtimeId, "prompt", { message: "/hold-approval" });
    await vi.waitFor(() => expect(first.hasPendingUiRequests).toBe(true));
    trust.set(project, true);
    manager.invalidateCapabilities(project, true);
    expect(first.capabilityStatus().state).toBe("restart-required");
    expect(second.capabilityStatus().revision).toBe(0);
    expect((await manager.reloadCapabilities(first.runtimeId)).state).toBe("scheduled");
    expect(pid(first)).toBe(firstPid);
    children = true;
    const pending = (await first.snapshot()).pendingUiRequests![0];
    await first.respondToUi(pending.id, { confirmed: true });
    await approval;
    await vi.waitFor(() => expect(first.hasPendingWork).toBe(false), { timeout: 3_000 });
    expect(pid(first)).toBe(firstPid);
    expect(first.capabilityStatus().state).toBe("scheduled");
    vi.spyOn(first, "start").mockRejectedValueOnce(new Error("fixture reload failure"));
    children = false;
    manager.flushScheduledCapabilities(first.runtimeId);
    await vi.waitFor(() => expect(first.capabilityStatus()).toMatchObject({ state: "failed", error: "fixture reload failure" }), { timeout: 5_000 });
    expect(await first.request("get_messages")).toEqual(before);
    const applied = await manager.reloadCapabilities(first.runtimeId);
    expect(applied.state).toBe("loaded");
    expect(applied.report?.skills.map((skill) => skill.name)).toContain("trusted-only");
    expect(applied.report?.mcpTools.some((name) => name.includes("echo"))).toBe(true);
    expect(applied.report?.mcpErrors).toEqual([]);
    expect(applied.report?.permission).toBe("full");
    expect((await first.request<{ model: { id: string } }>("get_state")).model.id).toBe("alternate");
    // Pi restores hidden extension messages with their JSONL entry timestamp;
    // user/assistant messages and all message content must be identical.
    const stable = (messages: unknown[]) => messages.map((message) => {
      const value = message as { role: string; timestamp?: number };
      if (value.role !== "custom") return message;
      const { timestamp: _timestamp, ...content } = value;
      return content;
    });
    expect(stable((await first.request<{ messages: unknown[] }>("get_messages")).messages)).toEqual(stable(before.messages));
    expect(pid(first)).not.toBe(firstPid);
    expect(pid(second)).toBe(secondPid);
    expect(manager.active).toBe(b.runtimeId);
    expect(requests).toHaveLength(1);
    await prompt(first, "Use the trusted tool.");
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("trusted MCP works");
    await first.request("prompt", { message: "/permissions ask" });
    await skills.create("---\nname: hot-reload\ndescription: Keep permission across reload\n---\nDone.\n", "project", project);
    manager.invalidateCapabilities(project);
    await vi.waitFor(() => expect(first.capabilityStatus()).toMatchObject({ state: "loaded", report: { permission: "ask" } }), { timeout: 5_000 });
    expect(first.capabilityStatus().report?.skills.map((skill) => skill.name)).toContain("hot-reload");
    expect(pid(second)).toBe(secondPid);

    const c = await manager.start(options(cancelled));
    const third = manager.findRuntime(c.runtimeId)!;
    await prompt(third, "Cancellation fixture.");
    trust.set(cancelled, true);
    manager.invalidateCapabilities(cancelled, true);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const originalStart = third.start.bind(third);
    const start = vi.spyOn(third, "start").mockImplementationOnce(async (...args) => { await blocked; return originalStart(...args); });
    const reload = manager.reloadCapabilities(third.runtimeId);
    const rejected = expect(reload).rejects.toThrow(/closed|active agent session/i);
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    await manager.stop(third.runtimeId);
    release();
    await rejected;
    expect(third.isRunning()).toBe(false);
    expect(manager.findRuntime(third.runtimeId)).toBeUndefined();
    expect(second.isRunning()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await manager.stopAll();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(root, { recursive: true, force: true });
  }
}, 35_000);
