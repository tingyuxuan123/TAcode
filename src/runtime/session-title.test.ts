import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { fallbackSessionTitle } from "../shared/session-title";
import { registerSessionTitle, SESSION_TITLE_PROMPT } from "./session-title";

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple: vi.fn() }));
const complete = vi.mocked(completeSimple);
const result = (text: string) => ({ stopReason: "stop", content: [{ type: "text", text }] }) as Awaited<ReturnType<typeof completeSimple>>;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(options: { name?: string; hasUser?: boolean } = {}) {
  let name = options.name;
  let sessionId = "session-a";
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const ctx = {
    model: { id: "configured-model", provider: "configured-service", api: "openai-completions" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: { "x-service": "test" } }) },
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => options.hasUser ? [{ type: "message", message: { role: "user", content: "old" } }] : [],
    },
  } as unknown as ExtensionContext;
  const setName = vi.fn((next: string) => { name = next; handlers.get("session_info_changed")?.({}, ctx); });
  registerSessionTitle({
    on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    getSessionName: () => name,
    setSessionName: setName,
  } as unknown as ExtensionAPI);
  return {
    ctx, setName,
    get name() { return name; },
    start: (prompt = "请制作博丽神社微缩场景") => handlers.get("before_agent_start")!({ prompt }, ctx),
    close: () => handlers.get("session_shutdown")!({}, ctx),
    switchSession: () => { sessionId = "session-b"; handlers.get("session_start")!({}, ctx); },
  };
}

afterEach(() => vi.clearAllMocks());

describe("automatic session title", () => {
  it("不等待命名才放行正常轮次；只发送首条消息、复用凭据且不提供工具", async () => {
    let release!: (value: ReturnType<typeof result>) => void;
    complete.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const h = harness();
    expect(h.start()).toBeUndefined();
    await flush();
    expect(h.setName).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(h.ctx.model, {
      systemPrompt: SESSION_TITLE_PROMPT,
      messages: [{ role: "user", content: "请制作博丽神社微缩场景", timestamp: expect.any(Number) }],
    }, expect.objectContaining({ apiKey: "test-key", headers: { "x-service": "test" }, maxTokens: 128, maxRetries: 0 }));
    release(result("博丽神社微缩场景"));
    await flush();
    expect(h.name).toBe("博丽神社微缩场景");
    h.start("后续任务");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each([{ name: "用户命名" }, { hasUser: true }])("不为已有标题或已有用户消息的会话重新命名：%j", async (options) => {
    const h = harness(options);
    h.start();
    await flush();
    expect(complete).not.toHaveBeenCalled();
    expect(h.setName).not.toHaveBeenCalled();
  });

  it("手动改名取消自动命名，迟到结果不能覆盖", async () => {
    let release!: (value: ReturnType<typeof result>) => void;
    complete.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const h = harness();
    h.start();
    await flush();
    h.setName("我的标题");
    expect(complete.mock.calls[0][2]?.signal?.aborted).toBe(true);
    release(result("自动标题"));
    await flush();
    expect(h.name).toBe("我的标题");
    expect(h.setName).toHaveBeenCalledTimes(1);
  });

  it.each(["close", "switchSession"] as const)("%s 后迟到结果不能写进其他会话", async (action) => {
    let release!: (value: ReturnType<typeof result>) => void;
    complete.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const h = harness();
    h.start();
    await flush();
    h[action]();
    release(result("旧会话的标题"));
    await flush();
    expect(h.setName).not.toHaveBeenCalled();
    expect(complete.mock.calls[0][2]?.signal?.aborted).toBe(true);
  });

  it("请求失败时保存短兜底标题，不重试或影响主任务", async () => {
    complete.mockRejectedValueOnce(new Error("offline"));
    const h = harness();
    const prompt = "请使用 Three.js 制作一个完整的博丽神社微缩三维场景。".repeat(10);
    h.start(prompt);
    await flush();
    expect(h.name).toBe(fallbackSessionTitle(prompt));
    h.start();
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
