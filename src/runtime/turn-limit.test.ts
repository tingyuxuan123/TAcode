import { describe, expect, it } from "vitest";
import { createTurnLimiter, parseTurnLimit } from "./turn-limit";

describe("parseTurnLimit", () => {
  it("只接受正整数，畸形值一律忽略", () => {
    expect(parseTurnLimit("40")).toBe(40);
    expect(parseTurnLimit(" 7 ")).toBe(7);
    expect(parseTurnLimit(undefined)).toBeUndefined();
    expect(parseTurnLimit("")).toBeUndefined();
    expect(parseTurnLimit("0")).toBeUndefined();
    expect(parseTurnLimit("-3")).toBeUndefined();
    expect(parseTurnLimit("2.5")).toBeUndefined();
    expect(parseTurnLimit("abc")).toBeUndefined();
    expect(parseTurnLimit("9".repeat(30))).toBeUndefined();
  });
});

describe("createTurnLimiter", () => {
  it("未配置上限时不注册（返回 undefined）", () => {
    expect(createTurnLimiter(undefined)).toBeUndefined();
  });

  it("到上限的那一轮报 true，之后同一轮运行内不再重复报", () => {
    const limiter = createTurnLimiter(3)!;
    expect(limiter.countTurn()).toBe(false);
    expect(limiter.countTurn()).toBe(false);
    expect(limiter.countTurn()).toBe(true);
    // 收口后同一运行内继续计数也不再报（避免重复 abort）。
    expect(limiter.countTurn()).toBe(false);
  });

  it("每次运行重新计预算（delegate_continue 复用同一 worker）", () => {
    // 曾经的实现是进程级计数：续跑只能拿到 limit - N 轮，且父侧会把它记成 completed。
    const limiter = createTurnLimiter(2)!;
    expect(limiter.countTurn()).toBe(false);
    expect(limiter.countTurn()).toBe(true);
    limiter.startRun();
    expect(limiter.countTurn()).toBe(false);
    expect(limiter.countTurn()).toBe(true);
  });
});
