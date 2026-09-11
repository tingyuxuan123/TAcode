import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentHost } from "./agent-host";
import { serviceRuntimeConfig } from "../shared/provider-config";
import type { DiagnosticSink } from "./local-logger";
import type { AgentEvent } from "../shared/types";

/** 故障注入：worker 被杀、请求超时都必须收敛为受控错误 + 本地诊断，而不是主进程崩溃。 */

type LogEntry = { level: string; scope: string; message: string; details?: string };

function harness() {
  const events: AgentEvent[] = [];
  const errors: string[] = [];
  const logs: LogEntry[] = [];
  const record =
    (level: string) =>
    (scope: string, message: string, details?: unknown) =>
      logs.push({
        level,
        scope,
        message,
        ...(details === undefined ? {} : { details: JSON.stringify(details) }),
      });
  const sink: DiagnosticSink = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
  const host = new AgentHost(
    (event) => events.push(event),
    (message) => errors.push(message),
    undefined,
    undefined,
    sink,
  );
  return { host, events, errors, logs };
}

const waitFor = async (predicate: () => boolean, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("condition not reached in time");
};

const roots: string[] = [];

/**
 * 真实 worker 会把数据目录定在 home：不隔离就会直接读写开发机的 `~/.tacode`，
 * 甚至触发旧目录迁移。这里给每个用例一个空 home + 文件凭据存储。
 */
async function isolatedHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "tacode-host-fault-home-"));
  roots.push(home);
  await writeFile(join(home, "settings.json"), JSON.stringify({ credentialStore: "file" }));
  vi.stubEnv("TACODE_HOME", home);
  return home;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentHost fault injection", () => {
  it("surfaces a SIGKILLed worker as a controlled error and logs it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tacode-host-fault-"));
    await isolatedHome();
    const { host, errors, logs } = harness();
    try {
      const config = serviceRuntimeConfig({
        id: "fault",
        name: "Fault fixture",
        vendorKey: "custom",
        apiStyle: "chat_completions",
        baseUrl: "http://127.0.0.1:1/unused",
        models: [{ id: "private-model", contextWindow: 32_000, maxTokens: 1_024 }],
        isEnabled: true,
        createdAt: "",
        updatedAt: "",
      });
      await host.start({
        cwd: dir,
        provider: "openai",
        model: "private-model",
        baseUrl: config.baseUrl,
        permission: "plan",
        sandbox: "read-only",
        providerExtension: resolve("src/extensions/provider.ts"),
        desktopProvider: { config, apiKey: "sk-fault-injection-key" },
      });
      expect(host.isRunning()).toBe(true);
      const pid = (host as unknown as { child?: { pid?: number } }).child?.pid;
      expect(pid).toBeGreaterThan(0);

      process.kill(pid!, "SIGKILL");
      await waitFor(() => errors.length > 0);

      expect(errors[0]).toContain("Agent stopped");
      expect(host.isRunning()).toBe(false);
      expect(logs.some((entry) => entry.level === "error" && entry.scope === "worker")).toBe(true);
      expect(JSON.stringify(errors)).not.toContain("sk-fault-injection-key");
      expect(JSON.stringify(logs)).not.toContain("sk-fault-injection-key");
    } finally {
      await host.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("times out an unanswered request, logs it and redacts stderr", async () => {
    vi.useFakeTimers();
    await isolatedHome();
    const key = "sk-fault-injection-key";
    const { host, errors, logs } = harness();
    const internals = host as unknown as {
      child: unknown;
      secrets: string[];
      stderr: string;
    };
    internals.child = { stdin: { write: () => true, destroyed: false } };
    internals.secrets = [key];
    internals.stderr = `gateway rejected ${key}`;

    const pending = host.request("get_state");
    const rejection = expect(pending).rejects.toThrow("did not respond to get_state");
    await vi.advanceTimersByTimeAsync(45_000);
    await rejection;

    expect(errors).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ level: "error", scope: "rpc", message: "request timed out: get_state" });
    expect(JSON.stringify(logs)).not.toContain(key);
    expect(JSON.stringify(logs)).toContain("[REDACTED]");
  });
});
