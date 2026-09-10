import { describe, expect, it, vi } from "vitest";
import type { AgentSnapshot } from "../shared/types";
import type { DelegationBridgeRequest, DelegationStartPayload } from "../shared/delegation";
import { TacodeStateStore } from "../runtime/state";
import type { AgentHostStartOptions } from "./agent-manager";
import {
  DelegationCoordinator,
  type DelegationHost,
} from "./delegation-coordinator";

vi.mock("../runtime/subagents.js", () => ({
  loadEnabledSubagents: async () => [{
    name: "explorer",
    description: "Explore",
    tools: ["read_file", "list_files", "search_files"],
    prompt: "Inspect and report.",
    source: "builtin",
  }],
}));

class FakeHost implements DelegationHost {
  runtimeId: string;
  sessionKey?: string;
  requestedSessionPath?: string;
  private running = true;
  private messages: unknown[] = [];

  constructor(runtimeId: string, sessionKey?: string) {
    this.runtimeId = runtimeId;
    this.sessionKey = sessionKey;
    this.requestedSessionPath = sessionKey;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(options: AgentHostStartOptions): Promise<AgentSnapshot> {
    this.sessionKey = options.sessionPath;
    this.requestedSessionPath = options.sessionPath;
    return { state: {}, messages: [], models: [], thinkingLevels: [] };
  }

  async request<T>(type: string, data: Record<string, unknown> = {}): Promise<T> {
    if (type === "prompt") {
      this.messages.push({ role: "user", content: data.message });
      this.messages.push({ role: "assistant", content: [{ type: "text", text: "Found src/main/index.ts:1" }] });
      return {} as T;
    }
    if (type === "get_messages") return { messages: this.messages } as T;
    return {} as T;
  }

  async stop(): Promise<void> {
    this.running = false;
  }
}

const startPayload: DelegationStartPayload = {
  role: "explorer",
  task: "Find the entry point",
  title: "Explore entry point",
  cwd: "/tmp/workspace",
  provider: "deepseek",
  model: "deepseek-chat",
  permission: "auto",
  sandbox: "workspace-write",
  network: false,
};

function startRequest(requestId = "request-1"): DelegationBridgeRequest {
  return {
    type: "tacode:delegation:request",
    requestId,
    action: "start",
    parentSessionPath: "/tmp/parent.jsonl",
    payload: startPayload,
  };
}

describe("DelegationCoordinator", () => {
  it("creates one persistent child for an idempotent request and returns its report", async () => {
    const state = new TacodeStateStore(":memory:");
    const parent = new FakeHost("parent-runtime", "/tmp/parent.jsonl");
    const events: unknown[] = [];
    const coordinator = new DelegationCoordinator({
      stateStore: state,
      createHost: (runtimeId) => new FakeHost(runtimeId),
      findParentHost: () => parent,
      buildStartOptions: async (payload, definition, sessionPath) => ({
        provider: "deepseek",
        permission: payload.permission ?? "auto",
        sandbox: "workspace-write",
        network: false,
        cwd: payload.cwd,
        model: payload.model,
        sessionPath,
        activeTools: [...definition.tools],
        delegationDepth: 1,
      }),
      emitEvent: (_parentSessionPath, event) => events.push(event),
    });
    try {
      const first = await coordinator.handleRequest(startRequest(), parent) as { delegationId: string };
      const replay = await coordinator.handleRequest(startRequest(), parent) as { delegationId: string };
      expect(replay.delegationId).toBe(first.delegationId);

      const waited = await coordinator.wait("/tmp/parent.jsonl", {
        delegationIds: [first.delegationId],
        timeoutSeconds: 2,
      });
      expect(waited.status).toBe("completed");
      expect(waited.delegations[0]).toMatchObject({
        status: "completed",
        report: "Found src/main/index.ts:1",
      });
      expect(state.list({ parentSessionPath: "/tmp/parent.jsonl" })[0]).toMatchObject({
        sourceDelegationId: first.delegationId,
        delegationStatus: "completed",
        delegationReport: "Found src/main/index.ts:1",
      });
      expect(events.length).toBeGreaterThan(1);

      const continued = await coordinator.continue("/tmp/parent.jsonl", {
        delegationId: first.delegationId,
        message: "Check the exact line too",
      });
      expect(continued.status).toBe("running");
      const afterContinue = await coordinator.wait("/tmp/parent.jsonl", {
        delegationIds: [first.delegationId],
        timeoutSeconds: 2,
      });
      expect(afterContinue.delegations[0]?.status).toBe("completed");
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });

  it("rejects a request that claims another parent session", async () => {
    const state = new TacodeStateStore(":memory:");
    const requester = new FakeHost("other-runtime", "/tmp/other.jsonl");
    const coordinator = new DelegationCoordinator({
      stateStore: state,
      createHost: (runtimeId) => new FakeHost(runtimeId),
      findParentHost: () => undefined,
      buildStartOptions: async () => {
        throw new Error("should not start");
      },
    });
    try {
      await expect(coordinator.handleRequest(startRequest(), requester)).rejects.toThrow(/parent session|requesting session/);
    } finally {
      await coordinator.stopAll();
      state.close();
    }
  });
});
