import { describe, expect, it, vi } from "vitest";
import { registerAskUserTool } from "./ask-user";

/**
 * 回归：ask_user 等用户应答期间必须可被中止。
 *
 * pi 的 `session.abort()` 会 `await session.waitForIdle()`，而 waitForIdle 要等当前工具
 * 返回。ask_user 若把对话框的 promise 挂成「只能由 extension_ui_response 解开」，
 * abort 就永远收不到响应 → 界面上的「停止」完全没反应（用户实际踩到的现象）。
 * 因此这里镜像 pi RPC 的 createDialogPromise 语义（signal abort → 以默认值结束对话框），
 * 断言工具确实把工具 signal 传下去并在中止时立刻返回。
 */

interface DialogOptions {
  signal?: AbortSignal;
}

interface FakeContext {
  hasUI: boolean;
  ui: {
    setWorkingVisible(visible: boolean): void;
    select(title: string, options: string[], opts?: DialogOptions): Promise<string | undefined>;
    input(title: string, placeholder?: string, opts?: DialogOptions): Promise<string | undefined>;
  };
}

type AskTool = {
  name: string;
  execute(
    id: string,
    params: { question: string; options?: string[] },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: FakeContext,
  ): Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown>; isError?: boolean }>;
};

function loadTool(): AskTool {
  let registered: AskTool | undefined;
  registerAskUserTool({
    registerTool: (definition: AskTool) => {
      registered = definition;
    },
  } as never);
  if (!registered) throw new Error("ask_user tool was not registered");
  return registered;
}

/** 镜像 pi RPC 对话框：收到 abort 就以 undefined（取消）结束，而不是一直等应答。 */
function dialogPromise(opts?: DialogOptions): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    if (opts?.signal?.aborted) return resolve(undefined);
    opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
  });
}

function makeContext(seen: DialogOptions[] = []): FakeContext {
  return {
    hasUI: true,
    ui: {
      setWorkingVisible: () => undefined,
      select: (_title, _options, opts) => {
        seen.push(opts ?? {});
        return dialogPromise(opts);
      },
      input: (_title, _placeholder, opts) => {
        seen.push(opts ?? {});
        return dialogPromise(opts);
      },
    },
  };
}

describe("ask_user tool", () => {
  it("把工具 signal 传给选项对话框，中止时立刻返回取消结果", async () => {
    const tool = loadTool();
    const controller = new AbortController();
    const seen: DialogOptions[] = [];
    const pending = tool.execute(
      "call-1",
      { question: "选哪个方案？", options: ["A", "B"] },
      controller.signal,
      undefined,
      makeContext(seen),
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toHaveLength(1);
    expect(seen[0].signal).toBe(controller.signal);

    controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ cancelled: true, question: "选哪个方案？" });
  });

  it("自由文本提问同样可被中止", async () => {
    const tool = loadTool();
    const controller = new AbortController();
    const seen: DialogOptions[] = [];
    const pending = tool.execute(
      "call-2",
      { question: "给这次改动起个名字？" },
      controller.signal,
      undefined,
      makeContext(seen),
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(seen[0].signal).toBe(controller.signal);

    controller.abort();
    expect((await pending).details).toMatchObject({ cancelled: true });
  });

  it("signal 已经中止时不再弹窗，直接以取消收尾", async () => {
    const tool = loadTool();
    const controller = new AbortController();
    controller.abort();
    const select = vi.fn(
      (_title: string, _options: string[], opts?: DialogOptions) => dialogPromise(opts),
    );
    const ctx = makeContext();
    ctx.ui.select = select;

    const result = await tool.execute(
      "call-3",
      { question: "选哪个？", options: ["A", "B"] },
      controller.signal,
      undefined,
      ctx,
    );
    expect(select).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });

  it("正常应答路径不受影响", async () => {
    const tool = loadTool();
    const ctx = makeContext();
    ctx.ui.select = async () => "B";

    const result = await tool.execute(
      "call-4",
      { question: "选哪个方案？", options: ["A", "B"] },
      new AbortController().signal,
      undefined,
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ choice: "B" });
  });
});
