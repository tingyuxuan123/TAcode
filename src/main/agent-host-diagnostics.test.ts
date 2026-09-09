import { describe, expect, it } from "vitest";
import { AgentHost } from "./agent-host";
import { IPC_LIMITS } from "./ipc-validation";
import type { DiagnosticSink } from "./local-logger";

type HostInternals = {
  handleChunk(chunk: Buffer): void;
  secrets: string[];
};

const asInternals = (host: AgentHost): HostInternals =>
  host as unknown as HostInternals;

function createHost() {
  const events: string[] = [];
  const errors: string[] = [];
  const logs: Array<{ level: string; scope: string; message: string }> = [];
  const sink: DiagnosticSink = {
    info: (scope, message) => logs.push({ level: "info", scope, message }),
    warn: (scope, message) => logs.push({ level: "warn", scope, message }),
    error: (scope, message) => logs.push({ level: "error", scope, message }),
  };
  const host = new AgentHost(
    (event) => events.push(event.type),
    (message) => errors.push(message),
    undefined,
    undefined,
    sink,
  );
  return { host, events, errors, logs };
}

describe("AgentHost RPC diagnostics", () => {
  it("reports and logs a malformed JSON line exactly once", () => {
    const { host, errors, logs } = createHost();
    asInternals(host).handleChunk(Buffer.from("not json\n"));
    asInternals(host).handleChunk(Buffer.from("still not json\n"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("无法解析的 JSON");
    expect(logs.filter((entry) => entry.scope === "rpc")).toHaveLength(1);
  });

  it("redacts known secrets from malformed line diagnostics", () => {
    const { host, errors } = createHost();
    const key = "sk-1234567890abcdef";
    asInternals(host).secrets = [key];
    asInternals(host).handleChunk(Buffer.from(`${key} is not json\n`));
    expect(errors[0]).not.toContain(key);
    expect(errors[0]).toContain("[REDACTED]");
  });

  it("drops oversized lines and keeps parsing the rest of the stream", () => {
    const { host, events, errors, logs } = createHost();
    const oversized = Buffer.from(`${"x".repeat(IPC_LIMITS.rpcLineBytes + 1)}\n`, "utf8");
    asInternals(host).handleChunk(oversized);
    asInternals(host).handleChunk(
      Buffer.from(`${JSON.stringify({ type: "agent_start" })}\n`, "utf8"),
    );
    expect(errors[0]).toContain("已丢弃");
    expect(logs.some((entry) => entry.scope === "rpc" && entry.message.includes("已丢弃"))).toBe(true);
    expect(events).toEqual(["agent_start"]);
  });

  it("emits parsed events for well-formed lines", () => {
    const { host, events, errors } = createHost();
    asInternals(host).handleChunk(
      Buffer.from(`${JSON.stringify({ type: "message_update", message: { role: "assistant" } })}\n`),
    );
    expect(errors).toEqual([]);
    expect(events).toEqual(["message_update"]);
  });
});
