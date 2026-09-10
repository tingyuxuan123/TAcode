import { describe, expect, it } from "vitest";
import {
  assertDelegationTransition,
  boundedDelegationText,
  isDelegationBridgeResponse,
  isDelegationTerminal,
  validateDelegationTask,
  validateDelegationTimeout,
} from "./delegation";

describe("delegation protocol", () => {
  it("recognizes terminal states and legal transitions", () => {
    expect(isDelegationTerminal("completed")).toBe(true);
    expect(isDelegationTerminal("running")).toBe(false);
    expect(() => assertDelegationTransition("running", "completed")).not.toThrow();
    expect(() => assertDelegationTransition("completed", "running")).toThrow(/terminal/);
    expect(() => assertDelegationTransition("pending", "completed")).toThrow(/Invalid/);
  });

  it("validates bounded task and timeout input", () => {
    expect(validateDelegationTask("  inspect the repo  ")).toBe("inspect the repo");
    expect(() => validateDelegationTask(" ")).toThrow(/non-empty/);
    expect(() => validateDelegationTask("x".repeat(10_001))).toThrow(/exceeds/);
    expect(validateDelegationTimeout(undefined)).toBe(3_600);
    expect(validateDelegationTimeout(30)).toBe(30);
    expect(() => validateDelegationTimeout(0)).toThrow(/positive/);
    expect(() => validateDelegationTimeout(7_201)).toThrow(/exceeds/);
  });

  it("bounds reports while keeping both ends", () => {
    const value = boundedDelegationText("a".repeat(100), 40);
    expect(value.length).toBeLessThanOrEqual(40);
    expect(value.startsWith("a")).toBe(true);
    expect(value.endsWith("a")).toBe(true);
  });

  it("recognizes only structured bridge responses", () => {
    expect(isDelegationBridgeResponse({
      type: "tacode:delegation:response",
      requestId: "r1",
      ok: true,
      result: {},
    })).toBe(true);
    expect(isDelegationBridgeResponse({ type: "wrong", requestId: "r1", ok: true })).toBe(false);
    expect(isDelegationBridgeResponse({ type: "tacode:delegation:response", ok: true })).toBe(false);
  });
});
