import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHost } from "./agent-host";
import type { AgentEvent } from "../shared/types";

/**
 * 回归：选择「完全访问」不应再弹第二次确认。
 *
 * 选择器里的 full 本身就是显式、带风险说明的动作；此前运行时还会在斜杠命令里
 * `await ctx.ui.confirm(...)`，而斜杠命令在 prompt 的 preflight 阶段执行，
 * 导致该确认与按 runtime 串行化的命令队列互相等待（点「允许」无反应）。
 */
afterEach(() => vi.unstubAllEnvs());

describe("permission mode commands", () => {
  it("switches to full without an extra confirm request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tacode-permissions-"));
    const events: AgentEvent[] = [];
    const errors: string[] = [];
    const host = new AgentHost(
      (event) => events.push(event),
      (error) => errors.push(error),
    );
    try {
      // 隔离凭据与数据目录，避免读写真实 ~/.tether。
      await writeFile(join(dir, "settings.json"), JSON.stringify({ credentialStore: "file" }));
      vi.stubEnv("TETHER_HOME", dir);
      vi.stubEnv("OPENAI_API_KEY", "sk-test-dummy");
      await host.start({ cwd: dir, provider: "openai", permission: "auto", sandbox: "read-only" });
      // 斜杠命令在 preflight 阶段执行：请求返回即代表命令处理器已跑完。
      await host.request("prompt", { message: "/permissions full" });

      const uiRequests = events.filter((event) => event.type === "extension_ui_request");
      expect(uiRequests.filter((event) => event.method === "confirm")).toEqual([]);
      expect(JSON.stringify(uiRequests)).toContain("Permission mode: full");
      expect(JSON.stringify(uiRequests)).toContain("full · host access");
      expect(errors).toEqual([]);
    } finally {
      await host.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
