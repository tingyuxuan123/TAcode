import { describe, expect, it } from "vitest";
import { AgentHost } from "./agent-host";
import type { AgentEvent } from "../shared/types";

/**
 * waitForIdle 等待原语：委派完成判定依赖它。
 *
 * 通过注入假 child（isRunning() 为真）并直接驱动事件行（agent_start /
 * agent_settled）来验证等待语义，不真实 spawn worker。
 */

function harness() {
  const events: AgentEvent[] = [];
  const host = new AgentHost((event) => events.push(event), () => undefined);
  // 注入假 child：isRunning() = child 存在且 exitCode === null。
  (host as unknown as { child: unknown }).child = {
    exitCode: null,
    stdin: { write: () => true, destroyed: false },
  };
  const emit = (event: Record<string, unknown>): void => {
    (host as unknown as { handleLine(line: string): void }).handleLine(JSON.stringify(event));
  };
  return { host, events, emit };
}

describe("AgentHost.waitForIdle", () => {
  it("resolves immediately when the worker is idle", async () => {
    const { host } = harness();
    const startedAt = Date.now();
    await host.waitForIdle({ startGraceMs: 30 });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(host.isInTurn()).toBe(false);
  });

  it("waits for an in-flight turn to settle before resolving", async () => {
    const { host, emit } = harness();
    emit({ type: "agent_start" });
    expect(host.isInTurn()).toBe(true);
    let settled = false;
    const waiting = host.waitForIdle({ startGraceMs: 30 }).then(() => {
      settled = true;
    });
    await new Promise((done) => setTimeout(done, 60));
    // 一轮未结束：不能提前放行。
    expect(settled).toBe(false);
    emit({ type: "agent_settled" });
    await waiting;
    expect(settled).toBe(true);
    expect(host.isInTurn()).toBe(false);
  });

  it("covers the accept-to-start race: a late agent_start extends the wait to settled", async () => {
    const { host, emit } = harness();
    // 模拟 prompt“接收即返回”：waitForIdle 先于 agent_start 到达。
    let settled = false;
    const waiting = host.waitForIdle({ startGraceMs: 5_000 }).then(() => {
      settled = true;
    });
    await new Promise((done) => setTimeout(done, 50));
    expect(settled).toBe(false); // 宽限窗口内不放行
    emit({ type: "agent_start" });
    await new Promise((done) => setTimeout(done, 50));
    expect(settled).toBe(false); // 已开始生成：等到结束
    emit({ type: "agent_settled" });
    await waiting;
    expect(settled).toBe(true);
  });

  it("releases waiters when the worker exits mid-turn", async () => {
    const { host, emit } = harness();
    emit({ type: "agent_start" });
    let settled = false;
    const waiting = host.waitForIdle().then(() => {
      settled = true;
    });
    await new Promise((done) => setTimeout(done, 30));
    expect(settled).toBe(false);
    // worker 消亡：等待必须收敛而不是永久挂起。
    (host as unknown as { child: undefined }).child = undefined;
    (host as unknown as { handleExit(error: Error): void }).handleExit(new Error("Agent stopped (code 1)"));
    await waiting;
    expect(settled).toBe(true);
  });
});
