import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SUBAGENT_TOOLS, type SubagentDefinition } from "../../shared/subagents";
import {
  DELEGATE_LIST_TOOL_NAME,
  DELEGATE_STOP_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  DELEGATE_WAIT_TOOL_NAME,
  composeSubagentSystemPrompt,
  registerDelegateTools,
  type SubagentAgentLike,
} from "./delegate";

function definition(overrides: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    name: "explorer",
    description: "Explore",
    tools: [...DEFAULT_SUBAGENT_TOOLS],
    prompt: "Read and report.",
    source: "builtin",
    ...overrides,
  };
}

const fakeCtx = {
  cwd: "/tmp/ws",
  model: { id: "test-model", provider: "test" },
  thinkingLevel: "medium",
  hasUI: true,
  ui: { confirm: async () => true },
  modelRegistry: {
    find: (provider: string, modelId: string) =>
      provider === "test" ? { id: modelId, provider } : undefined,
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
  },
} as unknown as ExtensionContext;

class FakeAgent implements SubagentAgentLike {
  private listeners: Array<(event: AgentEvent) => void> = [];
  aborted = false;
  constructor(private readonly script: (agent: FakeAgent) => Promise<void>) {}

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  report(text: string, totalTokens = 10): void {
    this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input: 5, output: 5, totalTokens, cost: { total: 0.01 } },
      },
    } as unknown as AgentEvent);
  }

  async prompt(): Promise<void> {
    await this.script(this);
  }

  async waitForIdle(): Promise<void> {}

  abort(): void {
    this.aborted = true;
  }
}

function harness(options: {
  definitions?: SubagentDefinition[];
  script?: (agent: FakeAgent) => Promise<void>;
  failAgent?: boolean;
}) {
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  const delivered: string[] = [];
  const registry = registerDelegateTools(
    {
      registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
    } as unknown as ExtensionAPI,
    {
      getDefinitions: async () => options.definitions ?? [definition()],
      createTools: () => [
        {
          name: "read_file",
          label: "Read",
          description: "read",
          parameters: {},
          execute: async () => ({ content: [], details: {} }),
        },
      ],
      deliverReport: (text) => delivered.push(text),
      createAgent: () => {
        if (options.failAgent) throw new Error("agent construction failed");
        return new FakeAgent(options.script ?? (async (agent) => agent.report("found it")));
      },
    },
  );
  return { registry, tools, delivered };
}

async function runTool<T>(
  tools: Map<string, ToolDefinition<any, any, any>>,
  name: string,
  params: Record<string, unknown>,
  onUpdate?: (result: { details: unknown }) => void,
): Promise<{ content: Array<{ text?: string }>; details: any; isError?: boolean }> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute("call-1", params, undefined, onUpdate as never, fakeCtx) as never;
}

describe("composeSubagentSystemPrompt", () => {
  it("包含框架、工具清单与定义正文", () => {
    const prompt = composeSubagentSystemPrompt(definition(), "/tmp/ws");
    expect(prompt).toContain('"explorer" subagent');
    expect(prompt).toContain("read_file, list_files, search_files");
    expect(prompt).toContain("Read and report.");
    expect(prompt).toContain("Working directory: /tmp/ws");
    expect(prompt).toContain("never report an edit");
  });

  it("只跑命令的角色不会被允许改文件", () => {
    // test-runner 声明 exec_command：曾经被判为「可写」，提示词直接说 "You may change files"。
    const prompt = composeSubagentSystemPrompt(
      definition({ name: "test-runner", tools: ["read_file", "exec_command", "write_stdin"] }),
      "/tmp/ws",
    );
    expect(prompt).toContain("You may run commands, but you must not change files");
    expect(prompt).not.toContain("You may change files");
  });

  it("真正能改文件的角色才拿到写权限文案", () => {
    const prompt = composeSubagentSystemPrompt(
      definition({ name: "fixer", tools: ["read_file", "edit_file", "apply_patch"] }),
      "/tmp/ws",
    );
    expect(prompt).toContain("You may change files");
  });
});

