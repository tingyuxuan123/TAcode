import { describe, expect, it } from "vitest";
import {
  assertDelegationTransition,
  boundedDelegationText,
  describeAssistantEvidence,
  extractAssistantReport,
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

  it("extracts the last assistant text as the final report (completion contract)", () => {
    const messages = [
      { role: "user", content: "work" },
      { role: "assistant", content: [{ type: "text", text: "first draft" }] },
      { role: "user", content: "continue" },
      { role: "assistant", content: [{ type: "text", text: "final report body" }, { type: "toolCall", id: "t1" }] },
    ];
    expect(extractAssistantReport(messages)).toBe("final report body");
    expect(extractAssistantReport([{ role: "assistant", content: "plain string" }])).toBe("plain string");
    expect(extractAssistantReport([{ role: "user", content: "no assistant yet" }])).toBe("");
    expect(extractAssistantReport(undefined)).toBe("");
  });

  it("summarizes judgment evidence: counts, last message, turns and tool calls", () => {
    const evidence = describeAssistantEvidence([
      { role: "user", content: "work" },
      { role: "assistant", content: [{ type: "toolCall", id: "t1" }, { type: "toolCall", id: "t2" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ]);
    expect(evidence).toMatchObject({ count: 3, lastRole: "assistant", turns: 2, toolCalls: 2 });
    expect(evidence.lastType).toBeUndefined();
    expect(describeAssistantEvidence(undefined)).toEqual({ count: 0, turns: 0, toolCalls: 0 });
  });
});
