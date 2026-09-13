import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHost } from "./agent-host";
import { parseTurnLimit } from "../runtime/turn-limit";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(() => { throw new Error("worker spawn captured"); }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("AgentHost turn limit environment", () => {
  it.each([undefined, 2])("worker 使用本次上限 %s，不继承进程中的 60", async (maxTurns) => {
    vi.stubEnv("TACODE_MAX_TURNS", "60");
    const host = new AgentHost(() => {}, () => {});
    await expect(host.start({
      cwd: process.cwd(),
      provider: "deepseek",
      permission: "auto",
      sandbox: "workspace-write",
      delegationDepth: 1,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    })).rejects.toThrow("worker spawn captured");
    const env = vi.mocked(spawn).mock.calls[0]?.[2]?.env;
    expect(parseTurnLimit(env?.TACODE_MAX_TURNS)).toBe(maxTurns);
  });
});