describe("delegate tool", () => {
  it("阻塞模式返回报告并回流最终状态", async () => {
    const updates: unknown[] = [];
    const { tools } = harness({});
    const result = await runTool(
      tools,
      DELEGATE_TOOL_NAME,
      { tasks: [{ role: "explorer", task: "find the entry point" }] },
      (partial) => updates.push(partial.details),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("found it");
    expect(result.details.tasks).toHaveLength(1);
    expect(result.details.tasks[0].status).toBe("completed");
    expect(result.details.done).toBe(1);
    expect(result.details.results[0]).toMatchObject({ role: "explorer", success: true });
    expect(result.details.results[0].usage.totalTokens).toBe(10);
    expect(updates.length).toBeGreaterThan(0);
  });

  it("把子代理工具进度持续推送给 delegate 的 onUpdate", async () => {
    const updates: Array<Record<string, any>> = [];
    const { tools } = harness({
      script: async (agent) => {
        agent.emit({
          type: "tool_execution_start",
          toolCallId: "read-1",
          toolName: "read_file",
          args: { path: "src/runtime/delegate.ts" },
        } as unknown as AgentEvent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        agent.report("found it");
      },
    });
    await runTool(
      tools,
      DELEGATE_TOOL_NAME,
      { tasks: [{ role: "explorer", task: "find the entry point" }] },
      (partial) => updates.push(partial.details as Record<string, any>),
    );
    expect(updates.some((details) => details.tasks?.[0]?.status === "running" && details.tasks[0].live === "read_file src/runtime/delegate.ts")).toBe(true);
  });

  it("任务明细带 startedAt/toolCalls/turns，活动缓冲记录工具成败与报告", async () => {
    const { tools } = harness({
      script: async (agent) => {
        agent.emit({
          type: "tool_execution_start",
          toolCallId: "read-1",
          toolName: "read_file",
          args: { path: "a.ts" },
        } as unknown as AgentEvent);
        agent.emit({
          type: "tool_execution_end",
          toolCallId: "read-1",
          toolName: "read_file",
          result: {},
          isError: false,
        } as unknown as AgentEvent);
        agent.emit({
          type: "tool_execution_start",
          toolCallId: "read-2",
          toolName: "read_file",
          args: { path: "b.ts" },
        } as unknown as AgentEvent);
        agent.emit({
          type: "tool_execution_end",
          toolCallId: "read-2",
          toolName: "read_file",
          result: {},
          isError: true,
        } as unknown as AgentEvent);
        agent.report("found it");
      },
    });
    const result = await runTool(
      tools,
      DELEGATE_TOOL_NAME,
      { tasks: [{ role: "explorer", task: "find it" }] },
    );
    const task = result.details.tasks[0];
    expect(typeof task.startedAt).toBe("number");
    expect(task.toolCalls).toBe(2);
    expect(task.turns).toBe(1);
    const recent: Array<{ kind: string; text: string; isError?: boolean }> = task.recent;
    expect(recent.filter((entry) => entry.kind === "tool")).toHaveLength(2);
    expect(recent.find((entry) => entry.kind === "tool" && entry.text.includes("b.ts"))?.isError).toBe(true);
    expect(recent.find((entry) => entry.kind === "tool" && entry.text.includes("a.ts"))?.isError).toBeUndefined();
    expect(recent.some((entry) => entry.kind === "report" && entry.text.includes("found it"))).toBe(true);
  });

  it("活动缓冲有上限，不随长任务无限增长", async () => {
    const { tools } = harness({
      script: async (agent) => {
        for (let index = 0; index < 80; index += 1) {
          agent.emit({
            type: "tool_execution_start",
            toolCallId: `t-${index}`,
            toolName: "read_file",
            args: { path: `f${index}.ts` },
          } as unknown as AgentEvent);
        }
        agent.report("done");
      },
    });
    const result = await runTool(
      tools,
      DELEGATE_TOOL_NAME,
      { tasks: [{ role: "explorer", task: "scan" }] },
    );
    expect(result.details.tasks[0].recent.length).toBeLessThanOrEqual(60);
    // 保留的是最近的记录
    expect(JSON.stringify(result.details.tasks[0].recent)).toContain("f79.ts");
  });

  it("runner 初始化失败时也会结算为 failed", async () => {
    const { tools } = harness({ failAgent: true });
    const result = await runTool(
      tools,
      DELEGATE_TOOL_NAME,
      { tasks: [{ role: "explorer", task: "start" }] },
    );
    expect(result.details.tasks[0].status).toBe("failed");
    expect(result.details.results[0].output).toContain("agent construction failed");
  });

  it("后台模式立即返回，结算后自动回灌报告", async () => {
    const { tools, delivered } = harness({});
    const result = await runTool(tools, DELEGATE_TOOL_NAME, {
      tasks: [{ role: "explorer", task: "find it" }],
      background: true,
    });
    expect(result.details.done).toBe(0);
    await vi.waitFor(() => expect(delivered.length).toBe(1));
    expect(delivered[0]).toContain("found it");
  });

  it("delegate_wait 收敛后台委派并返回报告", async () => {
    const { tools } = harness({});
    await runTool(tools, DELEGATE_TOOL_NAME, {
      tasks: [{ role: "explorer", task: "find it" }],
      background: true,
    });
    const waited = await runTool(tools, DELEGATE_WAIT_TOOL_NAME, { timeoutSeconds: 5 });
    expect(waited.details.status).toBe("completed");
    expect(waited.content[0]?.text).toContain("found it");
    expect(waited.details.delegations[0]).toMatchObject({ role: "explorer", status: "completed" });
  });

  it("delegate_list 列出委派状态", async () => {
    const { tools } = harness({});
    await runTool(tools, DELEGATE_TOOL_NAME, {
      tasks: [{ role: "explorer", task: "find it" }],
      background: true,
    });
    const listed = await runTool(tools, DELEGATE_LIST_TOOL_NAME, {});
    expect(listed.details.delegations).toHaveLength(1);
    expect(listed.content[0]?.text).toContain("explorer");
  });

  it("delegate_wait 等待期间推送 waiting 进度", async () => {
    const updates: Array<Record<string, any>> = [];
    const { tools } = harness({
      script: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      },
    });
    await runTool(tools, DELEGATE_TOOL_NAME, {
      tasks: [{ role: "explorer", task: "slow" }],
      background: true,
    });
    const waited = await runTool(
      tools,
      DELEGATE_WAIT_TOOL_NAME,
      { timeoutSeconds: 5 },
      (partial) => updates.push(partial.details as Record<string, any>),
    );
    expect(waited.details.status).toBe("completed");
    expect(updates.some((details) => details.status === "waiting" && details.delegations?.[0]?.status === "running")).toBe(true);
  });

  it("delegate_stop 中止后台委派", async () => {
    const { tools } = harness({
      script: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    });
    await runTool(tools, DELEGATE_TOOL_NAME, {
      tasks: [{ role: "explorer", task: "slow" }],
      background: true,
    });
    const stopped = await runTool(tools, DELEGATE_STOP_TOOL_NAME, {});
    expect(stopped.details.stopped[0].status).toBe("aborted");
  });

  it("超过 maxTurns 时标记 truncated 并保留部分报告", async () => {
    const { tools } = harness({
      definitions: [definition({ maxTurns: 2 })],
      script: async (agent) => {
        agent.report("first");
        agent.report("second");
        agent.report("third");
      },
    });
    const result = await runTool(tools, DELEGATE_TOOL_NAME, {
      tasks: [{ role: "explorer", task: "loop" }],
    });
    expect(result.details.tasks[0].status).toBe("truncated");
    expect(result.details.results[0].success).toBe(true);
    expect(result.content[0]?.text).toContain("truncated");
  });

  it("未知 role 返回错误与目录", async () => {
    const { tools } = harness({});
    const result = await runTool(tools, DELEGATE_TOOL_NAME, {
      tasks: [{ role: "nobody", task: "x" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("explorer");
  });

  it("模型 pin 找不到时报失败而不是静默降级", async () => {
    const { tools } = harness({
      definitions: [definition({ model: { providerId: "missing", modelId: "nope" } })],
    });
    const result = await runTool(tools, DELEGATE_TOOL_NAME, {
      tasks: [{ role: "explorer", task: "x" }],
    });
    expect(result.details.tasks[0].status).toBe("failed");
    expect(result.details.results[0].output).toContain("not found");
  });

  it("没有启用定义时返回提示", async () => {
    const { tools } = harness({ definitions: [] });
    const result = await runTool(tools, DELEGATE_TOOL_NAME, {
      tasks: [{ role: "explorer", task: "x" }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("No subagents");
  });

  it("空报告时自动重试一次，重试有文本就按完成结算", async () => {
    let prompts = 0;
    const { tools } = harness({
      script: async (agent) => {
        prompts += 1;
        if (prompts >= 2) agent.report("recovered report: src/a.ts:1");
      },
    });
    const result = await runTool(tools, DELEGATE_TOOL_NAME, {
      tasks: [{ role: "explorer", task: "look" }],
    });
    expect(prompts).toBe(2);
    expect(result.details.tasks[0].status).toBe("completed");
    expect(result.content[0]?.text).toContain("recovered report: src/a.ts:1");
  });

  it("重试仍无报告时落 failed，并附上末尾活动", async () => {
    let prompts = 0;
    const { tools } = harness({
      script: async () => {
        prompts += 1;
      },
    });
    const result = await runTool(tools, DELEGATE_TOOL_NAME, {
      tasks: [{ role: "explorer", task: "look" }],
    });
    expect(prompts).toBe(2);
    expect(result.details.tasks[0].status).toBe("failed");
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("without writing a report");
    expect(text).toContain("A second report-only instruction was sent");
    expect(text).toContain("lastActivity:");
  });
});
