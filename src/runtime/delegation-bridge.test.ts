import { describe, expect, it } from "vitest";
import { createRuntimeDelegationClient } from "./delegation-bridge";

/**
 * worker 侧的 requestId 只保证「本进程唯一」，而主进程的请求缓存会跨 worker 重启存活：
 * 没有进程级前缀时，重启后的 `delegation-request-1` 会命中上一代留下的缓存，
 * 父代理据此误判「启动成功」，其实拿到的是上一代那条旧委派。
 *
 * 这里用一个同步的假 IPC 通道捕获真正发出去的消息（测试进程就扮演 worker 进程）。
 */
function captureRequestIds(requestCount = 1): string[] {
  const sent: string[] = [];
  const original = process.send;
  (process as unknown as { send: unknown }).send = (
    message: { requestId?: unknown },
    callback?: (error?: Error | null) => void,
  ): boolean => {
    sent.push(String(message.requestId));
    callback?.(null);
    return true;
  };
  try {
    const client = createRuntimeDelegationClient("/tmp/parent.jsonl");
    expect(client).toBeDefined();
    for (let index = 0; index < requestCount; index += 1) {
      // 没有响应通道，promise 会一直挂着：dispose 时会被 reject，必须自己接住。
      void client!.request("list", {}).catch(() => undefined);
    }
    client!.dispose();
  } finally {
    (process as unknown as { send: unknown }).send = original;
  }
  return sent;
}

describe("runtime delegation bridge", () => {
  it("requestId 带进程级前缀：worker 重启后不会与上一代撞号", () => {
    const first = captureRequestIds(2);
    const second = captureRequestIds(2);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first[0]).toMatch(/^delegation-request-[0-9a-f]{8}-1$/);
    // 同一个 client 内仍然单调递增（pending 表靠 requestId 区分应答）。
    expect(first[1]).toBe(first[0]!.replace(/-1$/, "-2"));
    // 同一个测试进程里创建的两个 client 代表「两次 worker 启动」：前缀必须不同。
    expect(second[0]).not.toBe(first[0]);
    expect(second[1]).toBe(second[0]!.replace(/-1$/, "-2"));
  });

  it("没有 IPC 通道时不创建 client（不干扰纯本地运行）", () => {
    const original = process.send;
    (process as unknown as { send: unknown }).send = undefined;
    try {
      expect(createRuntimeDelegationClient("/tmp/parent.jsonl")).toBeUndefined();
    } finally {
      (process as unknown as { send: unknown }).send = original;
    }
  });
});
