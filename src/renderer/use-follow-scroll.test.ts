import { describe, expect, it } from "vitest";
import { nextScrollTop, scrollIntent, shouldReacquireFollow, shouldReleaseFollow } from "./use-follow-scroll";

describe("scroll following", () => {
  it("moves toward the current dynamic bottom without jumping", () => {
    const first = nextScrollTop(100, 1_000, 16, 600);
    const second = nextScrollTop(first, 1_200, 16, 600);

    expect(first).toBeGreaterThan(100);
    expect(first).toBeLessThan(1_000);
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThan(1_200);
  });

  it("uses the latest target when content grows during following", () => {
    const next = nextScrollTop(780, 1_200, 16, 600);

    expect(next).toBeGreaterThan(780);
    expect(next).toBeLessThan(1_200);
  });

  it("snaps immediately when reduced motion is enabled", () => {
    expect(nextScrollTop(100, 1_000, 16, 600, true)).toBe(1_000);
  });

  it("snaps when the remaining distance is negligible", () => {
    expect(nextScrollTop(999.5, 1_000, 16, 600)).toBe(1_000);
  });
});

describe("scroll intent", () => {
  it("reads the wheel direction and ignores non-scrolling gestures", () => {
    expect(scrollIntent({ type: "wheel", deltaY: -30 })).toBe("up");
    expect(scrollIntent({ type: "wheel", deltaY: 30 })).toBe("down");
    // 纯横向（惯性收尾的零位移）不表达纵向意图。
    expect(scrollIntent({ type: "wheel", deltaY: 0 })).toBe("none");
    // Ctrl/⌘ + 滚轮是触控板捏合缩放：内容并不滚动，不能当成「用户往上翻」。
    expect(scrollIntent({ type: "wheel", deltaY: -30, ctrlKey: true })).toBe("none");
    expect(scrollIntent({ type: "wheel", deltaY: -30, metaKey: true })).toBe("none");
  });

  it("maps scroll keys, including shift+space", () => {
    expect(scrollIntent({ type: "keydown", key: "ArrowUp" })).toBe("up");
    expect(scrollIntent({ type: "keydown", key: "PageUp" })).toBe("up");
    expect(scrollIntent({ type: "keydown", key: "Home" })).toBe("up");
    expect(scrollIntent({ type: "keydown", key: "ArrowDown" })).toBe("down");
    expect(scrollIntent({ type: "keydown", key: "PageDown" })).toBe("down");
    expect(scrollIntent({ type: "keydown", key: "End" })).toBe("down");
    expect(scrollIntent({ type: "keydown", key: " " })).toBe("down");
    expect(scrollIntent({ type: "keydown", key: " ", shiftKey: true })).toBe("up");
    expect(scrollIntent({ type: "keydown", key: "a" })).toBe("none");
    expect(scrollIntent({ type: "pointermove" })).toBe("none");
  });
});

describe("shouldReleaseFollow", () => {
  it("hands the viewport to the user as soon as an upward gesture moves it", () => {
    expect(shouldReleaseFollow(3, true)).toBe(true);
    expect(shouldReleaseFollow(400, true)).toBe(true);
  });

  it("keeps following while the position is untouched or the shift is passive", () => {
    // 触底附近的手势残留不该打断跟随（也就不会闪出「回到最新」）。
    expect(shouldReleaseFollow(1, true)).toBe(false);
    // 虚拟列表/浏览器锚定的被动位移没有手势，必须被跟随吸收掉。
    expect(shouldReleaseFollow(400, false)).toBe(false);
  });
});

describe("shouldReacquireFollow", () => {
  const base = { distance: 8, intent: "none" as const, fresh: false, departed: true };

  it("does not pull back a small upward scroll the user asked for", () => {
    // 本次修复的核心断言：往上滚了 8px（触控板一推常常不到 16px）后，
    // 不能因为「距底 16px 内」就瞬时贴底把用户拉回去。
    expect(shouldReacquireFollow({ ...base, intent: "up", fresh: true })).toBe(false);
    expect(shouldReacquireFollow(base)).toBe(false);
  });

  it("resumes following when the user scrolls back down near the bottom", () => {
    expect(shouldReacquireFollow({ ...base, intent: "down", fresh: true })).toBe(true);
    // 手势过期（隔了很久的手势）不能授权重新跟随。
    expect(shouldReacquireFollow({ ...base, intent: "down", fresh: false })).toBe(false);
  });

  it("resumes following on the true bottom, whatever the reason", () => {
    expect(shouldReacquireFollow({ distance: 1, intent: "none", fresh: false, departed: true })).toBe(true);
    expect(shouldReacquireFollow({ distance: 0, intent: "up", fresh: true, departed: true })).toBe(true);
  });

  it("keeps the old hysteresis for non-gesture departures", () => {
    // 跳转 / 换会话 / 程序化位移离开底部：距底够近就恢复跟随（旧行为）。
    expect(shouldReacquireFollow({ distance: 8, intent: "none", fresh: false, departed: false })).toBe(true);
    expect(shouldReacquireFollow({ distance: 40, intent: "none", fresh: false, departed: false })).toBe(false);
    // 无论什么原因，离底部还很远就不该贴回底部。
    expect(shouldReacquireFollow({ distance: 40, intent: "down", fresh: true, departed: true })).toBe(false);
  });
});
