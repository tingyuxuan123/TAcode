import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRuntimeArgs } from "./options";

const roots: string[] = [];

async function isolatedHome(settings: Record<string, unknown> = {}): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "tacode-options-"));
  roots.push(home);
  await writeFile(join(home, "settings.json"), JSON.stringify(settings));
  vi.stubEnv("TETHER_HOME", home);
  return home;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parseRuntimeArgs", () => {
  it("consumes shell-only flags and forwards the rest to Pi", async () => {
    await isolatedHome();
    const parsed = parseRuntimeArgs([
      "--mode",
      "rpc",
      "--harness",
      "safe",
      "--permission",
      "plan",
      "--sandbox",
      "read-only",
      "--transport",
      "chat",
      "--network",
      "--provider",
      "openai",
      "--model",
      "gpt-5.6-sol",
      "--session",
      "/tmp/s.jsonl",
      "--extension",
      "/tmp/ext.js",
    ]);
    expect(parsed.options.permission).toBe("plan");
    expect(parsed.options.sandbox).toBe("read-only");
    expect(parsed.options.harness).toBe("safe");
    expect(parsed.options.transport).toBe("chat");
    expect(parsed.options.network).toBe(true);
    expect(parsed.options.providerId).toBe("openai");
    expect(parsed.options.modelId).toBe("gpt-5.6-sol");
    expect(parsed.piArgs).toContain("--session");
    expect(parsed.piArgs).toContain("/tmp/ext.js");
    expect(parsed.piArgs).not.toContain("--permission");
    expect(parsed.piArgs).not.toContain("--sandbox");
    expect(parsed.piArgs).not.toContain("--transport");
    expect(parsed.piArgs).not.toContain("--network");
  });

  it("maps --effort to Pi's --thinking and injects rpc mode", async () => {
    await isolatedHome();
    const parsed = parseRuntimeArgs(["--effort", "xhigh"]);
    expect(parsed.piArgs).toContain("--thinking");
    expect(parsed.piArgs[parsed.piArgs.indexOf("--thinking") + 1]).toBe("xhigh");
    expect(parsed.piArgs.slice(0, 2)).toEqual(["--mode", "rpc"]);
  });

  it("applies provider defaults when model and effort are omitted", async () => {
    await isolatedHome();
    const parsed = parseRuntimeArgs(["--provider", "deepseek"]);
    expect(parsed.options.modelId).toBe("deepseek-v4-flash");
    expect(parsed.piArgs).toContain("--model");
    expect(parsed.piArgs).toContain("--thinking");
    expect(parsed.piArgs[parsed.piArgs.indexOf("--thinking") + 1]).toBe("max");
  });

  it("turns --yes into full permission plus --approve", async () => {
    await isolatedHome();
    const parsed = parseRuntimeArgs(["--yes"]);
    expect(parsed.options.permission).toBe("full");
    expect(parsed.piArgs).toContain("--approve");
  });

  it("respects a stored model selection", async () => {
    await isolatedHome({ defaultProvider: "openai", defaultModel: "deepseek-v4-flash-vision-exp" });
    const parsed = parseRuntimeArgs([]);
    expect(parsed.options.providerId).toBe("openai");
    expect(parsed.options.modelId).toBe("deepseek-v4-flash-vision-exp");
  });

  it("rejects unknown permission and sandbox values", async () => {
    await isolatedHome();
    expect(() => parseRuntimeArgs(["--permission", "yolo"])).toThrow(/Unsupported permission/);
    expect(() => parseRuntimeArgs(["--sandbox", "open"])).toThrow(/Unsupported sandbox/);
  });
});
