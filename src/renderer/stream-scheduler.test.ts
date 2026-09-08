import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamScheduler } from "./stream-scheduler";
import { nextStreamText } from "./stream-text";

const update = (value: string) => ({ type: "message_update", value });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("stream scheduling", () => {
  function setup() {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const dispatch = vi.fn();
    const scheduler = createStreamScheduler(dispatch);
    return { scheduler, dispatch, frames, frame: () => { for (const callback of [...frames.values()]) callback(16); } };
  }

  it("delivers all snapshots in order in one batch", () => {
    const { scheduler, dispatch, frame } = setup();
    scheduler.push(update("a")); scheduler.push(update("ab"));
    expect(dispatch).not.toHaveBeenCalled();
    frame();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([update("a"), update("ab")]);
  });

  it.each(["tool_execution_start", "tool_execution_end", "extension_ui_request", "agent_settled", "message_end", "agent_end"])("flushes before %s", (type) => {
    const { scheduler, dispatch } = setup();
    scheduler.push(update("a")); scheduler.push({ type });
    expect(dispatch.mock.calls.map(([events]) => events)).toEqual([[update("a")], [{ type }]]);
  });

  it("flushes a bounded batch before the next animation frame", () => {
    const { scheduler, dispatch, frame } = setup();
    for (let index = 0; index < 256; index += 1) scheduler.push(update(String(index)));
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      Array.from({ length: 256 }, (_, index) => update(String(index))),
    );
    scheduler.push(update("next"));
    expect(dispatch).toHaveBeenCalledTimes(1);
    frame();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]?.[0]).toEqual([update("next")]);
  });

  it("uses the fallback in a background window and cancels the stale frame", () => {
    const { scheduler, dispatch, frames } = setup();
    scheduler.push(update("a"));
    vi.advanceTimersByTime(100);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears old session updates without delivering them to the next session", () => {
    const { scheduler, dispatch, frame } = setup();
    scheduler.push(update("old")); scheduler.clear(); scheduler.push(update("new")); frame();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([update("new")]);
    scheduler.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("stream text", () => {
  it("advances by complete graphemes and eventually catches up", () => {
    const target = "中文 e\u0301 👨‍👩‍👧‍👦 complete";
    let displayed = "";
    for (let elapsed = 0; displayed !== target && elapsed <= 160; elapsed += 16) {
      displayed = nextStreamText(displayed, target, elapsed);
      expect(target.startsWith(displayed)).toBe(true);
      expect(displayed.endsWith("\ud83d")).toBe(false);
      expect(displayed.endsWith("\u200d")).toBe(false);
    }
    expect(displayed).toBe(target);
  });
  it("bounds lag and replaces revised snapshots", () => {
    expect(nextStreamText("short", "short" + "x".repeat(20000), 160)).toBe("short" + "x".repeat(20000));
    expect(nextStreamText("old", "replacement", 10)).toBe("replacement");
    expect(nextStreamText("done", "done", 10)).toBe("done");
  });
});
