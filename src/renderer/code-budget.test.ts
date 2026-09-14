import { expect, it } from "vitest";
import { canHighlightCode } from "./code-budget";

it("keeps short code highlighted while bounding total text, line count and individual lines", () => {
  expect(canHighlightCode("const x = 1;\n".repeat(100))).toBe(true);
  expect(canHighlightCode("x\n".repeat(511))).toBe(true);
  expect(canHighlightCode("x\n".repeat(512))).toBe(false);
  expect(canHighlightCode("x".repeat(2002))).toBe(false);
  expect(canHighlightCode(("x".repeat(1000) + "\n").repeat(33))).toBe(false);
});
