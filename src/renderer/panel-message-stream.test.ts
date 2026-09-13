import { afterEach, expect, it, vi } from "vitest";
import { PanelMessageStream } from "./panel-message-stream";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const event = (text: string) => ({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }], timestamp: 10 } });
function setup() {
  vi.useFakeTimers();
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { frame = undefined; });
  return { stream: new PanelMessageStream(), frame: () => frame?.(16) };
}

it("batches visible updates, preserves hidden content without publishing, then reconciles on activation", () => {
  const { stream, frame } = setup();
  const publish = vi.fn();
  stream.subscribe(publish);
  stream.setVisible(true);
  stream.push(event("a")); stream.push(event("ab"));
  expect(publish).not.toHaveBeenCalled();
  frame();
  expect(publish).toHaveBeenCalledOnce();
  expect(stream.getSnapshot().at(-1)?.text).toBe("ab");
  stream.setVisible(false);
  for (let i = 0; i < 600; i++) stream.push(event(`ab ${i}`));
  frame();
  expect(publish).toHaveBeenCalledOnce();
  expect(stream.getSnapshot().at(-1)?.text).toBe("ab");
  stream.push({ type: "agent_settled" });
  stream.setVisible(true);
  expect(stream.getSnapshot().at(-1)).toMatchObject({ text: "ab 599", streaming: false });
  expect(publish).toHaveBeenCalledTimes(2);
  stream.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("flushes before final snapshots and can resubscribe after strict-mode effect cleanup", () => {
  const { stream, frame } = setup();
  stream.setVisible(true);
  stream.push(event("old"));
  stream.replace([]);
  frame();
  expect(stream.getSnapshot()).toEqual([]);
  stream.push(event("cancelled"));
  stream.dispose();
  stream.push(event("new"));
  frame();
  expect(stream.getSnapshot().at(-1)?.text).toBe("new");
  stream.dispose();
});
