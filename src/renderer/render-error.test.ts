import { describe, expect, it } from "vitest";
import { describeRenderError } from "./render-error";

describe("describeRenderError", () => {
  it("keeps the message as the summary and the stack as detail", () => {
    const error = new Error("boom");
    const report = describeRenderError(error);
    expect(report.summary).toBe("Error: boom");
    expect(report.detail).toContain("Error: boom");
    expect(report.detail).toContain("at ");
  });

  it("handles non-Error throws", () => {
    expect(describeRenderError("plain failure").summary).toBe("plain failure");
    expect(describeRenderError({ code: 42 }).summary).toBe('{"code":42}');
  });

  it("truncates very long details", () => {
    const report = describeRenderError(new Error("x".repeat(10_000)));
    expect(report.detail.length).toBe(4_000);
    expect(report.summary.length).toBeLessThanOrEqual(200);
  });

  it("survives circular values", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeRenderError(circular).summary).toContain("object");
  });
});
