import { describe, expect, it } from "vitest";
import { createStreamTextAnimator, nextStreamText, type StreamTextValue } from "./stream-text";

type Frame = (timestamp: number) => void;

function setup(initial: StreamTextValue = { identity: "turn-1", text: "" }) {
  const frames = new Map<number, Frame>();
  const cancelled: number[] = [];
  const changes: StreamTextValue[] = [];
  let nextFrame = 0;
  const animator = createStreamTextAnimator({
    initial,
    onChange: (value) => changes.push(value),
    requestFrame: (callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      cancelled.push(id);
      frames.delete(id);
    },
    now: () => 0,
  });
  return {
    animator,
    frames,
    changes,
    cancelled,
    run(timestamp: number) {
      const pending = [...frames.entries()];
      for (const [id, callback] of pending) {
        frames.delete(id);
        callback(timestamp);
      }
    },
  };
}

describe("stream text animator", () => {
  it("keeps one RAF while snapshots update the target", () => {
    const { animator, frames, changes, run } = setup();
    animator.setTarget({ identity: "turn-1", text: "abcdefghijkl" }, true);
    animator.setTarget({ identity: "turn-1", text: "abcdefghijklmnop" }, true);

    expect(frames.size).toBe(1);
    run(16);

    expect(frames.size).toBe(1);
    expect(changes.at(-1)?.text).toBe("abcdef");
  });

  it("syncs a revised snapshot instead of animating from discarded text", () => {
    const { animator, frames, changes } = setup({ identity: "turn-1", text: "old" });
    animator.setTarget({ identity: "turn-1", text: "replacement" }, true);

    expect(frames.size).toBe(0);
    expect(changes).toEqual([{ identity: "turn-1", text: "replacement" }]);
  });

  it("cancels the loop when disposed", () => {
    const { animator, frames, cancelled } = setup();
    animator.setTarget({ identity: "turn-1", text: "abcdef" }, true);
    animator.dispose();

    expect(frames.size).toBe(0);
    expect(cancelled).toEqual([1]);
  });

  it("syncs immediately for reduced motion and resumes only for pending text", () => {
    const { animator, frames, changes, run } = setup();
    animator.setTarget({ identity: "turn-1", text: "abcdef" }, true);
    animator.setReducedMotion(true);
    expect(frames.size).toBe(0);
    expect(changes.at(-1)?.text).toBe("abcdef");

    animator.setReducedMotion(false);
    expect(frames.size).toBe(0);
    run(16);
    expect(changes.at(-1)?.text).toBe("abcdef");
  });
});

describe("nextStreamText", () => {
  it("advances by complete graphemes", () => {
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
});
